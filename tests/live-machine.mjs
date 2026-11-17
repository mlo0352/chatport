// Read-only inspection of live provider stores. All copies and resume probes use an isolated test profile.
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { api } from "./helpers.mjs";
const root = resolve(".test-data", "live-" + randomUUID()),
  data = join(root, "library");
await mkdir(data, { recursive: true });
const service = spawn(
  process.execPath,
  ["chatport-runtime/service.cjs", "--data", data],
  { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] },
);
let creds;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 600000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await delay(150);
  }
  throw last || new Error("Live verification timed out");
}
async function rpc(method, params = {}) {
  creds ??= JSON.parse(await readFile(join(data, "service.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${creds.port}/rpc`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + creds.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error);
  return b.result;
}
let agent;
try {
  const first = performance.now();
  const library = await until(async () => {
    const l = await rpc("library");
    return !l.scanning && l.chats.length && l;
  });
  const report = {
    conversations: library.chats.length,
    sources: library.sources.map((s) => ({
      provider: s.provider,
      count: s.count,
      available: s.available,
      error: s.error,
    })),
    scanMs: Math.round(performance.now() - first),
  };
  console.log("Discovery:", JSON.stringify(report));
  const times = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    await rpc("library");
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  report.libraryP95Ms = Math.round(times[18]);
  const started = performance.now(),
    job = await rpc("export", { destination: join(root, "portable-drive") });
  const done = await until(async () => {
    const j = (await rpc("library")).jobs.find((j) => j.id === job.id);
    if (j?.state === "failed") throw new Error(j.error);
    return j?.state === "completed" && j;
  });
  report.exportMs = Math.round(performance.now() - started);
  report.archiveBytes = done.result.bytes;
  report.archiveSHA256 = done.result.sha256;
  console.log(
    "Export:",
    JSON.stringify({
      conversations: done.result.chatCount,
      seconds: report.exportMs / 1000,
      MB: Math.round(done.result.bytes / 1048576),
    }),
  );
  const importedJob = await rpc("import", { file: done.path });
  const imported = await until(async () => {
    const j = (await rpc("library")).jobs.find((j) => j.id === importedJob.id);
    if (j?.state === "failed") throw new Error(j.error);
    return j?.state === "completed" && j;
  });
  assert.equal(imported.result.chatCount, library.chats.length);
  const after = await until(async () => {
    const l = await rpc("library");
    return (
      !l.scanning &&
      l.chats.filter((c) => c.imported).length === library.chats.length &&
      l
    );
  });
  const codex = after.sources.find((s) => s.imported && s.provider === "codex");
  assert.ok(codex);
  const restoreJob = await rpc("restore", {
    sourceId: codex.id,
    target: join(root, "restored-codex"),
  });
  const restored = await until(async () => {
    const j = (await rpc("library")).jobs.find((j) => j.id === restoreJob.id);
    if (j?.state === "failed") throw new Error(j.error);
    return j?.state === "completed" && j;
  });
  const chosen = after.chats
    .filter((c) => c.sourceId === codex.id)
    .sort((a, b) => a.updatedAt - b.updatedAt)[0];
  const folder = join(root, "New working folder");
  await mkdir(folder);
  await rpc("preference", { id: chosen.id, cwd: folder });
  const plan = await rpc("resume.plan", { id: chosen.id });
  assert.ok(plan.includes(folder));
  assert.ok(plan.includes(restored.path));
  agent = spawn(api.codexBinary(), ["--no-daemon", "app-server"], {
    env: { ...process.env, CODEX_HOME: restored.path },
    cwd: folder,
    windowsHide: true,
    stdio: "pipe",
  });
  let next = 0;
  const pending = new Map();
  let stderr = "";
  agent.stderr.on("data", (d) => (stderr = (stderr + d).slice(-3000)));
  const lines = createInterface({ input: agent.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      const p = pending.get(m.id);
      if (p) {
        pending.delete(m.id);
        clearTimeout(p.timer);
        m.error
          ? p.reject(new Error(JSON.stringify(m.error)))
          : p.resolve(m.result);
      } else if (m.method && m.id !== undefined)
        agent.stdin.write(
          JSON.stringify({ id: m.id, result: { decision: "decline" } }) + "\n",
        );
    } catch {}
  });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++next,
        timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error("Codex request timed out: " + method + " " + stderr),
          );
        }, 30000);
      pending.set(id, { resolve, reject, timer });
      agent.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  await request("initialize", {
    clientInfo: { name: "chatport_test", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  agent.stdin.write(
    JSON.stringify({ method: "initialized", params: {} }) + "\n",
  );
  const resumed = await request("thread/resume", {
    threadId: chosen.nativeId,
    cwd: folder,
    approvalPolicy: "on-request",
    sandbox: "read-only",
  });
  assert.equal(
    resolve(resumed.thread.cwd).toLowerCase(),
    resolve(folder).toLowerCase(),
  );
  report.nativeResumeSameId = resumed.thread.id === chosen.nativeId;
  report.nativeResumeFolderVerified = true;
  agent.kill();
  report.importCount = imported.result.chatCount;
  await writeFile(
    join(root, "verification.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    "PASS: full-machine export/import, empty-profile restore, and actual Codex resume with a new working folder. No model turn was sent.",
  );
  console.log("Evidence: " + join(root, "verification.json"));
} finally {
  agent?.kill();
  await rpc("shutdown").catch(() => {});
  service.kill();
}
