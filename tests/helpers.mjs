import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
await mkdir(".test-data", { recursive: true });
await build({
  stdin: {
    contents:
      "export * from './service/adapters';export * from './service/transfer';export * from './service/launch';export * from './service/images';export * from './service/activity';export * from './src/paths';export * from './service/db';export * from './service/nearby';export * from './service/platform';",
    resolveDir: process.cwd(),
    sourcefile: "test-api.ts",
  },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: `.test-data/test-api-${process.pid}.cjs`,
});
export const api = createRequire(import.meta.url)(
  resolve(`.test-data/test-api-${process.pid}.cjs`),
);
export async function fixture() {
  const root = await mkdtemp(resolve(".test-data/fixture-")),
    home = join(root, "home"),
    data = join(root, "data"),
    codex = join(home, ".codex");
  await mkdir(codex, { recursive: true });
  await mkdir(join(codex, "thread-writer-locks"), { recursive: true });
  await mkdir(data, { recursive: true });
  const db = new DatabaseSync(join(codex, "state_5.sqlite"));
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,title TEXT,cwd TEXT,created_at INTEGER,updated_at INTEGER,archived INTEGER,source TEXT,model TEXT,history_mode TEXT); CREATE TABLE remote_control_enrollments(thread_id TEXT,client_token TEXT);`,
  );
  const history = new DatabaseSync(join(codex, "thread_history_1.sqlite"));
  history.exec(
    "CREATE TABLE thread_items(thread_id TEXT,turn_id TEXT,item_id TEXT,rollout_ordinal INTEGER,created_at_ms INTEGER,item_type TEXT,item_json TEXT,updated_at_ordinal INTEGER); CREATE TABLE thread_turns(thread_id TEXT,turn_id TEXT,status TEXT,rollout_ordinal INTEGER,started_at INTEGER,completed_at INTEGER,rollout_byte_offset INTEGER,rollout_end_byte_offset INTEGER);",
  );
  const queue = new DatabaseSync(join(codex, "queue_1.sqlite"));
  queue.exec(
    "CREATE TABLE queued_items(id TEXT,thread_id TEXT,payload_json TEXT,queue_order INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER);",
  );
  db.exec("BEGIN");
  history.exec("BEGIN");
  queue.exec("BEGIN");
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ];
  for (let n = 0; n < ids.length; n++) {
    const id = ids[n];
    const file = join(codex, "sessions", "2026", "11", id + ".jsonl");
    await mkdir(join(codex, "sessions", "2026", "11"), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({ type: "session_meta", payload: { id, cwd: root } }) +
        "\n",
    );
    db.prepare("INSERT INTO threads VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      id,
      file,
      n ? "Second conversation" : "First café 日本語",
      root,
      1700000000,
      1700000100 + n,
      0,
      "cli",
      "gpt-test",
      "sqlite",
    );
    db.prepare("INSERT INTO remote_control_enrollments VALUES(?,?)").run(
      id,
      "MUST-NOT-TRANSFER",
    );
    for (let i = 0; i < 307; i++) {
      const user = i % 2 === 0,
        item = user
          ? {
              type: "userMessage",
              content: [{ type: "text", text: `User message ${i} — café` }],
            }
          : {
              type: "agentMessage",
              text: `Assistant message ${i} — ${n ? "second" : "needle mango"}`,
            };
      history
        .prepare("INSERT INTO thread_items VALUES(?,?,?,?,?,?,?,?)")
        .run(
          id,
          "turn",
          `item-${i}`,
          i,
          1700000100000 + i,
          item.type,
          JSON.stringify(item),
          i,
        );
    }
    history
      .prepare(
        "INSERT INTO thread_turns(thread_id,turn_id,status,rollout_ordinal) VALUES(?,?,?,?)",
      )
      .run(id, "turn", "completed", 1);
    queue
      .prepare("INSERT INTO queued_items VALUES(?,?,?,?,?,?)")
      .run(
        "queued-" + n,
        id,
        JSON.stringify({ text: "Remember this pending prompt " + n }),
        0,
        1,
        1,
      );
  }
  db.exec("COMMIT");
  history.exec("COMMIT");
  queue.exec("COMMIT");
  db.close();
  history.close();
  queue.close();
  await writeFile(join(codex, "auth.json"), "PRIVATE-AUTH-SENTINEL");
  await writeFile(join(codex, "config.toml"), "PRIVATE-CONFIG-SENTINEL");
  return { root, home, data, codex, ids };
}
