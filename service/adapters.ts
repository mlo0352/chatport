import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  readdirSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { readFile, open } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join, resolve, extname, basename, dirname, relative } from "node:path";
import { hash, readJSON, inside } from "./common";
import { displayPath } from "../src/paths";
import { imageRefs, imageTextKey } from "./images";
import type { Chat, Message, Source, Provider } from "../src/types";

export const names: Record<Provider, string> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  t3: "T3 Code",
  chatgpt: "ChatGPT export",
  freebuff: "Freebuff",
};
export function readDB(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  db.exec("PRAGMA busy_timeout=1200; PRAGMA query_only=ON;");
  return db;
}
export const tables = (db: DatabaseSync) =>
  new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => String(r.name)),
  );
export const columns = (db: DatabaseSync, table: string) =>
  new Set(
    db
      .prepare('PRAGMA table_info("' + table.replaceAll('"', '""') + '")')
      .all()
      .map((r) => String(r.name)),
  );
export function source(
  provider: Provider,
  root: string,
  extra: Partial<Source> = {},
): Source {
  return {
    id: hash(provider + ":" + (process.platform==='win32'?resolve(displayPath(root)).toLowerCase():resolve(displayPath(root)))).slice(0,24),
    provider,
    name: names[provider],
    root: resolve(displayPath(root)),
    available: existsSync(root),
    count: 0,
    format: "native",
    ...extra,
  };
}
export function liveSource(s: Source): Source {
  if (
    s.provider === "codex" &&
    s.nativeRoot &&
    existsSync(join(s.nativeRoot, "state_5.sqlite"))
  )
    return {
      ...s,
      name: "Restored Codex",
      root: s.nativeRoot,
      format: "native",
      imported: false,
      available: true,
      originalRoot: undefined,
      originalSourceId: undefined,
      archiveNativePath: undefined,
      imagesIncluded: undefined,
    };
  return s;
}
export function discover(
  custom: Source[] = [],
  home = process.env.CHATPORT_HOME || homedir(),
) {
  const sources = [
    source("codex", join(home, ".codex")),
    ...(process.env.CODEX_HOME
      ? [source("codex", process.env.CODEX_HOME)]
      : []),
    source("claude", join(home, ".claude")),
    ...(process.env.CLAUDE_CONFIG_DIR
      ? [source("claude", process.env.CLAUDE_CONFIG_DIR)]
      : []),
    source("opencode", join(home, ".local", "share", "opencode")),
    source("t3", join(home, ".t3", "userdata")),
    ...(process.env.T3CODE_HOME ? [source("t3", process.env.T3CODE_HOME)] : []),
    source(
      "freebuff",
      process.env.FREEBUFF_CONFIG_DIR || join(home, ".config", "manicode"),
    ),
    ...custom,
  ];
  const seen = new Set<string>();
  return sources.map(liveSource).filter((s) => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}
const millis = (value: any) => {
  if (typeof value === "number") return value < 1e11 ? value * 1000 : value;
  const n = Date.parse(String(value));
  return Number.isFinite(n) ? n : 0;
};
function chat(s: Source, row: any): Chat {
  return {
    id: s.id + ":" + String(row.id),
    sourceId: s.id,
    provider: s.provider,
    nativeId: String(row.id),
    title: String(row.title || "Untitled conversation"),
    cwd: displayPath(String(row.cwd || "")),
    createdAt: millis(row.createdAt),
    updatedAt: millis(row.updatedAt),
    archived: !!row.archived,
    model: row.model
      ? typeof row.model === "string"
        ? row.model
        : String(
            row.model.model || row.model.modelId || JSON.stringify(row.model),
          )
      : undefined,
    origin: row.origin || undefined,
    parentId: row.parentId || undefined,
    locator: displayPath(String(row.locator || row.id)),
    imported: s.imported,
    ...(row.resumeProvider
      ? {
          resumeProvider: row.resumeProvider,
          resumeNativeId: row.resumeNativeId,
        }
      : {}),
  };
}
export function* files(
  root: string,
  extension: string,
  depth = 0,
): Generator<string> {
  if (depth > 12 || !existsSync(root)) return;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const file = join(root, entry.name);
    if (entry.isDirectory()) yield* files(file, extension, depth + 1);
    else if (entry.isFile() && entry.name.endsWith(extension)) yield file;
  }
}
function prefix(file: string, bytes = 192 * 1024) {
  const fd = openSync(file, "r");
  try {
    const b = Buffer.alloc(Math.min(bytes, statSync(file).size));
    const n = readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n).toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function parse(line: string) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
export function textOf(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value
      .map((v) => textOf(v))
      .filter(Boolean)
      .join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (
    value.type === "image" ||
    value.type === "localImage" ||
    value.type === "image_url"
  )
    return "[Image attachment]";
  if (value.content) return textOf(value.content);
  return "";
}
export function listChats(s: Source): Chat[] {
  if (s.format === "portable") {
    const catalog = readJSON(join(s.root, "catalog.json"));
    if (!Array.isArray(catalog?.chats))
      throw new Error("Portable library catalog is missing");
    return catalog.chats
      .filter(
        (c: any) =>
          c.provider === s.provider &&
          (!s.originalSourceId || c.sourceId === s.originalSourceId),
      )
      .map((c: any) => ({
        ...c,
        id: s.id + ":" + c.nativeId,
        sourceId: s.id,
        imported: true,
        ...(c.activity
          ? { activity: { ...c.activity, active: false, snapshot: true } }
          : {}),
        locator: join(s.root, c.normalizedPath),
      }));
  }
  if (!s.available) return [];
  if (s.provider === "freebuff") {
    const result: Chat[] = [];
    for (const file of files(join(s.root, "projects"), "chat-messages.json")) {
      const folder = dirname(file),
        meta = readJSON(join(folder, "chat-meta.json")),
        state = readJSON(join(folder, "run-state.json")),
        agent = state?.sessionState?.mainAgentState;
      const stats = statSync(file),
        body = meta?.firstPrompt ? undefined : readJSON(file);
      const rel = relative(s.root, folder).replaceAll("\\", "/");
      const c = chat(s, {
        id: hash(rel).slice(0, 32),
        title:
          meta?.firstPrompt ||
          body
            ?.find((m: any) => m.variant === "user")
            ?.content?.slice(0, 160) ||
          "Freebuff conversation",
        cwd:
          state?.sessionState?.fileContext?.projectRoot ||
          state?.sessionState?.fileContext?.cwd,
        createdAt: Date.parse(basename(folder)) || stats.birthtimeMs,
        updatedAt: stats.mtimeMs,
        model: agent?.agentType,
        origin: "Freebuff CLI",
        locator: file,
      });
      c.messageCount = meta?.messageCount || body?.length;
      result.push(c);
    }
    return result;
  }
  if (s.provider === "codex") {
    const result: Chat[] = [],
      known = new Set<string>();
    const file = join(s.root, "state_5.sqlite");
    if (existsSync(file)) {
      const db = readDB(file);
      try {
        const cols = columns(db, "threads");
        const rows = db
          .prepare("SELECT * FROM threads ORDER BY updated_at DESC")
          .all();
        for (const row of rows as any[]) {
          const c = chat(s, {
            id: row.id,
            title:
              row.name || row.title || row.preview || row.first_user_message,
            cwd: row.cwd,
            createdAt: row.created_at_ms || row.created_at,
            updatedAt: row.recency_at_ms || row.updated_at_ms || row.updated_at,
            archived: row.archived,
            model: row.model,
            origin: row.source,
            locator: row.rollout_path,
          });
          result.push(c);
          known.add(c.nativeId);
        }
        s.nativeVersion = cols.has("history_mode")
          ? "paginated + JSONL"
          : "JSONL";
      } finally {
        db.close();
      }
    }
    for (const folder of ["sessions", "archived_sessions"])
      for (const file of files(join(s.root, folder), ".jsonl")) {
        const match = basename(file).match(
          /([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})/i,
        );
        if (match && known.has(match[1])) continue;
        const first = prefix(file).split("\n").map(parse);
        const meta = first.find((v) => v?.type === "session_meta")?.payload;
        if (!meta?.id || known.has(meta.id)) continue;
        const user = first.find(
          (v) => v?.type === "event_msg" && v.payload?.type === "user_message",
        )?.payload?.message;
        const stat = statSync(file);
        result.push(
          chat(s, {
            id: meta.id,
            title: user?.slice(0, 140) || meta.title || "Untitled conversation",
            cwd: meta.cwd,
            createdAt: meta.timestamp || stat.birthtimeMs,
            updatedAt: stat.mtimeMs,
            archived: folder === "archived_sessions",
            origin: meta.source || "legacy JSONL",
            locator: file,
          }),
        );
        known.add(meta.id);
      }
    return result;
  }
  if (s.provider === "claude") {
    const result: Chat[] = [];
    for (const file of files(join(s.root, "projects"), ".jsonl")) {
      if (file.includes("\\subagents\\") || file.includes("/subagents/"))
        continue;
      const rows = prefix(file).split("\n").map(parse).filter(Boolean);
      const meta = rows.find((r) => r.sessionId);
      if (!meta) continue;
      const user = rows.find((r) => r.type === "user" && r.message?.content);
      const title =
        rows.find((r) => r.type === "custom-title")?.customTitle ||
        textOf(user?.message?.content).slice(0, 140);
      const stat = statSync(file);
      result.push(
        chat(s, {
          id: meta.sessionId,
          title,
          cwd: meta.cwd,
          createdAt: meta.timestamp || stat.birthtimeMs,
          updatedAt: stat.mtimeMs,
          locator: file,
          model: rows.find((r) => r.message?.model)?.message.model,
          origin: "Claude Code",
        }),
      );
    }
    return result;
  }
  if (s.provider === "opencode") {
    const db = readDB(join(s.root, "opencode.db"));
    try {
      return db
        .prepare("SELECT * FROM session ORDER BY time_updated DESC")
        .all()
        .map((r: any) =>
          chat(s, {
            id: r.id,
            title: r.title,
            cwd: r.directory,
            createdAt: r.time_created,
            updatedAt: r.time_updated,
            archived: r.time_archived,
            parentId: r.parent_id,
            model: r.model,
            origin: "OpenCode",
          }),
        );
    } finally {
      db.close();
    }
  }
  if (s.provider === "t3") {
    const file = ["statev2.sqlite", "state.sqlite"]
      .map((n) => join(s.root, n))
      .find(existsSync);
    if (!file)
      throw new Error("No T3 Code conversation database in this folder");
    const db = readDB(file);
    try {
      const t = tables(db),
        v2 = t.has("orchestration_v2_projection_threads"),
        table = v2
          ? "orchestration_v2_projection_threads"
          : "projection_threads";
      if (!t.has(table))
        throw new Error("This T3 database schema is not recognized");
      s.nativeVersion = v2 ? "V2" : "V1";
      const projects = t.has("projection_projects")
        ? (db.prepare("SELECT * FROM projection_projects").all() as any[])
        : [];
      return (
        db
          .prepare("SELECT * FROM " + table + " ORDER BY updated_at DESC")
          .all() as any[]
      )
        .filter((r) => !r.deleted_at)
        .map((r) => {
          const payload = parse(r.payload_json || "{}") || {},
            p = projects.find((p) => p.project_id === r.project_id);
          return chat(s, {
            id: r.thread_id,
            title: r.title,
            cwd:
              r.worktree_path ||
              payload.worktreePath ||
              payload.cwd ||
              p?.workspace_root,
            createdAt: r.created_at,
            updatedAt: r.updated_at,
            archived: r.archived_at,
            model: r.model || payload.model,
            origin: "T3 " + (r.default_provider || ""),
            resumeProvider: r.default_provider,
            resumeNativeId: r.active_provider_thread_id,
            locator: file,
          });
        });
    } finally {
      db.close();
    }
  }
  return [];
}
function codexItem(row: any, c: Chat): Message | null {
  const p = parse(row.item_json);
  if (!p) return null;
  const role =
    row.item_type === "userMessage"
      ? "user"
      : row.item_type === "agentMessage"
        ? "assistant"
        : "tool";
  const text =
    role === "tool"
      ? String(p.aggregatedOutput || p.output || p.command || p.text || "")
      : textOf(p);
  const attachments =
    row.item_type === "userMessage"
      ? imageRefs(
          p.content,
          c.nativeId + ":" + String(row.item_id || row.rollout_ordinal),
          {
            transcript: c.locator,
            textKey: imageTextKey(
              textOf(p.content).replaceAll("[Image attachment]", "").trim(),
            ),
            offset: row.turn_offset ?? undefined,
            end: row.turn_end ?? undefined,
          },
        )
      : [];
  return text || attachments.length
    ? {
        id: String(row.item_id || row.rollout_ordinal),
        role,
        text,
        at: row.created_at_ms || undefined,
        kind: row.item_type,
        ...(attachments.length ? { attachments } : {}),
      }
    : null;
}
export async function messages(
  s: Source,
  c: Chat,
  options: { before?: number; limit?: number; tools?: boolean } = {},
) {
  const limit = Math.max(1, Math.min(300, options.limit || 100));
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  if (s.provider === "freebuff" && s.format !== "portable") {
    const body = JSON.parse(await readFile(c.locator, "utf8"));
    const all = body
      .filter((m: any) =>
        ["user", "ai", "assistant", "system"].includes(m.variant),
      )
      .map(
        (m: any, i: number) =>
          ({
            id: String(m.id || i),
            role:
              m.variant === "user"
                ? "user"
                : m.variant === "system"
                  ? "system"
                  : "assistant",
            text: typeof m.content === "string" ? m.content : textOf(m.blocks),
            at: millis(m.timestamp),
            attachments: imageRefs(
              m.blocks || [],
              c.nativeId + ":" + String(m.id || i),
            ),
          }) as Message,
      );
    const stop = Math.min(before, all.length),
      batch = all.slice(Math.max(0, stop - limit), stop);
    return {
      messages: batch,
      before: Math.max(0, stop - batch.length),
      hasMore: stop > batch.length,
    };
  }
  if (s.format === "portable") {
    if (!inside(s.root, c.locator))
      throw new Error("Conversation points outside its archive");
    if (
      options.tools &&
      s.archiveNativePath &&
      ["codex", "claude", "opencode", "t3"].includes(s.provider)
    ) {
      const native = resolve(s.root, s.archiveNativePath);
      if (!inside(s.root, native))
        throw new Error("Native data points outside its archive");
      const jsonl = [...files(native, ".jsonl")].find((file) =>
        basename(file).includes(c.nativeId),
      );
      const database =
        s.provider === "t3"
          ? ["statev2.sqlite", "state.sqlite"]
              .map((name) => join(native, name))
              .find(existsSync)
          : join(
              native,
              s.provider === "codex"
                ? "thread_history_1.sqlite"
                : "opencode.db",
            );
      if (jsonl || (database && existsSync(database)))
        return messages(
          { ...s, root: native, format: "native" },
          {
            ...c,
            locator:
              s.provider === "t3"
                ? database!
                : jsonl || join(native, "missing-transcript.jsonl"),
          },
          options,
        );
    }
    const d = JSON.parse(await readFile(c.locator, "utf8"));
    const list = (d.messages || [])
      .filter((_m: any, i: number) => i < before)
      .map((m: Message, i: number) => ({ m, i }))
      .filter(({ m }: { m: Message }) => options.tools || m.role !== "tool");
    const batch = list.slice(-limit);
    return {
      messages: batch.map((v: { m: Message }) => v.m) as Message[],
      before: batch[0]?.i || 0,
      hasMore: list.length > batch.length,
    };
  }
  if (
    s.provider === "codex" &&
    existsSync(join(s.root, "thread_history_1.sqlite"))
  ) {
    const db = readDB(join(s.root, "thread_history_1.sqlite"));
    try {
      const types = options.tools
        ? "'userMessage','agentMessage','commandExecution','fileChange','mcpToolCall','functionCallOutput','webSearch'"
        : "'userMessage','agentMessage'";
      const turnColumns = tables(db).has("thread_turns")
        ? columns(db, "thread_turns")
        : new Set();
      const hasOffsets = turnColumns.has("rollout_byte_offset");
      const rows = db
        .prepare(
          `SELECT i.* ${hasOffsets ? ",t.rollout_byte_offset AS turn_offset,t.rollout_end_byte_offset AS turn_end" : ""} FROM thread_items i ${hasOffsets ? "LEFT JOIN thread_turns t ON t.thread_id=i.thread_id AND t.turn_id=i.turn_id" : ""} WHERE i.thread_id=? AND i.rollout_ordinal<? AND i.item_type IN (${types}) ORDER BY i.rollout_ordinal DESC LIMIT ?`,
        )
        .all(c.nativeId, before, limit + 1) as any[];
      if (
        rows.length ||
        !existsSync(c.locator) ||
        db
          .prepare("SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1")
          .get(c.nativeId)
      ) {
        const batch = rows.slice(0, limit).reverse();
        return {
          messages: batch
            .map((row) => codexItem(row, c))
            .filter(Boolean) as Message[],
          before: batch[0]?.rollout_ordinal || 0,
          hasMore: rows.length > limit,
        };
      }
    } finally {
      db.close();
    }
  }
  if (s.provider === "opencode") {
    const db = readDB(join(s.root, "opencode.db"));
    try {
      const rows = db
        .prepare(
          "SELECT * FROM message WHERE session_id=? AND time_created<? ORDER BY time_created DESC LIMIT ?",
        )
        .all(c.nativeId, before, limit + 1) as any[];
      const batch = rows.slice(0, limit).reverse();
      const list = batch.map((r) => {
        const meta = parse(r.data) || {};
        const parts = db
          .prepare(
            "SELECT data FROM part WHERE message_id=? ORDER BY time_created",
          )
          .all(r.id);
        const text = parts
          .map((p) => {
            const v = parse(String(p.data));
            return v?.type === "text"
              ? v.text
              : options.tools && v?.type === "tool"
                ? JSON.stringify(v.state || v)
                : "";
          })
          .filter(Boolean)
          .join("\n");
        return {
          id: r.id,
          role: meta.role === "user" ? "user" : "assistant",
          text,
          at: r.time_created,
          attachments: imageRefs(
            parts.map((p) => parse(String(p.data))),
            c.nativeId + ":" + r.id,
          ),
        } as Message;
      });
      return {
        messages: list,
        before: batch[0]?.time_created || 0,
        hasMore: rows.length > limit,
      };
    } finally {
      db.close();
    }
  }
  if (s.provider === "t3") {
    const db = readDB(c.locator);
    try {
      const t = tables(db);
      const table = t.has("orchestration_v2_projection_messages")
        ? "orchestration_v2_projection_messages"
        : "projection_thread_messages";
      const rows = db
        .prepare(
          "SELECT * FROM " + table + " WHERE thread_id=? ORDER BY created_at",
        )
        .all(c.nativeId) as any[];
      const all = rows
        .map((r) => {
          const payload = parse(r.payload_json || "{}") || {};
          return {
            id: r.message_id,
            role: r.role || payload.role || "assistant",
            text: r.text || payload.text || textOf(payload.content),
            at: millis(r.created_at),
          } as Message;
        })
        .filter((m) => m.text);
      const stop = Math.min(before, all.length);
      const batch = all.slice(Math.max(0, stop - limit), stop);
      return {
        messages: batch,
        before: Math.max(0, stop - batch.length),
        hasMore: stop > batch.length,
      };
    } finally {
      db.close();
    }
  }
  if (!existsSync(c.locator))
    return { messages: [] as Message[], before: 0, hasMore: false };
  const batch: Message[] = [];
  let cursor = 0;
  for await (const row of reverseLines(c.locator, options.before)) {
    const m = legacyMessage(
      s,
      parse(row.line),
      !!options.tools,
      String(row.offset),
    );
    if (m) {
      batch.push(m);
      cursor = row.offset;
      if (batch.length === limit) break;
    }
  }
  return {
    messages: batch.reverse(),
    before: cursor,
    hasMore: batch.length === limit && cursor > 0,
  };
}
function legacyMessage(
  s: Source,
  e: any,
  tools: boolean,
  id: string,
): Message | undefined {
  if (!e) return;
  let role: Message["role"] | undefined,
    text = "";
  if (
    s.provider === "claude" &&
    (e.type === "user" || e.type === "assistant")
  ) {
    role = e.type === "user" ? "user" : "assistant";
    text = textOf(e.message?.content);
  } else if (
    s.provider === "codex" &&
    e.type === "response_item" &&
    e.payload?.type === "message" &&
    ["user", "assistant"].includes(e.payload.role)
  ) {
    role = e.payload.role;
    text = textOf(e.payload.content);
  } else if (
    tools &&
    e.type === "response_item" &&
    e.payload?.type === "function_call_output"
  ) {
    role = "tool";
    text = String(e.payload.output || "");
  }
  const attachments =
    role === "user"
      ? imageRefs(
          s.provider === "claude" ? e.message?.content : e.payload?.content,
          s.id + ":" + id,
        )
      : [];
  if (role && (text || attachments.length))
    return {
      id,
      role,
      text,
      at: millis(e.timestamp),
      kind: e.payload?.type,
      ...(attachments.length ? { attachments } : {}),
    };
}
export async function* reverseLines(
  file: string,
  before?: number,
): AsyncGenerator<{ line: string; offset: number }> {
  const handle = await open(file, "r");
  try {
    let position = Math.min(
        before ?? Number.MAX_SAFE_INTEGER,
        (await handle.stat()).size,
      ),
      carry = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - 256 * 1024),
        block = Buffer.alloc(position - start);
      await handle.read(block, 0, block.length, start);
      const combined = Buffer.concat([block, carry]);
      let end = combined.length;
      for (let i = combined.length - 1; i >= 0; i--)
        if (combined[i] === 10) {
          if (end > i + 1)
            yield {
              line: combined
                .subarray(i + 1, end)
                .toString("utf8")
                .replace(/\r$/, ""),
              offset: start + i + 1,
            };
          end = i;
        }
      carry = Buffer.from(combined.subarray(0, end));
      position = start;
    }
    if (carry.length)
      yield { line: carry.toString("utf8").replace(/\r$/, ""), offset: 0 };
  } finally {
    await handle.close();
  }
}
export async function allMessages(s: Source, c: Chat) {
  if (s.format === "portable") {
    if (!inside(s.root, c.locator))
      throw new Error("Conversation points outside its archive");
    const body = JSON.parse(await readFile(c.locator, "utf8"));
    return (body.messages || []).filter(
      (m: Message) => m.role !== "tool",
    ) as Message[];
  }
  let structured = false;
  if (
    s.provider === "codex" &&
    existsSync(join(s.root, "thread_history_1.sqlite"))
  ) {
    const db = readDB(join(s.root, "thread_history_1.sqlite"));
    try {
      structured = !!db
        .prepare("SELECT 1 FROM thread_items WHERE thread_id=? LIMIT 1")
        .get(c.nativeId);
    } finally {
      db.close();
    }
  }
  if ((s.provider === "codex" && !structured) || s.provider === "claude") {
    const result: Message[] = [];
    if (!existsSync(c.locator)) return result;
    const lines = createInterface({
      input: createReadStream(c.locator),
      crlfDelay: Infinity,
    });
    let n = 0;
    for await (const line of lines) {
      const m = legacyMessage(s, parse(line), false, String(n++));
      if (m) result.push(m);
    }
    return result;
  }
  const list: Message[] = [];
  let before: number | undefined;
  for (let i = 0; i < 10000; i++) {
    const p = await messages(s, c, { before, limit: 300, tools: false });
    list.unshift(...p.messages);
    if (!p.hasMore) break;
    before = p.before;
  }
  return list;
}
