import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readJSON } from "./common";
import {
  findExecutable,
  terminalPlan,
  appDataPath,
  pathEntries,
} from "./platform";
import { nativeFolder } from "../src/paths";
import { termSanityCall } from "./focus";
import type { Chat, Source } from "../src/types";
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
export function codexBinary() {
  const available = findExecutable("codex");
  if (available) return available;
  if (process.platform !== "win32")
    throw new Error(
      "Codex CLI is not installed or is missing from the desktop PATH",
    );
  for (const dir of (process.env.PATH || "").split(";"))
    if (existsSync(join(dir, "codex.exe"))) return join(dir, "codex.exe");
  const p = join(
    process.env.APPDATA || "",
    "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-" +
      process.arch +
      "/vendor/" +
      (process.arch === "arm64" ? "aarch64" : "x86_64") +
      "-pc-windows-msvc/bin/codex.exe",
  );
  if (existsSync(p)) return p;
  throw new Error("Codex CLI is not installed on this machine");
}
export function resumePlan(chat: Chat, source: Source) {
  const cwd = chat.resumeCwd || chat.cwd;
  if (!nativeFolder(cwd, process.platform))
    throw new Error(
      "This conversation uses a folder from another operating system. Edit its resume folder or add a folder mapping.",
    );
  if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory())
    throw new Error("Choose an existing working folder before resuming");
  let exe: string,
    args: string[],
    env: Record<string, string> = {};
  if (chat.provider === "codex") {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(chat.nativeId))
      throw new Error("This conversation has an invalid Codex session ID");
    exe = codexBinary();
    args = ["--no-daemon", "resume", chat.nativeId, "-C", cwd];
    env.CODEX_HOME = source.imported ? source.nativeRoot || "" : source.root;
    if (!env.CODEX_HOME)
      throw new Error(
        "Restore the native Codex profile from this archive before resuming it",
      );
  } else if (chat.provider === "claude") {
    exe =
      findExecutable("claude", process.platform, [
        join(
          homedir(),
          ".local/bin",
          process.platform === "win32" ? "claude.exe" : "claude",
        ),
      ]) || "";
    if (!existsSync(exe)) throw new Error("Claude Code is not installed");
    args = ["--resume", chat.locator];
    if (!source.imported) env.CLAUDE_CONFIG_DIR = source.root;
    else
      throw new Error(
        "Imported Claude conversations can be read here; native resume requires restoring their provider project files.",
      );
  } else if (chat.provider === "opencode") {
    exe =
      findExecutable("opencode") ||
      pathEntries()
        .map((p) =>
          join(
            p,
            process.platform === "win32" ? "opencode.exe" : "opencode",
          ),
        )
        .find(existsSync) ||
      (process.platform === "win32"
        ? join(
            process.env.APPDATA || "",
            "npm/node_modules/opencode-ai/bin/opencode.exe",
          )
        : "");
    if (!existsSync(exe)) throw new Error("OpenCode is not installed");
    if (source.imported)
      throw new Error(
        "Read the imported conversation here, or restore its native OpenCode profile first",
      );
    args = ["--session", chat.nativeId];
  } else
    throw new Error(
      "This source is available for reading and transfer; resume it in its own app",
    );
  const terminal = terminalPlan(exe, args, cwd, env);
  const script =
    Object.entries(env)
      .map(([k, v]) => `$env:${k}=${quote(v)};`)
      .join("") +
    `Set-Location -LiteralPath ${quote(cwd)}; & ${quote(exe)} @(${args.map(quote).join(",")})`;
  return {
    cwd,
    executable: exe,
    args,
    env,
    terminal,
    script,
    display:
      process.platform !== "win32"
        ? terminal.display
        : Object.entries(env)
            .map(([key, value]) => `$env:${key}=${quote(value)}; `)
            .join("") +
          `Set-Location -LiteralPath ${quote(cwd)}; & ${quote(exe)} ${args.map(quote).join(" ")}`,
  };
}
export async function resumeInTerminal(chat: Chat, source: Source) {
  const p = resumePlan(chat, source);
  const child = spawn(p.terminal.command, p.terminal.args, {
    cwd: p.cwd,
    detached: true,
    windowsHide: false,
    stdio: "ignore",
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  return { pid: child.pid };
}
export async function resumeInTermSanity(chat: Chat, source: Source) {
  let existing: any;
  try {
    existing = await termSanityCall("ui.focus", {
      nativeId: chat.nativeId,
      provider: chat.provider,
      includeStopped: true,
    });
  } catch {}
  if (existing?.found) {
    if (existing.sessionState !== "running" && existing.adapter === "cli")
      await termSanityCall("session.launchAgent", { id: existing.sessionId });
    return { ...existing, precision: "tab" };
  }
  const plan = resumePlan(chat, source);
  if (process.platform !== "win32")
    throw new Error(
      "TermSanity agent launch is currently supported on Windows. Use Resume in terminal on this computer.",
    );
  const expectedHome =
    chat.provider === "codex"
      ? process.env.CODEX_HOME || join(homedir(), ".codex")
      : process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  if (
    resolve(source.root).toLowerCase() !== resolve(expectedHome).toLowerCase()
  )
    throw new Error(
      "Resume this custom provider profile in a terminal so its data directory is retained.",
    );
  if (source.imported)
    throw new Error(
      "Use Resume in terminal for a restored portable profile; it needs its own provider home",
    );
  if (!["codex", "claude"].includes(chat.provider))
    throw new Error("TermSanity supports Codex and Claude CLI sessions");
  const c = readJSON(
    process.env.TERMSANITY_SERVICE ||
      join(
        process.platform === "win32"
          ? join(process.env.LOCALAPPDATA || "", "TermSanity")
          : join(
              process.env.XDG_DATA_HOME || join(homedir(), ".local/share"),
              "termsanity",
            ),
        "service.json",
      ),
  );
  if (!c?.port) throw new Error("Open TermSanity first");
  async function call(method: string, params: any = {}) {
    const r = await fetch(`http://127.0.0.1:${c.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + c.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal: AbortSignal.timeout(20000),
    });
    const b = (await r.json()) as any;
    if (!r.ok)
      throw new Error(b.error || "TermSanity could not open this conversation");
    return b.result;
  }
  const snap = await call("snapshot");
  let project = snap.projects.find(
    (p: any) => p.root.toLowerCase() === plan.cwd.toLowerCase(),
  );
  if (!project)
    project = await call("project.create", {
      name:
        plan.cwd.split(/[/\\]/).filter(Boolean).at(-1) ||
        "Imported conversation",
      root: plan.cwd,
    });
  const s = await call("session.create", {
    projectId: project.id,
    title: chat.title.slice(0, 110),
    provider: chat.provider,
    adapter: "cli",
    cliAutomation: false,
    executable: "powershell.exe",
    args: [],
    cliArgs: plan.args,
    cwd: plan.cwd,
  });
  const layout = JSON.parse(JSON.stringify(project.layout));
  function insert(node: any): boolean {
    if (node.type === "group") {
      const id = crypto.randomUUID();
      node.tabs.push({ id, kind: "agent", title: s.title, subjectId: s.id });
      node.active = id;
      return true;
    }
    return insert(node.children[0]);
  }
  insert(layout);
  await call("layout.save", {
    projectId: project.id,
    revision: project.revision,
    layout,
  });
  await call("session.launchAgent", { id: s.id });
  try {
    const focused = await termSanityCall("ui.focus", {
      nativeId: chat.nativeId,
      provider: chat.provider,
    });
    if (focused.found) return { ...focused, precision: "tab" };
  } catch {}
  return { projectId: project.id, sessionId: s.id };
}
