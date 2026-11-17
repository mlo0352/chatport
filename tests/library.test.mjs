import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { api, fixture } from "./helpers.mjs";
const progress = () => {};
test("Codex metadata and complete paginated messages include Unicode and native queues survive transfer", async () => {
  const f = await fixture(),
    s = api.source("codex", f.codex),
    chats = api.listChats(s);
  assert.equal(chats.length, 2);
  assert.equal(
    chats.find((c) => c.nativeId === f.ids[0]).title,
    "First café 日本語",
  );
  const body = await api.allMessages(s, chats[0]);
  assert.equal(body.length, 307);
  assert.match(body[0].text, /User message 0/);
  assert.match(body.at(-1).text, /User message 306/);
  const e = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "USB"),
      chats: [chats.find((c) => c.nativeId === f.ids[0])],
      sources: [s],
      machine: "fixture",
    },
    progress,
  );
  assert.equal(e.chatCount, 1);
  assert.ok(e.bytes > 1000);
  const imported = await api.importBundle(
      { dataDir: f.data, jobId: randomUUID(), file: e.path },
      progress,
    ),
    p = imported.sources[0],
    again = api.listChats(p);
  assert.equal(again.length, 1);
  assert.equal((await api.allMessages(p, again[0])).length, 307);
  const manifest = JSON.parse(
    await readFile(join(imported.path, "manifest.json"), "utf8"),
  );
  assert.ok(!manifest.files.some((f) => /auth.json|config.toml/.test(f.path)));
  const native = join(p.root, p.archiveNativePath);
  const db = new DatabaseSync(join(native, "state_5.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM threads").get().n, 1);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM remote_control_enrollments").get().n,
    0,
  );
  db.close();
  const q = new DatabaseSync(join(native, "queue_1.sqlite"));
  assert.equal(q.prepare("SELECT count(*) AS n FROM queued_items").get().n, 1);
  assert.match(
    q.prepare("SELECT payload_json FROM queued_items").get().payload_json,
    /pending prompt 0/,
  );
  q.close();
  const profile = join(f.root, "restored-profile");
  await mkdir(profile);
  await writeFile(join(profile, "auth.json"), "new-machine-login");
  await api.restoreCodex(
    { dataDir: f.data, source: p, target: profile, jobId: randomUUID() },
    progress,
  );
  assert.equal(
    await readFile(join(profile, "auth.json"), "utf8"),
    "new-machine-login",
  );
  const restored = new DatabaseSync(join(profile, "state_5.sqlite"));
  assert.ok(
    restored
      .prepare("SELECT rollout_path FROM threads")
      .get()
      .rollout_path.startsWith(profile),
  );
  restored.close();
  await assert.rejects(
    () =>
      api.restoreCodex(
        { dataDir: f.data, source: p, target: profile, jobId: randomUUID() },
        progress,
      ),
    /empty profile/,
  );
  const reexport = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "network-share"),
      chats: again,
      sources: [{ ...p, nativeRoot: profile }],
      machine: "second",
    },
    progress,
  );
  const back = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: reexport.path },
    progress,
  );
  assert.equal(api.listChats(back.sources[0]).length, 1);
  assert.equal(
    (await api.allMessages(back.sources[0], api.listChats(back.sources[0])[0]))
      .length,
    307,
  );
  assert.ok(
    !JSON.stringify(
      JSON.parse(await readFile(join(back.path, "manifest.json"), "utf8")),
    ).includes("auth.json"),
  );
  const plan = api.resumePlan(
    { ...again[0], resumeCwd: f.root },
    { ...p, nativeRoot: profile },
  );
  assert.ok(plan.args.includes("-C"));
  assert.equal(plan.args.at(-1), f.root);
  assert.equal(plan.env.CODEX_HOME, profile);
});
test("tampered archives fail checksums before they become library sources", async () => {
  const f = await fixture(),
    s = api.source("codex", f.codex),
    e = await api.exportBundle(
      {
        dataDir: f.data,
        jobId: randomUUID(),
        destination: join(f.root, "export"),
        chats: api.listChats(s),
        sources: [s],
        machine: "test",
      },
      progress,
    );
  const good = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: e.path },
    progress,
  );
  const zip = new yazl.ZipFile();
  for (const file of api.files(good.path, "")) {
    const rel = file.slice(good.path.length + 1).replaceAll("\\", "/");
    if (rel === "catalog.json") zip.addBuffer(Buffer.from("{}"), rel);
    else zip.addFile(file, rel);
  }
  zip.end();
  const bad = join(f.root, "tampered.zip");
  await pipeline(zip.outputStream, createWriteStream(bad));
  await assert.rejects(
    () =>
      api.importBundle(
        { dataDir: f.data, jobId: randomUUID(), file: bad },
        progress,
      ),
    /checksum/,
  );
});
test("re-exporting one imported chat excludes other native transcripts and database messages", async () => {
  const f = await fixture(),
    s = api.source("codex", f.codex);
  const original = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "exports"),
      chats: api.listChats(s),
      sources: [s],
      machine: "test",
    },
    progress,
  );
  const imported = await api.importBundle(
      { dataDir: f.data, jobId: randomUUID(), file: original.path },
      progress,
    ),
    p = imported.sources[0],
    one = api.listChats(p).find((c) => c.nativeId === f.ids[0]);
  const selected = await api.exportBundle(
    {
      dataDir: f.data,
      jobId: randomUUID(),
      destination: join(f.root, "selected"),
      chats: [one],
      sources: [p],
      machine: "test",
    },
    progress,
  );
  const result = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file: selected.path },
    progress,
  );
  const native = join(result.path, result.sources[0].archiveNativePath);
  assert.ok(
    ![...api.files(native, ".jsonl")].some((file) => file.includes(f.ids[1])),
  );
  const db = new DatabaseSync(join(native, "thread_history_1.sqlite"));
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM thread_items WHERE thread_id=?")
      .get(f.ids[1]).n,
    0,
  );
  db.close();
});
test("legacy JSONL reads newest messages from the end and exports the entire transcript once", async () => {
  const f = await fixture(),
    root = join(f.root, "legacy"),
    id = "33333333-3333-4333-8333-333333333333";
  await mkdir(join(root, "sessions"), { recursive: true });
  const file = join(root, "sessions", id + ".jsonl"),
    lines = [
      JSON.stringify({ type: "session_meta", payload: { id, cwd: f.root } }),
    ];
  for (let i = 0; i < 420; i++) {
    lines.push(
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: i % 2 ? "assistant" : "user",
          content: [
            { type: "input_text", text: "Legacy " + i + " café 日本語" },
          ],
        },
      }),
    );
    lines.push(
      JSON.stringify({
        type: "response_item",
        payload: { type: "function_call_output", output: "x".repeat(5000) },
      }),
    );
  }
  await writeFile(file, lines.join("\n") + "\n");
  const s = api.source("codex", root),
    c = api.listChats(s)[0];
  const page = await api.messages(s, c, { limit: 100 });
  assert.equal(page.messages.length, 100);
  assert.equal(page.messages[0].text, "Legacy 320 café 日本語");
  assert.equal(page.messages.at(-1).text, "Legacy 419 café 日本語");
  const earlier = await api.messages(s, c, { limit: 100, before: page.before });
  assert.equal(earlier.messages[0].text, "Legacy 220 café 日本語");
  assert.equal(earlier.messages.at(-1).text, "Legacy 319 café 日本語");
  assert.equal((await api.allMessages(s, c)).length, 420);
});
test("ZIP traversal, Windows absolute paths, and symbolic-link entries are rejected", async () => {
  for (const p of ["../bad", "C:/bad", "/bad", "a\\bad", "a/../b", "a//b"])
    assert.throws(() => api.zipPath(p));
  const f = await fixture();
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from("bad"), "xx/evil.txt");
  zip.end();
  const path = join(f.root, "traversal.zip");
  await pipeline(zip.outputStream, createWriteStream(path));
  const b = await readFile(path);
  let at = 0;
  while ((at = b.indexOf("xx/evil.txt", at)) >= 0) {
    b.write("../evil.txt", at);
    at += 11;
  }
  await writeFile(path, b);
  await assert.rejects(
    () =>
      api.importBundle(
        { dataDir: f.data, jobId: randomUUID(), file: path },
        progress,
      ),
    /invalid relative path|Unsafe path/,
  );
  const symlink = new yazl.ZipFile();
  symlink.addBuffer(Buffer.from("target"), "link", { mode: 0o120777 });
  symlink.end();
  const link = join(f.root, "symlink.zip");
  await pipeline(symlink.outputStream, createWriteStream(link));
  await assert.rejects(
    () =>
      api.importBundle(
        { dataDir: f.data, jobId: randomUUID(), file: link },
        progress,
      ),
    /symbolic links/,
  );
});
test("ChatGPT JSON export imports active branch and retains all branches in original JSON", async () => {
  const f = await fixture(),
    file = join(f.root, "conversations.json");
  const payload = [
    {
      id: "cloud-chat",
      title: "Cloud café",
      current_node: "a",
      create_time: 1700000000,
      update_time: 1700000001,
      mapping: {
        u: {
          id: "u",
          parent: null,
          message: { author: { role: "user" }, content: { parts: ["Hello"] } },
        },
        a: {
          id: "a",
          parent: "u",
          message: {
            author: { role: "assistant" },
            content: { parts: ["Current answer"] },
          },
        },
        other: {
          id: "other",
          parent: "u",
          message: {
            author: { role: "assistant" },
            content: { parts: ["Alternate answer"] },
          },
        },
      },
    },
  ];
  await writeFile(file, JSON.stringify(payload));
  const r = await api.importBundle(
    { dataDir: f.data, jobId: randomUUID(), file },
    progress,
  );
  const chats = api.listChats(r.sources[0]),
    body = await api.allMessages(r.sources[0], chats[0]);
  assert.deepEqual(
    body.map((m) => m.text),
    ["Hello", "Current answer"],
  );
  assert.match(
    await readFile(
      join(r.path, "native/chatgpt-export/conversations.json"),
      "utf8",
    ),
    /Alternate answer/,
  );
  assert.ok(!(await readdir(r.path)).includes("conversations.json"));
});
test("Claude, OpenCode, T3 V1 and V2 adapters read representative native stores", async () => {
  const f = await fixture(),
    claude = join(f.home, ".claude");
  await mkdir(join(claude, "projects", "project"), { recursive: true });
  await writeFile(
    join(claude, "projects", "project", "claude-session.jsonl"),
    [
      {
        type: "user",
        sessionId: "claude-session",
        cwd: f.root,
        timestamp: "2026-11-15T12:00:00Z",
        message: { content: "Claude question" },
      },
      {
        type: "assistant",
        sessionId: "claude-session",
        message: {
          model: "claude-test",
          content: [{ type: "text", text: "Claude answer" }],
        },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n"),
  );
  const cs = api.source("claude", claude);
  assert.equal(api.listChats(cs).length, 1);
  assert.equal((await api.allMessages(cs, api.listChats(cs)[0])).length, 2);
  const oc = join(f.home, "opencode");
  await mkdir(oc);
  const o = new DatabaseSync(join(oc, "opencode.db"));
  o.exec(
    "CREATE TABLE session(id TEXT,title TEXT,directory TEXT,time_created INTEGER,time_updated INTEGER,time_archived INTEGER,parent_id TEXT,model TEXT); CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);",
  );
  o.prepare("INSERT INTO session VALUES(?,?,?,?,?,?,?,?)").run(
    "oc",
    "OpenCode question",
    f.root,
    1,
    2,
    null,
    null,
    null,
  );
  o.prepare("INSERT INTO message VALUES(?,?,?,?)").run(
    "m",
    "oc",
    1,
    JSON.stringify({ role: "user" }),
  );
  o.prepare("INSERT INTO part VALUES(?,?,?,?,?)").run(
    "p",
    "m",
    "oc",
    1,
    JSON.stringify({ type: "text", text: "OpenCode body" }),
  );
  o.close();
  const os = api.source("opencode", oc);
  assert.equal(
    (await api.allMessages(os, api.listChats(os)[0]))[0].text,
    "OpenCode body",
  );
  for (const version of [1, 2]) {
    const t3 = join(f.home, "t3-v" + version);
    await mkdir(t3);
    const t = new DatabaseSync(
      join(t3, version === 2 ? "statev2.sqlite" : "state.sqlite"),
    );
    t.exec(
      "CREATE TABLE projection_projects(project_id TEXT,title TEXT,workspace_root TEXT);",
    );
    t.prepare("INSERT INTO projection_projects VALUES(?,?,?)").run(
      "p",
      "Project",
      f.root,
    );
    if (version === 1) {
      t.exec(
        "CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,title TEXT,model TEXT,branch TEXT,worktree_path TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT); CREATE TABLE projection_thread_messages(message_id TEXT,thread_id TEXT,role TEXT,text TEXT,created_at TEXT);",
      );
      t.prepare("INSERT INTO projection_threads VALUES(?,?,?,?,?,?,?,?,?)").run(
        "t",
        "p",
        "T3 V1",
        "model",
        null,
        null,
        "2026-11-15",
        "2026-11-15",
        null,
      );
      t.prepare("INSERT INTO projection_thread_messages VALUES(?,?,?,?,?)").run(
        "m",
        "t",
        "assistant",
        "T3 body",
        "2026-11-15",
      );
    } else {
      t.exec(
        "CREATE TABLE orchestration_v2_projection_threads(thread_id TEXT,project_id TEXT,title TEXT,default_provider TEXT,active_provider_thread_id TEXT,created_at TEXT,updated_at TEXT,archived_at TEXT,deleted_at TEXT,payload_json TEXT); CREATE TABLE orchestration_v2_projection_messages(message_id TEXT,thread_id TEXT,role TEXT,created_at TEXT,payload_json TEXT);",
      );
      t.prepare(
        "INSERT INTO orchestration_v2_projection_threads VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        "t",
        "p",
        "T3 V2",
        "codex",
        "provider-binding",
        "2026-11-15",
        "2026-11-15",
        null,
        null,
        "{}",
      );
      t.prepare(
        "INSERT INTO orchestration_v2_projection_messages VALUES(?,?,?,?,?)",
      ).run(
        "m",
        "t",
        "assistant",
        "2026-11-15",
        JSON.stringify({ text: "T3 body" }),
      );
    }
    t.close();
    const ts = api.source("t3", t3),
      chats = api.listChats(ts);
    assert.equal(chats[0].cwd, f.root);
    assert.equal((await api.allMessages(ts, chats[0]))[0].text, "T3 body");
  }
});
