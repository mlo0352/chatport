import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  writeFile,
  readFile,
  unlink,
  utimes,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { api, fixture } from "./helpers.mjs";
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j7RwAAAAASUVORK5CYII=",
    "base64",
  ),
  progress = () => {};
test("turn states distinguish verified ownership, unfinished turns, failures and interruptions", () => {
  assert.equal(api.classifyTurn("inProgress", true, "v").state, "working");
  assert.equal(api.classifyTurn("inProgress", false, "v").state, "unfinished");
  assert.equal(api.classifyTurn("inProgress", null, "v").state, "unknown");
  assert.equal(api.classifyTurn("completed", true, "v").active, true);
  assert.equal(api.classifyTurn("completed", false, "v").state, "idle");
  assert.equal(api.classifyTurn("failed", false, "v").state, "failed");
  assert.equal(api.classifyTurn("interrupted", true, "v").state, "interrupted");
});
test("Windows namespace paths display as drive paths and preserve UNC roots", () => {
  assert.equal(api.displayPath("\\\\?\\C:\\Users\\example"), "C:\\Users\\example");
  assert.equal(
    api.displayPath("\\\\?\\UNC\\server\\share"),
    "\\\\server\\share",
  );
  assert.equal(api.displayPath("\\\\server\\share"), "\\\\server\\share");
});
test("activity indicators expire to unknown when monitoring stops", () => {
  const active = api.classifyTurn("inProgress", true, "v");
  assert.equal(api.currentActivity(active, 1000, 5000).active, true);
  const expired = api.currentActivity(active, 1000, 12000);
  assert.equal(expired.active, null);
  assert.equal(expired.state, "unknown");
  assert.equal(
    api.currentActivity({ ...active, snapshot: true }, 1000, 12000).snapshot,
    true,
  );
});
test("restored Codex sources follow the live profile and export changes made after restore", async () => {
  const f = await fixture(),
    s = api.source("codex", f.codex),
    chat = api.listChats(s).find((c) => c.nativeId === f.ids[0]);
  const exported = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "export"),
      chats: [chat],
      sources: [s],
      machine: "test",
    },
    progress,
  );
  const imported = await api.importBundle(
      { dataDir: f.data, jobId: randomUUID(), file: exported.path },
      progress,
    ),
    p = imported.sources[0],
    profile = join(f.root, "restored");
  await api.restoreCodex(
    { dataDir: f.data, source: p, target: profile, jobId: randomUUID() },
    progress,
  );
  const live = api.liveSource({
    ...p,
    nativeRoot: profile,
    imagesIncluded: false,
  });
  assert.equal(live.format, "native");
  assert.equal(live.root, profile);
  assert.equal(live.imported, false);
  assert.equal(live.imagesIncluded, undefined);
  const db = new DatabaseSync(join(profile, "thread_history_1.sqlite"));
  db.prepare(
    "UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE thread_id=? AND item_id=?",
  ).run(
    JSON.stringify({
      type: "agentMessage",
      text: "Response added after restore",
    }),
    400,
    chat.nativeId,
    "item-305",
  );
  db.close();
  const chats = api.listChats(live);
  assert.ok(
    (await api.allMessages(live, chats[0])).some(
      (m) => m.text === "Response added after restore",
    ),
  );
  assert.equal(chats[0].id, api.listChats(p)[0].id);
  const next = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "next"),
      chats,
      sources: [live],
      machine: "restored",
    },
    progress,
  );
  const checked = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: next.path },
    progress,
  );
  assert.ok(
    (
      await api.allMessages(
        checked.sources[0],
        api.listChats(checked.sources[0])[0],
      )
    ).some((m) => m.text === "Response added after restore"),
  );
});
test("screenshots are registered, cached, recovered from exact matching prompts, and transferred with optional files", async () => {
  const f = await fixture(),
    image = join(f.root, "Screenshot.png");
  await writeFile(image, png);
  const s = api.source("codex", f.codex),
    c = api.listChats(s).find((c) => c.nativeId === f.ids[0]);
  const h = new DatabaseSync(join(f.codex, "thread_history_1.sqlite"));
  const content = [
    { type: "text", text: "Screenshot recovery question" },
    { type: "localImage", path: image },
  ];
  h.prepare(
    "UPDATE thread_items SET item_json=? WHERE thread_id=? AND item_id=?",
  ).run(
    JSON.stringify({ type: "userMessage", content }),
    c.nativeId,
    "item-306",
  );
  h.close();
  await writeFile(
    c.locator,
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Screenshot recovery question" },
          {
            type: "input_image",
            image_url: "data:image/png;base64," + png.toString("base64"),
          },
        ],
      },
    }) + "\n",
  );
  const page = await api.messages(s, c),
    m = page.messages.at(-1);
  assert.equal(m.attachments.length, 1);
  assert.equal(m.attachments[0].name, "Screenshot.png");
  const db = api.openLibrary(f.data);
  const publicMessages = api.registerImages(db, c, s, page.messages);
  assert.equal(publicMessages.at(-1).attachments[0].ref, undefined);
  db.close();
  const cached = await api.loadImage(f.data, c.id, m.attachments[0].id);
  assert.deepEqual(await readFile(cached.path), png);
  await unlink(image);
  const recovered = await api.materializeImage(f.data, {
    ...m.attachments[0],
    id: "recover-test",
  });
  assert.deepEqual(await readFile(recovered.path), png);
  await writeFile(recovered.path, Buffer.from("truncated cache"));
  const repaired = await api.materializeImage(f.data, {
    ...m.attachments[0],
    cachedPath: recovered.path,
  });
  assert.deepEqual(await readFile(repaired.path), png);
  const parallel = await Promise.all(
    Array.from({ length: 8 }, () =>
      api.materializeImage(f.data, { ...m.attachments[0] }),
    ),
  );
  for (const asset of parallel)
    assert.deepEqual(await readFile(asset.path), png);
  const e = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "USB"),
      chats: [c],
      sources: [s],
      machine: "test",
      includeImages: true,
    },
    progress,
  );
  const p = await api.importBundle(
      { dataDir: f.data, jobId: randomUUID(), file: e.path },
      progress,
    ),
    imported = api.listChats(p.sources[0])[0],
    body = await api.allMessages(p.sources[0], imported);
  const attachment = body.at(-1).attachments[0];
  assert.equal(attachment.available, true);
  assert.ok(attachment.archivePath.startsWith("attachments/"));
  assert.deepEqual(await readFile(join(p.path, attachment.archivePath)), png);
  const noImages = await api.importBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      file: e.path,
      includeImages: false,
    },
    progress,
  );
  const excluded = (
    await api.allMessages(
      noImages.sources[0],
      api.listChats(noImages.sources[0])[0],
    )
  ).at(-1).attachments[0];
  assert.equal(excluded.available, false);
  assert.equal(excluded.archivePath, undefined);
  const small = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "without-images"),
      chats: [c],
      sources: [s],
      machine: "test",
      includeImages: false,
    },
    progress,
  );
  const smallP = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: small.path },
    progress,
  );
  assert.equal(
    (
      await api.allMessages(
        smallP.sources[0],
        api.listChats(smallP.sources[0])[0],
      )
    ).at(-1).attachments[0].available,
    false,
  );
  await assert.rejects(
    () =>
      api.materializeImage(f.data, {
        id: "bad",
        name: "bad.png",
        mime: "image/png",
        ref: {
          dataUrl:
            "data:image/png;base64," +
            Buffer.from("<html>not an image</html>").toString("base64"),
        },
      }),
    /not a supported image/,
  );
});
test("Freebuff maps a chat's log PID to the live CLI heartbeat", async () => {
  const f = await fixture(),
    root = join(f.home, ".config/manicode"),
    folder = join(
      root,
      "projects",
      "project",
      "chats",
      "2026-11-16T13-00-00.000Z",
    );
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(folder, "chat-meta.json"),
    JSON.stringify({ messageCount: 2, firstPrompt: "Live Freebuff chat" }),
  );
  await writeFile(
    join(folder, "run-state.json"),
    JSON.stringify({ output: { type: "lastMessage" } }),
  );
  await writeFile(
    join(folder, "chat-messages.json"),
    JSON.stringify([
      { id: "u", variant: "user", content: "Freebuff question" },
      { id: "a", variant: "ai", content: "", blocks: [] },
    ]),
  );
  await writeFile(
    join(folder, "log.jsonl"),
    JSON.stringify({ level: "INFO", pid: process.pid, msg: "run started" }) +
      "\n",
  );
  const beat = join(root, "freebuff-live-" + process.pid + ".json");
  await writeFile(
    beat,
    JSON.stringify({
      instanceId: "cli:test",
      ownerPid: process.pid,
      expiresAt: Date.now() + 60 * 60_000,
    }),
  );
  const s = api.source("freebuff", root),
    chat = api.listChats(s)[0];
  const live = await api.activities([s], [chat]);
  assert.equal(live[chat.id].active, true);
  assert.equal(live[chat.id].state, "working");
  const old = new Date(Date.now() - 10 * 60_000);
  await utimes(beat, old, old);
  const stale = await api.activities([s], [chat]);
  assert.equal(stale[chat.id].active, false);
  assert.equal(stale[chat.id].state, "unfinished");
});
test("Freebuff uses the logged loaded-chat ID instead of marking every chat for the PID live", async () => {
  const f = await fixture(),
    root = join(f.home, ".config/manicode"),
    chatsRoot = join(root, "projects", "project", "chats"),
    active = join(chatsRoot, "2026-11-17T10-00-00.000Z"),
    older = join(chatsRoot, "2026-11-17T09-00-00.000Z");
  async function make(folder, title) {
    await mkdir(folder, { recursive: true });
    await writeFile(
      join(folder, "chat-meta.json"),
      JSON.stringify({ messageCount: 2, firstPrompt: title }),
    );
    await writeFile(
      join(folder, "run-state.json"),
      JSON.stringify({ output: { type: "lastMessage" } }),
    );
    await writeFile(
      join(folder, "chat-messages.json"),
      JSON.stringify([
        { id: "u", variant: "user", content: title },
        { id: "a", variant: "ai", content: "", blocks: [] },
      ]),
    );
  }
  await make(active, "Loaded Freebuff chat");
  await make(older, "Older Freebuff chat");
  const log = (folder, extra = {}) =>
    writeFile(
      join(folder, "log.jsonl"),
      JSON.stringify({
        level: "INFO",
        timestamp: new Date().toISOString(),
        pid: process.pid,
        msg: "run started",
        ...extra,
      }) + "\n",
    );
  await log(active, { pid: 999999 });
  await log(older, {
    data: {
      chatId: "2026-11-17T10-00-00.000Z",
      runStatePath: join(active, "run-state.json"),
    },
    msg: "Loaded chat state from chat directory",
  });
  await writeFile(
    join(root, "freebuff-live-" + process.pid + ".json"),
    JSON.stringify({
      ownerPid: process.pid,
      expiresAt: Date.now() + 60 * 60_000,
    }),
  );
  const s = api.source("freebuff", root),
    chats = api.listChats(s),
    byTitle = Object.fromEntries(chats.map((c) => [c.title, c])),
    activity = await api.activities([s], chats);
  assert.equal(chats.length, 2);
  assert.equal(activity[byTitle["Loaded Freebuff chat"].id].active, true);
  assert.equal(activity[byTitle["Loaded Freebuff chat"].id].state, "working");
  assert.equal(activity[byTitle["Older Freebuff chat"].id].active, false);
  assert.equal(activity[byTitle["Older Freebuff chat"].id].state, "unfinished");
});
test("OpenCode status follows completed turns and recent log steps", async () => {
  const f = await fixture(),
    root = join(f.home, "opencode-live");
  await mkdir(join(root, "log"), { recursive: true });
  const db = new DatabaseSync(join(root, "opencode.db"));
  db.exec(
    "CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);",
  );
  const now = Date.now();
  db.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
    "m",
    "oc-live",
    now,
    JSON.stringify({ role: "assistant", time: { created: now } }),
  );
  await writeFile(
    join(root, "log", "opencode.log"),
    `timestamp=${new Date(now).toISOString()} level=INFO message=loop session.id=oc-live step=4\n`,
  );
  const s = api.source("opencode", root),
    chat = {
      id: s.id + ":oc-live",
      sourceId: s.id,
      provider: "opencode",
      nativeId: "oc-live",
      title: "OpenCode live",
      cwd: "",
      createdAt: now,
      updatedAt: now,
      archived: false,
      locator: join(root, "opencode.db"),
    };
  let activity = await api.activities([s], [chat]);
  assert.equal(activity[chat.id].state, "working");
  db.prepare("UPDATE message SET data=? WHERE id='m'").run(
    JSON.stringify({
      role: "assistant",
      time: { created: now, completed: now + 10 },
      finish: "stop",
    }),
  );
  activity = await api.activities([s], [chat]);
  assert.equal(activity[chat.id].state, "idle");
  db.prepare("UPDATE message SET data=? WHERE id='m'").run(
    JSON.stringify({
      role: "assistant",
      time: { created: now },
      error: { name: "MessageAbortedError" },
    }),
  );
  activity = await api.activities([s], [chat]);
  assert.equal(activity[chat.id].state, "interrupted");
  db.prepare("UPDATE message SET data=? WHERE id='m'").run(
    JSON.stringify({
      role: "assistant",
      time: { created: now },
      error: { name: "ApiError" },
    }),
  );
  activity = await api.activities([s], [chat]);
  assert.equal(activity[chat.id].state, "failed");
  db.close();
});
test("Freebuff discovers native chats and excludes credential/config files in transfers", async () => {
  const f = await fixture(),
    root = join(f.home, ".config/manicode"),
    folder = join(
      root,
      "projects",
      "project",
      "chats",
      "2026-11-16T12-00-00.000Z",
    );
  await mkdir(folder, { recursive: true });
  await writeFile(
    join(root, "credentials.json"),
    "FREEBUFF-CREDENTIAL-SENTINEL",
  );
  await writeFile(
    join(folder, "chat-meta.json"),
    JSON.stringify({ messageCount: 2, firstPrompt: "Freebuff question" }),
  );
  await writeFile(
    join(folder, "run-state.json"),
    JSON.stringify({
      sessionState: {
        fileContext: { projectRoot: f.root },
        mainAgentState: { agentType: "free-agent" },
      },
      output: { type: "success" },
    }),
  );
  await writeFile(
    join(folder, "chat-messages.json"),
    JSON.stringify([
      {
        id: "u",
        variant: "user",
        content: "Freebuff question",
        timestamp: 1700000000000,
      },
      {
        id: "a",
        variant: "ai",
        content: "Freebuff answer",
        isComplete: true,
        timestamp: 1700000000001,
      },
    ]),
  );
  const s = api.source("freebuff", root),
    chats = api.listChats(s);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].cwd, f.root);
  assert.deepEqual(
    (await api.allMessages(s, chats[0])).map((m) => m.text),
    ["Freebuff question", "Freebuff answer"],
  );
  const activity = await api.activities([s], chats);
  assert.equal(activity[chats[0].id].state, "idle");
  const e = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "exports"),
      sources: [s],
      chats,
      machine: "test",
    },
    progress,
  );
  const imported = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: e.path },
    progress,
  );
  assert.equal(
    (
      await api.allMessages(
        imported.sources[0],
        api.listChats(imported.sources[0])[0],
      )
    ).length,
    2,
  );
  const manifest = JSON.parse(
    await readFile(join(imported.path, "manifest.json"), "utf8"),
  );
  assert.ok(!manifest.files.some((f) => f.path.includes("credentials.json")));
  assert.ok(manifest.files.some((f) => f.path.endsWith("run-state.json")));
});
test(
  "native activity probe distinguishes held and released Windows file handles",
  {
    skip:
      process.platform !== "win32" ||
      !existsSync("chatport-runtime/chatport-probe.exe"),
  },
  async () => {
    const f = await fixture(),
      file = join(f.root, "writer.lock");
    await writeFile(file, "");
    const script = `$stream=[System.IO.File]::Open('${file.replaceAll("'", "''")}',[System.IO.FileMode]::Open,[System.IO.FileAccess]::ReadWrite,[System.IO.FileShare]::None);[Console]::WriteLine('READY');[Console]::ReadLine() | Out-Null;$stream.Dispose()`;
    const holder = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
    );
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("Lock holder timed out")),
          5000,
        );
        holder.stdout.once("data", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      async function probe() {
        return new Promise((resolve, reject) => {
          const p = spawn(resolvePath(), [], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
          });
          let text = "";
          p.stdout.on("data", (d) => (text += d));
          p.on("error", reject);
          p.on("close", () => resolve(JSON.parse(text)[file]));
          p.stdin.end(JSON.stringify([file]));
        });
      }
      function resolvePath() {
        return resolve("chatport-runtime/chatport-probe.exe");
      }
      assert.equal(await probe(), true);
      holder.stdin.end("\n");
      await new Promise((resolve) => holder.on("exit", resolve));
      assert.equal(await probe(), false);
    } finally {
      holder.kill();
    }
  },
);
