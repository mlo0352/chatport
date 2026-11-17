import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { readDB, tables, columns, reverseLines, files } from "./adapters";
import { readJSON, hash } from "./common";
import {executableName} from './platform';
import type { Source, Chat, Activity } from "../src/types";
export function currentActivity(
  activity: Activity | undefined,
  checkedAt: number,
  now = Date.now(),
): Activity | undefined {
  if (!activity || activity.snapshot || now - checkedAt < 10000)
    return activity;
  return {
    ...activity,
    active: null,
    state: "unknown",
    detail:
      "Activity has not been verified recently. The status monitor may be unavailable.",
  };
}
export function classifyTurn(
  status: string,
  active: boolean | null,
  revision: string,
  at?: number,
): Activity {
  const base = { active, revision, at };
  if (status === "interrupted")
    return {
      ...base,
      state: "interrupted",
      detail: "The provider recorded an interrupted turn.",
    };
  if (status === "failed")
    return {
      ...base,
      state: "failed",
      detail: "The provider recorded a failed turn.",
    };
  if (/inProgress|running|pending/.test(status))
    return active === true
      ? {
          ...base,
          state: "working",
          detail:
            "A turn is in progress and this conversation has a live writer lock.",
        }
      : active === false
        ? {
            ...base,
            state: "unfinished",
            detail:
              "The last turn has no completion record and its writer lock is no longer held. It may have ended because of a crash or forced exit.",
          }
        : {
            ...base,
            state: "unknown",
            detail:
              "The last turn has no completion record. Live ownership could not be verified.",
          };
  return {
    ...base,
    state: status === "completed" ? "idle" : "unknown",
    detail:
      status === "completed"
        ? active
          ? "Conversation is open; the last turn completed."
          : "The last recorded turn completed."
        : "No reliable turn-completion record is available.",
  };
}
async function probe(paths: string[]): Promise<Record<string, boolean | null>> {
  if (!paths.length) return {};
  const exe =
    process.env.CHATPORT_PROBE_EXE || join(__dirname, executableName('chatport-probe'));
  if (!existsSync(exe)) return {};
  return new Promise((resolve) => {
    const p = spawn(exe, [], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    let result = "";
    const timeout = setTimeout(() => {
      p.kill();
      resolve({});
    }, 2500);
    p.stdout.on("data", (d) => (result += d));
    p.on("error", () => {
      clearTimeout(timeout);
      resolve({});
    });
    p.on("close", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(result));
      } catch {
        resolve({});
      }
    });
    p.stdin.on("error", () => {});
    p.stdin.end(JSON.stringify(paths));
  });
}
const OPENCODE_ACTIVE_WINDOW = 3 * 60_000;
const OPENCODE_RETRY_WINDOW = 6.5 * 60_000;
const FREEBUFF_HEARTBEAT_WINDOW = 3 * 60_000;
function head(file: string, bytes = 32 * 1024) {
  try {
    const fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(bytes);
      const n = readSync(fd, b, 0, bytes, 0);
      return b.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
function tail(file: string, bytes = 32 * 1024) {
  try {
    const size = statSync(file).size,
      start = Math.max(0, size - bytes),
      fd = openSync(file, "r");
    try {
      const b = Buffer.alloc(size - start);
      const n = readSync(fd, b, 0, b.length, start);
      return b.subarray(0, n).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}
function logfmt(line: string) {
  const fields: Record<string, string> = {};
  for (const m of line.matchAll(
    /([A-Za-z][\w.]*)=("(?:[^"\\]|\\.)*"|\S+)/g,
  )) {
    let value = m[2];
    if (value.startsWith('"'))
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    fields[m[1]] = value;
  }
  return fields;
}
function freebuffOwner(folder: string) {
  for (const line of head(join(folder, "log.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (Number.isInteger(value?.pid) && value.pid > 0) return value.pid;
    } catch {}
  }
  return undefined;
}
type FreebuffLoaded = { at: number; folder?: string; chatId?: string };
function freebuffLoaded(folder: string): FreebuffLoaded | undefined {
  let loaded: FreebuffLoaded | undefined;
  for (const line of tail(join(folder, "log.jsonl")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line),
        data = value?.data;
      if (!data || (!data.chatId && !data.runStatePath)) continue;
      const at = Date.parse(String(value.timestamp || ""));
      const entry: FreebuffLoaded = {
        at: Number.isFinite(at) ? at : 0,
        ...(typeof data.runStatePath === "string"
          ? { folder: dirname(data.runStatePath) }
          : {}),
        ...(typeof data.chatId === "string" ? { chatId: data.chatId } : {}),
      };
      if (!loaded || entry.at >= loaded.at) loaded = entry;
    } catch {}
  }
  return loaded;
}
const freebuffPath = (value: string) =>
  process.platform === "win32" ? resolve(value).toLowerCase() : resolve(value);
type FreebuffOwner = {
  pid: number;
  at: number;
  folder?: string;
  chatId?: string;
};
function freebuffOwnership(root: string) {
  const byTarget = new Map<string, FreebuffOwner>(),
    byPid = new Map<number, FreebuffLoaded>(),
    pidByFolder = new Map<string, number>();
  for (const file of files(join(root, "projects"), "log.jsonl")) {
    const folder = dirname(file),
      pid = freebuffOwner(folder),
      loaded = freebuffLoaded(folder);
    if (pid) pidByFolder.set(folder, pid);
    if (!pid || !loaded) continue;
    const owner: FreebuffOwner = {
      pid,
      at: loaded.at,
      ...(loaded.folder ? { folder: loaded.folder } : {}),
      ...(loaded.chatId ? { chatId: loaded.chatId } : {}),
    };
    for (const key of [
      ...(loaded.folder ? ["f:" + freebuffPath(loaded.folder)] : []),
      ...(loaded.chatId ? ["c:" + loaded.chatId] : []),
    ]) {
      const current = byTarget.get(key);
      if (!current || owner.at >= current.at) byTarget.set(key, owner);
    }
    const current = byPid.get(pid);
    if (!current || loaded.at >= current.at) byPid.set(pid, loaded);
  }
  return { byTarget, byPid, pidByFolder };
}
function freebuffHeartbeat(root: string, pid: number, now: number) {
  const file = join(root, "freebuff-live-" + pid + ".json");
  const value = readJSON(file);
  if (value && value.ownerPid !== pid) return undefined;
  try {
    const at = statSync(file).mtimeMs;
    if (now - at > FREEBUFF_HEARTBEAT_WINDOW) return undefined;
    if (value?.expiresAt && value.expiresAt <= now) return undefined;
    return at;
  } catch {
    return undefined;
  }
}
async function opencodeEvidence(file: string, now: number) {
  const result = new Map<
    string,
    { at: number; message: string; level: string }
  >();
  if (!existsSync(file)) return result;
  let seen = 0;
  for await (const row of reverseLines(file)) {
    if (++seen > 800) break;
    const stamp = /(?:^| )timestamp=(\S+)/.exec(row.line)?.[1];
    const at = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(at) && now - at > 15 * 60_000) break;
    if (!row.line.includes("session.id=")) continue;
    const f = logfmt(row.line),
      session = f["session.id"];
    if (!session || !Number.isFinite(at) || result.has(session)) continue;
    result.set(session, { at, message: f.message || "", level: f.level || "" });
  }
  return result;
}
export async function activities(
  sources: Source[],
  chats: Chat[],
  now = Date.now(),
) {
  const result: Record<string, Activity> = {},
    locks = chats
      .filter(
        (c) =>
          c.provider === "codex" &&
          sources.find((s) => s.id === c.sourceId)?.format !== "portable",
      )
      .map((c) => {
        const s = sources.find((s) => s.id === c.sourceId)!;
        return join(s.root, "thread-writer-locks", c.nativeId + ".lock");
      })
      .filter(existsSync),
    held = await probe(locks);
  for (const s of sources) {
    const list = chats.filter((c) => c.sourceId === s.id),
      freebuffInfo =
        !s.imported && s.provider === "freebuff" && list.length
          ? freebuffOwnership(s.root)
          : undefined;
    if (s.imported) {
      for (const c of list)
        if (c.activity)
          result[c.id] = {
            ...c.activity,
            active: false,
            snapshot: true,
            detail: c.activity.snapshot
              ? c.activity.detail
              : "Status recorded in this archive. " + c.activity.detail,
          };
      continue;
    }
    if (s.provider === "opencode" && list.length) {
      const path = join(s.root, "opencode.db");
      if (existsSync(path)) {
        const evidence = await opencodeEvidence(
          join(s.root, "log", "opencode.log"),
          now,
        );
        const db = readDB(path);
        try {
          const ts = tables(db);
          if (ts.has("message"))
            for (const c of list) {
              const last = db
                .prepare(
                  "SELECT * FROM message WHERE session_id=? ORDER BY time_created DESC LIMIT 1",
                )
                .get(c.nativeId) as any;
              if (!last) continue;
              const payload = String(last.data || "");
              let meta: any = {};
              try {
                meta = JSON.parse(payload);
              } catch {}
              let part = "";
              if (ts.has("part")) {
                const row = db
                  .prepare(
                    "SELECT data FROM part WHERE session_id=? ORDER BY time_created DESC LIMIT 1",
                  )
                  .get(c.nativeId);
                part = String(row?.data || "");
              }
              const log = evidence.get(c.nativeId),
                completed = Number(meta.time?.completed) || 0,
                aborted = meta.error?.name === "MessageAbortedError",
                recent = !!log && now - log.at <= OPENCODE_ACTIVE_WINDOW,
                retrying =
                  !!log &&
                  log.message === "stream error" &&
                  now - log.at <= OPENCODE_RETRY_WINDOW;
              const state: Activity["state"] = aborted
                ? "interrupted"
                : meta.error
                  ? "failed"
                  : completed
                    ? "idle"
                    : recent || retrying
                      ? "working"
                      : "unfinished";
              result[c.id] = {
                state,
                active: null,
                revision: hash(
                  [payload, part, completed, log?.at || 0].join(":"),
                ),
                at: completed || last.time_created,
                detail: aborted
                  ? "OpenCode recorded an interrupted response."
                  : meta.error
                    ? "OpenCode recorded an error for this response."
                    : completed
                      ? "OpenCode recorded a completed response."
                      : state === "working"
                        ? retrying
                          ? "OpenCode's activity log recorded a stream error and the provider is still retrying this session."
                          : "OpenCode's activity log shows this session running a step."
                        : "The last response has no completion record and OpenCode's recent activity log is no longer updating this session. OpenCode keeps live status in an authenticated process-local API.",
              };
            }
        } catch {
        } finally {
          db.close();
        }
      }
    }
    if (s.provider === "t3" && list.length) {
      const path = list[0].locator;
      if (existsSync(path)) {
        const db = readDB(path);
        try {
          const ts = tables(db);
          const table = ts.has("orchestration_v2_projection_messages")
            ? "orchestration_v2_projection_messages"
            : "projection_thread_messages";
          if (ts.has(table))
            for (const c of list) {
              const last = db
                .prepare(
                  "SELECT * FROM " +
                    table +
                    " WHERE thread_id=? ORDER BY created_at DESC LIMIT 1",
                )
                .get(c.nativeId) as any;
              if (!last) continue;
              const payload = last.payload_json || last.text || "";
              let meta: any = {};
              try {
                meta = JSON.parse(payload);
              } catch {}
              const errored = !!meta.error;
              result[c.id] = {
                state: errored ? "failed" : "unknown",
                active: null,
                revision: hash(
                  String(payload) +
                    String(last.updated_at || last.created_at),
                ),
                detail: errored
                  ? "The provider recorded an error."
                  : "Live message changes are tracked; this provider does not expose verified per-chat process ownership.",
              };
            }
        } catch {
        } finally {
          db.close();
        }
      }
    }
    if (
      s.provider === "codex" &&
      existsSync(join(s.root, "thread_history_1.sqlite"))
    ) {
      const db = readDB(join(s.root, "thread_history_1.sqlite"));
      try {
        const ts = tables(db),
          cols = ts.has("thread_turns")
            ? columns(db, "thread_turns")
            : new Set();
        if (cols.has("rollout_ordinal")) {
          const turns = db
            .prepare(
              "SELECT t.* FROM thread_turns t JOIN (SELECT thread_id,MAX(rollout_ordinal) n FROM thread_turns GROUP BY thread_id) latest ON latest.thread_id=t.thread_id AND latest.n=t.rollout_ordinal",
            )
            .all() as any[];
          const updated = columns(db, "thread_items").has("updated_at_ordinal");
          for (const c of list) {
            const t = turns.find((t) => t.thread_id === c.nativeId),
              lock = join(s.root, "thread-writer-locks", c.nativeId + ".lock");
            const active =
              held[lock] ??
              (locks.includes(lock) ||
              !existsSync(join(s.root, "thread-writer-locks"))
                ? null
                : false);
            const item = db
              .prepare(
                "SELECT " +
                  (updated ? "updated_at_ordinal" : "rollout_ordinal") +
                  " AS revision FROM thread_items WHERE thread_id=? ORDER BY " +
                  (updated ? "updated_at_ordinal" : "rollout_ordinal") +
                  " DESC LIMIT 1",
              )
              .get(c.nativeId);
            if (t)
              result[c.id] = classifyTurn(
                String(t.status),
                active,
                [t.turn_id, t.status, item?.revision, c.updatedAt].join(":"),
                Number(t.completed_at || t.started_at) || undefined,
              );
          }
        }
      } catch {
      } finally {
        db.close();
      }
    }
    for (const c of list) {
      let fileTime = 0;
      try {
        fileTime = statSync(c.locator).mtimeMs;
      } catch {}
      const revision = String(fileTime || c.updatedAt);
      if (s.provider === "freebuff") {
        const value = readJSON(c.locator),
          body = Array.isArray(value) ? value : [],
          last = [...body]
            .reverse()
            .find((m: any) => ["ai", "user"].includes(m.variant)),
          folder = dirname(c.locator),
          owned =
            freebuffInfo?.byTarget.get("f:" + freebuffPath(folder)) ||
            freebuffInfo?.byTarget.get("c:" + basename(folder)),
          pid = owned?.pid ?? freebuffInfo?.pidByFolder.get(folder),
          beat = pid ? freebuffHeartbeat(s.root, pid, now) : undefined,
          loaded = pid ? freebuffInfo?.byPid.get(pid) : undefined,
          loadedHere =
            !!loaded &&
            !!(
              (loaded.folder &&
                freebuffPath(loaded.folder) === freebuffPath(folder)) ||
              (!loaded.folder && loaded.chatId === basename(folder))
            ),
          active = pid ? (loaded ? (loadedHere ? !!beat : false) : !!beat) : null,
          done = last?.variant === "ai" && last.isComplete === true,
          output = readJSON(join(folder, "run-state.json"))?.output,
          failure = output?.type === "error" ? String(output.message || "") : "";
        const state: Activity["state"] = done
          ? "idle"
          : last && active === true
            ? "working"
            : failure && active !== true
              ? /session ended|interrupt|abort/i.test(failure)
                ? "interrupted"
                : "failed"
              : last && active !== null
                ? "unfinished"
                : "unknown";
        result[c.id] = {
          state,
          active,
          revision: [
            revision,
            pid || "",
            beat ? Math.round(beat) : "",
            last?.id || "",
            loadedHere ? "loaded" : "",
            loaded?.at || "",
          ].join(":"),
          at: beat,
          detail:
            state === "working"
              ? last?.variant === "user"
                ? "The owning CLI process has this chat loaded, its live heartbeat is current, and the latest prompt has no response yet."
                : "Freebuff's live heartbeat for the process with this chat loaded is current, and this response has not been marked complete."
              : state === "idle"
                ? active === true
                  ? "The CLI process has this chat loaded and Freebuff recorded a completed response."
                  : "Freebuff recorded a completed response."
                : state === "interrupted"
                  ? "Freebuff recorded that the response stopped before completing."
                  : state === "failed"
                    ? "Freebuff recorded an error for this response."
                    : state === "unfinished"
                      ? loaded && !loadedHere
                        ? "The last response has no completion record, and the owning CLI process has a different chat loaded."
                        : "The last response has no completion record and the owning CLI process no longer has a live heartbeat."
                      : "No response status is available.",
        };
      } else if (
        !result[c.id] &&
        ["codex", "claude"].includes(s.provider) &&
        existsSync(c.locator)
      ) {
        let state = "";
        for await (const row of reverseLines(c.locator)) {
          let e;
          try {
            e = JSON.parse(row.line);
          } catch {
            continue;
          }
          if (s.provider === "codex" && e.type === "event_msg") {
            state =
              (
                {
                  task_complete: "completed",
                  task_completed: "completed",
                  turn_aborted: "interrupted",
                  task_started: "inProgress",
                } as any
              )[e.payload?.type] || "";
          } else if (s.provider === "claude") {
            if (e.type === "assistant" && e.message?.stop_reason)
              state =
                e.message.stop_reason === "end_turn"
                  ? "completed"
                  : "inProgress";
            if (e.type === "user") state = "inProgress";
          }
          if (state) break;
          if (row.offset < Math.max(0, statSync(c.locator).size - 512 * 1024))
            break;
        }
        const lock = join(s.root, "thread-writer-locks", c.nativeId + ".lock"),
          active =
            c.provider === "codex"
              ? (held[lock] ??
                (existsSync(lock) ||
                !existsSync(join(s.root, "thread-writer-locks"))
                  ? null
                  : false))
              : null;
        result[c.id] = classifyTurn(state, active, revision);
      }
      if (result[c.id] && fileTime) result[c.id].revision += ":" + fileTime;
    }
  }
  return result;
}
