import { spawn } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { readJSON } from "./common";
import { executableName } from "./platform";
import type { Chat, Source } from "../src/types";
export function termSanityConnection() {
  return readJSON(
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
}
export async function termSanityCall(method: string, params: unknown) {
  const c = termSanityConnection();
  if (!c?.port) throw new Error("Open TermSanity first");
  const res = await fetch(`http://127.0.0.1:${c.port}/rpc`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + c.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
    signal: AbortSignal.timeout(4000),
  });
  const body = (await res.json()) as any;
  if (!res.ok)
    throw new Error(body.error || "TermSanity could not locate this chat");
  return body.result;
}
export async function focusPlan(chat: Chat, source: Source) {
  if (!source.imported && ["codex", "claude"].includes(chat.provider)) {
    try {
      const result = await termSanityCall("ui.focus", {
        nativeId: chat.nativeId,
        provider: chat.provider,
      });
      if (result.found) return { ...result, precision: "tab" };
    } catch {}
  }
  if (process.platform !== "win32" && process.platform !== "linux")
    throw new Error(
      "External window activation is not available on this desktop yet. TermSanity can select its exact tab when its desktop integration is available.",
    );
  if (chat.provider !== "codex" || source.imported)
    throw new Error(
      "The provider does not expose the process owning this chat",
    );
  const path = join(
    source.root,
    "thread-writer-locks",
    chat.nativeId + ".lock",
  );
  if (!existsSync(path)) throw new Error("This chat has no live process lock");
  const exe =
    process.env.CHATPORT_PROBE_EXE ||
    join(__dirname, executableName("chatport-probe"));
  const result = await new Promise<any>((resolve, reject) => {
    const child = spawn(exe, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Window lookup timed out"));
    }, 4000);
    child.stdout.on("data", (b) => {
      text += b;
      if (text.length > 100000) {
        child.kill();
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error("Window lookup was unavailable"));
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ op: "windows", path }));
  });
  const windows = result.windows || [];
  if (windows.length === 1) return { ...windows[0], precision: "window" };
  if (windows.length > 1)
    throw new Error(
      "This process belongs to several windows; its exact window could not be identified",
    );
  throw new Error(
    process.platform === "linux"
      ? "The chat is running, but no focusable X11 window exposed by its process was found. Install xdotool and use an X11 desktop; Wayland prevents external window activation."
      : "The chat is running, but its host does not expose a focusable window. TermSanity supports exact pane and tab focus.",
  );
}
