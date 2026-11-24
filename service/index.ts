import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { existsSync, openSync, closeSync, unlinkSync } from "node:fs";
import { stat, readFile, copyFile } from "node:fs/promises";
import { hostname } from "node:os";
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openLibrary, setting, putSetting } from "./db";
import { dataDir, readJSON, atomicJSON, token, alive, hash } from "./common";
import { source, messages, liveSource } from "./adapters";
import { currentActivity } from "./activity";
import {
  displayPath,
  mappedFolder,
  nativeFolder,
  type FolderMapping,
} from "../src/paths";
import { Nearby } from "./nearby";
import { focusPlan } from "./focus";
import { registerImages, loadImage } from "./images";
import { cleanupTask } from "./cleanup";
import { resumePlan, resumeInTerminal, resumeInTermSanity } from "./launch";
import type {
  Chat,
  Source,
  Job,
  Library,
  Activity,
  Preferences,
} from "../src/types";
const dir = dataDir(),
  lock = join(dir, "service.lock");
if (existsSync(lock) && alive(readJSON(lock)?.pid)) process.exit(0);
try {
  if (existsSync(lock)) unlinkSync(lock);
  const fd = openSync(lock, "wx");
  closeSync(fd);
} catch {
  process.exit(0);
}
atomicJSON(lock, { pid: process.pid });
process.on("exit", () => {
  try {
    unlinkSync(lock);
  } catch {}
});
const db = openLibrary(dir),
  secret = token();
let scanning = false,
  scanError: string | undefined,
  updatedAt = 0,
  indexing = false;
const workers = new Map<string, Worker>();
const jobTasks = new Map<string, any>();
let scanPending = false;
let activityBusy = false;
let activityCheckedAt = 0;
let activityState: Record<string, Activity> = {};
const preferences = (): Preferences => ({
  theme: "system",
  liveUpdates: true,
  includeImages: true,
  ...setting(db, "preferences", {}),
});
for (const row of db.prepare("SELECT id,json FROM jobs").all()) {
  const job = JSON.parse(String(row.json));
  if (job.state === "running") {
    job.state = "failed";
    job.error =
      "The service restarted before this transfer completed. The original data is unchanged.";
    db.prepare("UPDATE jobs SET json=? WHERE id=?").run(
      JSON.stringify(job),
      job.id,
    );
  }
}
const getSources = () =>
  db
    .prepare("SELECT json FROM sources")
    .all()
    .map((r) => liveSource(JSON.parse(String(r.json)) as Source));
function getChats(): Chat[] {
  const mappings: FolderMapping[] = setting(db, "folderMappings", []);
  return db
    .prepare(
      "SELECT c.json,p.cwd AS resume_cwd,p.starred FROM chats c LEFT JOIN preferences p ON p.id=c.id ORDER BY updated_at DESC",
    )
    .all()
    .map((r) => {
      const chat = JSON.parse(String(r.json));
      const fallback = r.resume_cwd === "" ? undefined : chat.resumeCwd;
      const mapped = mappedFolder(fallback || chat.cwd, mappings);
      return {
        ...chat,
        cwd: displayPath(chat.cwd),
        ...(activityState[chat.id]
          ? {
              activity: currentActivity(
                activityState[chat.id],
                activityCheckedAt,
              ),
            }
          : {}),
        resumeCwd: mapped.ruleId ? mapped.path : fallback,
        folderMapping: r.resume_cwd ? undefined : mapped.ruleId,
        ...(r.resume_cwd !== null
          ? {
              resumeCwd: r.resume_cwd
                ? displayPath(String(r.resume_cwd))
                : mapped.ruleId
                  ? mapped.path
                  : fallback,
            }
          : {}),
        ...(r.starred !== null ? { starred: !!r.starred } : {}),
      };
    });
}
function updateActivity() {
  if (activityBusy) return;
  const chats = getChats();
  if (!chats.length) return;
  activityBusy = true;
  const w = worker("activity", { sources: getSources(), chats }, (m) => {
    if (m.type === "done") {
      activityState = m.result;
      activityCheckedAt = Date.now();
    }
    if (["done", "failed"].includes(m.type)) {
      activityBusy = false;
      w.terminate();
    }
  });
  w.on("error", () => {
    activityBusy = false;
  });
}
function getChat(id: string) {
  const c = getChats().find((c) => c.id === id);
  if (!c) throw new Error("Conversation is no longer in the library");
  const s = getSources().find((s) => s.id === c.sourceId);
  if (!s) throw new Error("Conversation source is unavailable");
  return { c, s };
}
function jobPut(job: Job) {
  db.prepare(
    "INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
  ).run(job.id, JSON.stringify(job));
}
function worker(type: string, args: any, onMessage: (m: any) => void) {
  const w = new Worker(join(__dirname, "worker.cjs"), {
    workerData: { type, ...args },
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
  w.on("message", onMessage);
  return w;
}
function scan() {
  if (scanning) {
    scanPending = true;
    return;
  }
  scanPending = false;
  scanning = true;
  let settled = false;
  scanError = undefined;
  const w = worker(
    "scan",
    {
      custom: setting(db, "customSources", []),
      home: process.env.CHATPORT_HOME,
    },
    (m) => {
      if (m.type === "done") {
        settled = true;
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const s of m.result.sources) {
            const prior = getSources().find((p) => p.id === s.id);
            if (s.error && prior) s.count = prior.count;
            db.prepare(
              "INSERT INTO sources VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json",
            ).run(s.id, JSON.stringify(s));
            if (s.available && !s.error)
              db.prepare("DELETE FROM chats WHERE source_id=?").run(s.id);
          }
          const put = db.prepare(
            "INSERT INTO chats VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,title=excluded.title,cwd=excluded.cwd,updated_at=excluded.updated_at,json=excluded.json",
          );
          for (const c of m.result.chats)
            put.run(
              c.id,
              c.sourceId,
              c.title,
              c.cwd,
              c.updatedAt,
              JSON.stringify(c),
            );
          db.exec("COMMIT");
          updatedAt = Date.now();
        } catch (e) {
          db.exec("ROLLBACK");
          scanError = String(e);
        }
        scanning = false;
        w.terminate();
        updateActivity();
        if (scanPending) scan();
        else index();
      }
      if (m.type === "failed") {
        settled = true;
        scanning = false;
        scanError = m.error;
        w.terminate();
      }
    },
  );
  w.on("error", (e) => {
    scanError = e.message;
    scanning = false;
  });
  w.on("exit", (code) => {
    if (code && scanning && !settled) {
      scanning = false;
      scanError = "The source scanner stopped unexpectedly";
    }
  });
}
function index() {
  if (indexing) return;
  const versions = new Map(
    db
      .prepare("SELECT * FROM search_versions")
      .all()
      .map((r) => [String(r.chat_id), Number(r.version)]),
  );
  const chats = getChats().filter((c) => versions.get(c.id) !== c.updatedAt);
  if (!chats.length) return;
  indexing = true;
  const w = worker("index", { chats, sources: getSources() }, (m) => {
    if (m.type === "indexed") {
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM chat_search WHERE chat_id=?").run(m.id);
        db.prepare("INSERT INTO chat_search VALUES(?,?)").run(m.id, m.text);
        db.prepare(
          "INSERT INTO search_versions VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET version=excluded.version",
        ).run(m.id, m.version);
        db.exec("COMMIT");
      } catch {
        db.exec("ROLLBACK");
      }
    }
    if (m.type === "done") {
      indexing = false;
      w.terminate();
    }
    if (m.type === "failed") {
      indexing = false;
      w.terminate();
    }
  });
  w.on("error", () => {
    indexing = false;
  });
}
function startJob(type: Job["type"], args: any) {
  const job: Job = {
    id: randomUUID(),
    type,
    state: "running",
    stage:
      type === "export"
        ? "Preparing export"
        : type === "import"
          ? "Opening archive"
          : "Preparing native restore",
    progress: 0,
    createdAt: new Date().toISOString(),
  };
  jobPut(job);
  jobTasks.set(job.id, { ...args, type, jobId: job.id, dataDir: dir });
  const w = worker(type, { ...args, jobId: job.id, dataDir: dir }, (m) => {
    if (m.type === "progress") {
      job.stage = m.stage;
      job.progress = m.progress;
      jobPut(job);
    }
    if (m.type === "failed") {
      job.state = "failed";
      job.error = m.error;
      jobPut(job);
      workers.delete(job.id);
      jobTasks.delete(job.id);
      w.terminate();
    }
    if (m.type === "done") {
      job.state = "completed";
      job.progress = 1;
      job.stage = "Complete";
      job.result = m.result;
      job.path = m.result.path;
      jobPut(job);
      if (type === "import") {
        putSetting(db, "customSources", [
          ...setting(db, "customSources", []),
          ...m.result.sources,
        ]);
        scan();
      }
      if (type === "restore") {
        const all = setting(db, "customSources", []) as Source[];
        putSetting(
          db,
          "customSources",
          all.map((s) =>
            s.id === args.source.id ? { ...s, nativeRoot: m.result.path } : s,
          ),
        );
        const s = getSources().find((s) => s.id === args.source.id);
        if (s) {
          s.nativeRoot = m.result.path;
          db.prepare("UPDATE sources SET json=? WHERE id=?").run(
            JSON.stringify(s),
            s.id,
          );
        }
        scan();
      }
      workers.delete(job.id);
      jobTasks.delete(job.id);
      w.terminate();
    }
  });
  workers.set(job.id, w);
  w.on("error", (e) => {
    job.state = "failed";
    job.error = e.message;
    jobPut(job);
    workers.delete(job.id);
    const task = jobTasks.get(job.id);
    if (task) void cleanupTask(task);
    jobTasks.delete(job.id);
  });
  return job;
}
async function finishedJob(job: Job) {
  while (true) {
    const row = db.prepare("SELECT json FROM jobs WHERE id=?").get(job.id);
    const state: Job = JSON.parse(String(row!.json));
    if (state.state === "completed") return state.result;
    if (state.state !== "running")
      throw new Error(state.error || "Transfer cancelled");
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
const nearby = new Nearby(
  {
    dataDir: dir,
    enabled: setting(db, "nearbyEnabled", true),
    bind: process.env.CHATPORT_NEARBY_BIND,
    discovery: process.env.CHATPORT_NO_DISCOVERY !== "1",
    addresses:
      process.env.CHATPORT_NEARBY_BIND === "127.0.0.1"
        ? ["127.0.0.1"]
        : undefined,
  },
  {
    prepare: async (ids, destination, includeImages) => {
      const chats = getChats().filter((c) => !ids || ids.includes(c.id));
      if (!chats.length) throw new Error("Select at least one conversation");
      return finishedJob(
        startJob("export", {
          destination,
          chats,
          sources: getSources(),
          machine: hostname(),
          includeImages,
        }),
      );
    },
    importFile: async (file, includeImages, sha) => {
      const key = sha + ":" + includeImages;
      const saved = setting(db, "nearbyImportJobs", {});
      if (saved[key]) {
        const row = db
          .prepare("SELECT json FROM jobs WHERE id=?")
          .get(saved[key]);
        if (row) {
          const job: Job = JSON.parse(String(row.json));
          if (job.state === "completed") return job.result;
          if (job.state === "running") return finishedJob(job);
        }
      }
      const job = startJob("import", { file, includeImages });
      putSetting(db, "nearbyImportJobs", { ...saved, [key]: job.id });
      return finishedJob(job);
    },
  },
);
let nearbyError = "";
const nearbyReady = nearby.start().catch((e) => {
  nearbyError = e.message;
});
async function rpc(method: string, p: any) {
  if (method === "focus") {
    const { c, s } = getChat(z.string().parse(p.id));
    return focusPlan(c, s);
  }
  if (method.startsWith("nearby.")) {
    await nearbyReady;
    if (nearbyError) throw new Error(nearbyError);
    if (method === "nearby.status") return nearby.status();
    if (method === "nearby.invite") return nearby.invite();
    if (method === "nearby.refresh") {
      nearby.refresh();
      return true;
    }
    if (method === "nearby.enabled") {
      const enabled = z.boolean().parse(p.enabled);
      await nearby.setEnabled(enabled);
      putSetting(db, "nearbyEnabled", enabled);
      return nearby.status();
    }
    if (method === "nearby.rename") {
      nearby.rename(z.string().parse(p.name));
      return true;
    }
    if (method === "nearby.pair")
      return nearby.pair(
        z.string().max(20000).parse(p.link),
        z.string().optional().parse(p.host),
      );
    if (method === "nearby.forget") {
      nearby.forget(z.string().uuid().parse(p.id));
      return true;
    }
    if (method === "nearby.send")
      return nearby.send(
        z.string().uuid().parse(p.peerId),
        z.array(z.string()).optional().parse(p.ids),
        z.boolean().parse(p.includeImages),
      );
    if (method === "nearby.accept")
      return nearby.accept(
        z.string().uuid().parse(p.id),
        z.boolean().parse(p.includeImages),
      );
    if (method === "nearby.decline") {
      nearby.decline(z.string().uuid().parse(p.id));
      return true;
    }
    if (method === "nearby.retry")
      return nearby.retry(z.string().uuid().parse(p.id));
  }
  if (method === "folders.list")
    return {
      mappings: setting(db, "folderMappings", []),
      platform: process.platform,
    };
  if (method === "folders.save") {
    const mappings = z
      .array(
        z.object({
          id: z.string().uuid(),
          from: z.string().min(1).max(2000),
          to: z.string().min(1).max(2000),
        }),
      )
      .max(100)
      .parse(p.mappings);
    for (const m of mappings) {
      if (
        !nativeFolder(m.to, process.platform) ||
        !(await stat(m.to)).isDirectory()
      )
        throw new Error("Choose an existing local destination folder");
      if (!nativeFolder(m.from, "win32") && !nativeFolder(m.from, "linux"))
        throw new Error("The original path must be absolute");
    }
    putSetting(db, "folderMappings", mappings);
    return true;
  }
  if (method === "library")
    return {
      sources: getSources(),
      chats: getChats(),
      jobs: db
        .prepare("SELECT json FROM jobs ORDER BY rowid DESC LIMIT 30")
        .all()
        .map((r) => JSON.parse(String(r.json))),
      scanning,
      scanError,
      indexing,
      machine: hostname(),
      updatedAt,
      dataDir: dir,
      preferences: preferences(),
    } satisfies Library & { indexing: boolean };
  if (method === "scan") {
    scan();
    return true;
  }
  if (method === "settings.update") {
    const p2 = z
      .object({
        theme: z.enum(["system", "light", "dark"]).optional(),
        liveUpdates: z.boolean().optional(),
        includeImages: z.boolean().optional(),
      })
      .parse(p);
    putSetting(db, "preferences", { ...preferences(), ...p2 });
    return preferences();
  }
  if (method === "image.read" || method === "image.save") {
    const v = z
      .object({
        chatId: z.string(),
        id: z.string(),
        destination: z.string().optional(),
      })
      .parse(p);
    getChat(v.chatId);
    const image = await loadImage(dir, v.chatId, v.id);
    if (method === "image.save") {
      if (!v.destination) throw new Error("Choose a destination file");
      await copyFile(image.path, v.destination);
      return true;
    }
    return {
      mime: image.mime,
      bytes: image.bytes,
      dataUrl: `data:${image.mime};base64,${(await readFile(image.path)).toString("base64")}`,
    };
  }
  if (method === "messages") {
    const v = z
      .object({
        id: z.string(),
        before: z.number().optional(),
        tools: z.boolean().optional(),
      })
      .parse(p);
    const { c, s } = getChat(v.id);
    const page = await messages(s, c, v);
    return { ...page, messages: registerImages(db, c, s, page.messages) };
  }
  if (method === "search") {
    const q = z.string().max(500).parse(p.q).trim();
    if (!q) return [];
    const query = '"' + q.replaceAll('"', '""') + '"';
    const rows = db
      .prepare(
        "SELECT chat_id,snippet(chat_search,1,'','',' … ',18) AS excerpt FROM chat_search WHERE chat_search MATCH ? LIMIT 200",
      )
      .all(query);
    return rows.map((r) => ({ id: r.chat_id, excerpt: r.excerpt }));
  }
  if (method === "preference") {
    const v = z
      .object({
        id: z.string(),
        cwd: z.string().max(2000).optional(),
        starred: z.boolean().optional(),
      })
      .parse(p);
    const { c } = getChat(v.id);
    if (v.cwd && !(await stat(v.cwd)).isDirectory())
      throw new Error("Choose an existing directory");
    const old = db.prepare("SELECT * FROM preferences WHERE id=?").get(v.id);
    db.prepare(
      "INSERT INTO preferences VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd,starred=excluded.starred",
    ).run(
      v.id,
      v.cwd === undefined ? (old?.cwd ?? null) : v.cwd,
      v.starred === undefined
        ? Number(old?.starred ?? c.starred ?? 0)
        : Number(v.starred),
    );
    return true;
  }
  if (method === "source.add") {
    const v = z
      .object({
        provider: z.enum(["codex", "claude", "opencode", "t3", "freebuff"]),
        root: z.string().min(1).max(2000),
      })
      .parse(p);
    const s = source(v.provider, v.root);
    if (!s.available) throw new Error("Source folder does not exist");
    putSetting(db, "customSources", [
      ...setting(db, "customSources", []).filter((p: Source) => p.id !== s.id),
      s,
    ]);
    scan();
    return s;
  }
  if (method === "export") {
    const v = z
      .object({
        destination: z.string().min(1).max(2000),
        ids: z.array(z.string()).optional(),
        includeImages: z.boolean().default(true),
      })
      .parse(p);
    const chats = getChats().filter((c) => !v.ids || v.ids.includes(c.id));
    return startJob("export", {
      destination: resolve(v.destination),
      chats,
      sources: getSources(),
      machine: hostname(),
      includeImages: v.includeImages,
    });
  }
  if (method === "import") {
    const v = z
      .object({
        file: z.string().min(1).max(2000),
        includeImages: z.boolean().default(true),
      })
      .parse(p);
    if (!existsSync(v.file)) throw new Error("Archive file does not exist");
    return startJob("import", {
      file: resolve(v.file),
      includeImages: v.includeImages,
    });
  }
  if (method === "restore") {
    const v = z
      .object({ sourceId: z.string(), target: z.string().min(1).max(2000) })
      .parse(p);
    const s = getSources().find((s) => s.id === v.sourceId);
    if (!s) throw new Error("Source is unavailable");
    return startJob("restore", { source: s, target: resolve(v.target) });
  }
  if (method === "job.cancel") {
    const id = z.string().uuid().parse(p.id),
      w = workers.get(id);
    if (w) {
      const task = jobTasks.get(id);
      if (task?.type === "restore")
        throw new Error(
          "Native profile installation must finish before another operation can change it.",
        );
      await w.terminate();
      workers.delete(id);
      if (task) await cleanupTask(task);
      jobTasks.delete(id);
      const row = db.prepare("SELECT json FROM jobs WHERE id=?").get(id);
      if (row) {
        const job = JSON.parse(String(row.json));
        if (job.state === "running") {
          job.state = "cancelled";
          job.stage = "Cancelled";
          jobPut(job);
        }
      }
    }
    return true;
  }
  if (
    method === "resume.plan" ||
    method === "resume" ||
    method === "termsanity"
  ) {
    const { c, s } = getChat(z.string().parse(p.id));
    return method === "resume.plan"
      ? resumePlan(c, s).display
      : method === "termsanity"
        ? resumeInTermSanity(c, s)
        : resumeInTerminal(c, s);
  }
  if (method === "shutdown") {
    if (
      workers.size ||
      nearby
        .status()
        .transfers.some((t) =>
          ["preparing", "downloading", "importing"].includes(t.state),
        )
    )
      throw new Error("Finish active transfers before restarting ChatPort");
    await nearby.close();
    setTimeout(() => {
      db.close();
      process.exit(0);
    }, 100);
    return true;
  }
  throw new Error("Unknown operation");
}
const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (
    origin &&
    ![
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
      "http://127.0.0.1:1435",
      "http://localhost:1435",
    ].includes(origin)
  ) {
    res.writeHead(403).end();
    return;
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(401).end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.url === "/health") {
      res.end(
        JSON.stringify({
          ok: true,
          version: "0.3.1",
          activeJobs: workers.size,
        }),
      );
      return;
    }
    if (req.url !== "/rpc" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let text = "";
    for await (const data of req) {
      text += data;
      if (text.length > 1024 * 1024) throw new Error("Request is too large");
    }
    const body = JSON.parse(text);
    const result = await rpc(z.string().parse(body.method), body.params || {});
    res.end(JSON.stringify({ result }));
  } catch (e: any) {
    res.writeHead(400).end(JSON.stringify({ error: e.message }));
  }
});
server.listen(0, "127.0.0.1", () => {
  atomicJSON(join(dir, "service.json"), {
    port: (server.address() as any).port,
    token: secret,
    pid: process.pid,
    version: "0.3.1",
  });
  scan();
  setInterval(scan, 15000).unref();
  setInterval(updateActivity, 2000).unref();
});
