import { DatabaseSync, backup } from "node:sqlite";
import {
  mkdir,
  copyFile,
  readFile,
  writeFile,
  readdir,
  stat,
  rename,
  rm,
} from "node:fs/promises";
import { existsSync, createReadStream, createWriteStream } from "node:fs";
import {
  join,
  dirname,
  resolve,
  relative,
  basename,
  isAbsolute,
} from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import yauzl from "yauzl";
import { allMessages, files, listChats, readDB, tables } from "./adapters";
import { hash, inside, readJSON, atomicJSON } from "./common";
import type { Source, Chat } from "../src/types";
import {relativePortable} from '../src/paths';
import { exportImages, imageRefs, materializeImage } from "./images";

async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (e: any) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(e.code) || attempt === 7)
        throw e;
      await new Promise((r) => setTimeout(r, 25 * 2 ** attempt));
    }
  }
}
type Progress = (stage: string, progress: number) => void;
export type Manifest = {
  format: "chatport";
  version: 1;
  createdAt: string;
  machine: string;
  chatCount: number;
  sources: {
    id: string;
    provider: string;
    root: string;
    nativePath?: string;
  }[];
  files: { path: string; size: number; sha256: string }[];
  notes: string[];
};
export async function digest(file: string) {
  const h = createHash("sha256");
  for await (const data of createReadStream(file)) h.update(data);
  return h.digest("hex");
}
export function zipPath(value: string) {
  if (
    !value ||
    value.length > 1800 ||
    value.includes("\\") ||
    value.includes(":") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((p) => p === ".." || p === "." || !p)
  )
    throw new Error("Unsafe path in archive");
  return value;
}
async function snapshot(file: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  const db = readDB(file);
  try {
    await backup(db, target);
  } finally {
    db.close();
  }
}
async function copy(file: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
}
function cleanNative(file: string, ids: Set<string>, provider: string) {
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA journal_mode=DELETE;");
    const ts = tables(db);
    for (const name of ts) {
      if (name.startsWith("sqlite_") || name === "_sqlx_migrations") continue;
      const cols = db
        .prepare('PRAGMA table_info("' + name.replaceAll('"', '""') + '")')
        .all()
        .map((r) => String(r.name));
      if (
        /auth|credential|enrollment|external_agent_config_import|secret|session_token|access_management|pairing/i.test(
          name,
        )
      ) {
        db.exec('DELETE FROM "' + name.replaceAll('"', '""') + '"');
        continue;
      }
      const key = cols.includes("thread_id")
        ? "thread_id"
        : provider === "codex" && name === "threads"
          ? "id"
          : provider === "opencode" && name === "session"
            ? "id"
            : provider === "opencode" && cols.includes("session_id")
              ? "session_id"
              : undefined;
      if (key) {
        db.exec(
          "CREATE TEMP TABLE IF NOT EXISTS chatport_selected(id TEXT PRIMARY KEY)",
        );
        const insert = db.prepare(
          "INSERT OR IGNORE INTO chatport_selected VALUES(?)",
        );
        for (const id of ids) insert.run(id);
        db.exec(
          'DELETE FROM "' +
            name.replaceAll('"', '""') +
            '" WHERE "' +
            key +
            '" NOT IN (SELECT id FROM chatport_selected)',
        );
      }
    }
    db.exec("VACUUM;");
  } finally {
    db.close();
  }
}
export async function exportBundle(
  args: {
    dataDir: string;
    jobId: string;
    destination: string;
    chats: Chat[];
    sources: Source[];
    machine: string;
    includeImages?: boolean;
  },
  progress: Progress,
) {
  const { dataDir, jobId, chats, sources, destination } = args;
  if (!chats.length) throw new Error("Select at least one conversation");
  await mkdir(destination, { recursive: true });
  const staging = join(dataDir, "jobs", jobId);
  await mkdir(staging, { recursive: true });
  const manifest: Manifest = {
    format: "chatport",
    version: 1,
    createdAt: new Date().toISOString(),
    machine: args.machine,
    chatCount: chats.length,
    sources: [],
    files: [],
    notes: [
      "Credentials, API keys, provider configuration and application log files are excluded.",
      "Each SQLite database is captured with its online backup API. Raw transcript files are copied into the staging snapshot.",
      "Project source files are not included. Available image files are optional; native history can already contain embedded images.",
    ],
  };
  const catalog: any[] = [];
  let finished = 0;
  for (const s of sources.filter((s) =>
    chats.some((c) => c.sourceId === s.id),
  )) {
    const selected = chats.filter((c) => c.sourceId === s.id),
      ids = new Set(selected.map((c) => c.nativeId)),
      nativeRel = "native/" + s.id,
      nativeRoot = join(staging, nativeRel);
    const fullSource = selected.length === listChats(s).length;
    const omitNative = s.provider === "t3" && !fullSource;
    if (omitNative)
      manifest.notes.push(
        "Partial T3 exports include the selected readable conversations. A native T3 database is included only when exporting its whole source.",
      );
    if (!fullSource)
      manifest.notes.push(
        "Shared provider attachment folders are omitted for partial-source exports. Native snapshots can include shared project metadata.",
      );
    await mkdir(nativeRoot, { recursive: true });
    if (s.format !== "portable" && !omitNative) {
      const names =
        s.provider === "codex"
          ? [
              "state_5.sqlite",
              "thread_history_1.sqlite",
              "queue_1.sqlite",
              "goals_1.sqlite",
            ]
          : s.provider === "opencode"
            ? ["opencode.db"]
            : s.provider === "t3"
              ? ["statev2.sqlite", "state.sqlite"]
              : [];
      for (const name of names) {
        const file = join(s.root, name);
        if (!existsSync(file)) continue;
        progress(
          "Snapshotting " + s.name + " · " + name,
          0.04 + (finished / chats.length) * 0.65,
        );
        await snapshot(file, join(nativeRoot, name));
        cleanNative(join(nativeRoot, name), ids, s.provider);
      }
      if (s.provider === "codex" || s.provider === "claude")
        for (const c of selected) {
          if (
            existsSync(c.locator) &&
            inside(s.root, c.locator) &&
            c.locator.endsWith(".jsonl")
          )
            await copy(
              c.locator,
              join(nativeRoot, relative(s.root, c.locator)),
            );
        }
      if (s.provider === "freebuff")
        for (const c of selected)
          for (const name of [
            "chat-messages.json",
            "chat-meta.json",
            "run-state.json",
          ]) {
            const file = join(dirname(c.locator), name);
            if (existsSync(file) && inside(s.root, file))
              await copy(file, join(nativeRoot, relative(s.root, file)));
          }
      const folders =
        s.provider === "t3"
          ? ["attachments"]
          : s.provider === "codex"
            ? ["attachments"]
            : [];
      for (const folder of fullSource && args.includeImages !== false
        ? folders
        : [])
        for (const file of files(join(s.root, folder), ""))
          await copy(file, join(nativeRoot, relative(s.root, file)));
    } else if (s.format === "portable" && s.archiveNativePath && !omitNative) {
      const original = join(s.root, zipPath(s.archiveNativePath));
      if (!inside(s.root, original))
        throw new Error("Invalid native archive location");
      for (const file of files(original, "")) {
        const rel = relative(original, file),
          target = join(nativeRoot, rel);
        if (
          (!fullSource || args.includeImages === false) &&
          rel.split(/[/\\]/)[0] === "attachments"
        )
          continue;
        if (
          !fullSource &&
          s.provider === "freebuff" &&
          file.endsWith(".json") &&
          !ids.has(
            hash(relative(original, dirname(file)).replaceAll("\\", "/")).slice(
              0,
              32,
            ),
          )
        )
          continue;
        if (
          !fullSource &&
          file.endsWith(".jsonl") &&
          ![...ids].some((id) => basename(file).includes(id))
        )
          continue;
        if (
          !fullSource &&
          s.provider === "chatgpt" &&
          basename(file) === "conversations.json"
        ) {
          const input = JSON.parse(await readFile(file, "utf8"));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(
            target,
            JSON.stringify(
              input.filter((c: any) =>
                ids.has(
                  String(
                    c.conversation_id ||
                      c.id ||
                      hash(JSON.stringify(c)).slice(0, 32),
                  ),
                ),
              ),
            ),
          );
        } else {
          await copy(file, target);
          if (/\.(sqlite|db)$/.test(file)) cleanNative(target, ids, s.provider);
        }
      }
    }
    manifest.sources.push({
      id: s.id,
      provider: s.provider,
      root: s.originalRoot || s.root,
      nativePath: omitNative ? undefined : nativeRel,
    });
    for (const c of selected) {
      const normalizedPath = "conversations/" + hash(c.id) + ".json";
      const view =
        s.format === "portable" || omitNative ? s : { ...s, root: nativeRoot };
      const viewChat =
        s.format === "portable" || omitNative
          ? c
          : {
              ...c,
              locator: inside(s.root, c.locator)
                ? join(nativeRoot, relative(s.root, c.locator))
                : c.locator,
            };
      const body = await allMessages(view, viewChat);
      const imageResult = await exportImages(
        dataDir,
        staging,
        s,
        c,
        body,
        args.includeImages !== false,
      );
      if (imageResult.missing)
        manifest.notes.push(
          `${imageResult.missing} image attachment(s) could not be recovered for conversation ${c.nativeId}.`,
        );
      await mkdir(join(staging, "conversations"), { recursive: true });
      await writeFile(
        join(staging, normalizedPath),
        JSON.stringify({ chat: c, messages: body }),
      );
      catalog.push({ ...c, normalizedPath });
      finished++;
      progress(
        "Saving conversations · " + finished + " of " + chats.length,
        0.05 + (finished / chats.length) * 0.65,
      );
    }
  }
  await writeFile(
    join(staging, "catalog.json"),
    JSON.stringify({ version: 1, chats: catalog }),
  );
  const all = [...files(staging, "")];
  for (let i = 0; i < all.length; i++) {
    const file = all[i],
      rel = relative(staging, file).replaceAll("\\", "/");
    manifest.files.push({
      path: rel,
      size: (await stat(file)).size,
      sha256: await digest(file),
    });
    progress(
      "Verifying snapshot · " + (i + 1) + " of " + all.length,
      0.7 + ((i + 1) / all.length) * 0.14,
    );
  }
  await writeFile(
    join(staging, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  const filename =
    "ChatPort-" +
    new Date().toISOString().replace(/[:.]/g, "-") +
    "-" +
    jobId +
    ".chatport.zip";
  const target = join(resolve(destination), filename),
    partial = target + ".partial";
  progress("Writing portable archive", 0.86);
  const zip = new yazl.ZipFile();
  const zipOptions = { compress: true, compressionLevel: 1 };
  zip.addFile(join(staging, "manifest.json"), "manifest.json", zipOptions);
  for (const item of manifest.files)
    zip.addFile(join(staging, item.path), item.path, zipOptions);
  zip.end();
  let written = 0,
    lastProgress = 0;
  zip.outputStream.on("data", (chunk: Buffer) => {
    written += chunk.length;
    if (Date.now() - lastProgress > 300) {
      lastProgress = Date.now();
      progress(
        "Writing archive · " +
          Math.round(written / 1048576).toLocaleString() +
          " MB",
        0.86,
      );
    }
  });
  await pipeline(zip.outputStream, createWriteStream(partial, { flags: "wx" }));
  await renameWithRetry(partial, target);
  progress("Calculating final archive checksum", 0.99);
  return {
    path: target,
    chatCount: chats.length,
    files: manifest.files.length,
    bytes: (await stat(target)).size,
    sha256: await digest(target),
    notes: manifest.notes,
  };
}
async function unpack(file: string, destination: string, progress: Progress) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (e, z) => (e || !z ? reject(e || new Error("Invalid ZIP")) : resolve(z)),
    ),
  );
  let total = 0,
    count = 0;
  const names = new Set<string>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        void (async () => {
          if (entry.fileName.endsWith("/")) {
            zipPath(entry.fileName.slice(0, -1));
            zip.readEntry();
            return;
          }
          const name = zipPath(entry.fileName);
          if (names.has(name)) throw new Error("Duplicate archive entry");
          names.add(name);
          count++;
          total += entry.uncompressedSize;
          if (
            count > 100000 ||
            total > 50 * 1024 ** 3 ||
            entry.uncompressedSize > 10 * 1024 ** 3
          )
            throw new Error("Archive exceeds supported size limits");
          if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000)
            throw new Error("Archive symbolic links are not supported");
          const target = join(destination, name);
          if (!inside(destination, target))
            throw new Error("Archive path leaves its destination");
          await mkdir(dirname(target), { recursive: true });
          const stream = await new Promise<NodeJS.ReadableStream>(
            (resolve, reject) =>
              zip.openReadStream(entry, (e, s) =>
                e || !s
                  ? reject(e || new Error("Unreadable archive entry"))
                  : resolve(s),
              ),
          );
          await pipeline(stream, createWriteStream(target, { flags: "wx" }));
          progress(
            "Reading archive · " + count + " files",
            Math.min(0.55, 0.05 + count * 0.003),
          );
          zip.readEntry();
        })().catch((e) => {
          zip.close();
          reject(e);
        });
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return names;
}
export async function importBundle(
  args: {
    dataDir: string;
    jobId: string;
    file: string;
    includeImages?: boolean;
  },
  progress: Progress,
) {
  const { dataDir, jobId, file } = args,
    staging = join(dataDir, "imports", jobId + ".partial"),
    target = join(dataDir, "imports", jobId);
  await mkdir(staging, { recursive: true });
  const names = file.toLowerCase().endsWith(".json")
    ? new Set<string>()
    : await unpack(file, staging, progress);
  if (file.toLowerCase().endsWith(".json")) {
    await copy(file, join(staging, "conversations.json"));
    names.add("conversations.json");
  }
  if (
    !names.has("manifest.json") &&
    [...names].some((n) => n === "conversations.json")
  )
    return importChatGPT(
      staging,
      target,
      file,
      jobId,
      progress,
      args.includeImages !== false,
    );
  const manifest = readJSON(join(staging, "manifest.json")) as Manifest;
  if (
    manifest?.format !== "chatport" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.sources)
  )
    throw new Error("This is not a supported ChatPort conversation archive");
  if (manifest.files.length > 100000)
    throw new Error("Archive manifest is too large");
  const providers = [
    "codex",
    "claude",
    "opencode",
    "t3",
    "chatgpt",
    "freebuff",
  ];
  if (
    manifest.sources.some(
      (s) =>
        !providers.includes(s.provider) ||
        typeof s.id !== "string" ||
        typeof s.root !== "string" ||
        (s.nativePath && typeof s.nativePath !== "string"),
    )
  )
    throw new Error("Invalid source in archive");
  if (
    new Set(manifest.sources.map((s) => s.id)).size !== manifest.sources.length
  )
    throw new Error("Duplicate source in archive");
  for (const s of manifest.sources) if (s.nativePath) zipPath(s.nativePath);
  const expected = new Set(["manifest.json"]);
  for (let i = 0; i < manifest.files.length; i++) {
    const f = manifest.files[i];
    zipPath(f.path);
    if (expected.has(f.path)) throw new Error("Duplicate manifest file");
    expected.add(f.path);
    const path = join(staging, f.path);
    if (
      !names.has(f.path) ||
      !inside(staging, path) ||
      (await stat(path)).size !== f.size ||
      (await digest(path)) !== f.sha256
    )
      throw new Error("Archive checksum verification failed: " + f.path);
    progress(
      "Checking integrity · " + (i + 1) + " of " + manifest.files.length,
      0.55 + ((i + 1) / manifest.files.length) * 0.4,
    );
  }
  for (const n of names)
    if (!expected.has(n))
      throw new Error("Archive contains an unlisted file: " + n);
  const catalog = readJSON(join(staging, "catalog.json"));
  if (
    !Array.isArray(catalog?.chats) ||
    catalog.chats.length !== manifest.chatCount
  )
    throw new Error("Archive conversation catalog is incomplete");
  for (const c of catalog.chats) {
    if (
      !["codex", "claude", "opencode", "t3", "chatgpt", "freebuff"].includes(
        c.provider,
      ) ||
      typeof c.nativeId !== "string" ||
      typeof c.title !== "string" ||
      typeof c.cwd !== "string" ||
      !Number.isFinite(c.createdAt) ||
      !Number.isFinite(c.updatedAt) ||
      (c.resumeCwd !== undefined && typeof c.resumeCwd !== "string") ||
      (c.model !== undefined && typeof c.model !== "string") ||
      !manifest.sources.some(
        (s) => s.id === c.sourceId && s.provider === c.provider,
      ) ||
      !expected.has(c.normalizedPath)
    )
      throw new Error("Invalid conversation in archive");
    const body = readJSON(join(staging, zipPath(c.normalizedPath)));
    if (
      !Array.isArray(body?.messages) ||
      body.messages.some(
        (m: any) =>
          !m ||
          typeof m.id !== "string" ||
          !["user", "assistant", "tool", "system"].includes(m.role) ||
          typeof m.text !== "string" ||
          (m.at !== undefined && !Number.isFinite(m.at)),
      )
    )
      throw new Error("Invalid message data in archive");
    for (const m of body.messages)
      for (const a of m.attachments || []) {
        if (
          typeof a.id !== "string" ||
          typeof a.name !== "string" ||
          typeof a.mime !== "string" ||
          a.ref
        )
          throw new Error("Invalid image reference in archive");
        if (
          a.archivePath &&
          (!expected.has(zipPath(a.archivePath)) ||
            !a.archivePath.startsWith("attachments/"))
        )
          throw new Error("Image is missing from the archive manifest");
        if (args.includeImages === false) {
          delete a.archivePath;
          a.available = false;
          a.recoverable = false;
          a.missing = "Image files were omitted during import.";
        }
      }
    if (args.includeImages === false)
      await writeFile(join(staging, c.normalizedPath), JSON.stringify(body));
  }
  if (args.includeImages === false) {
    for (const f of manifest.files.filter(
      (f) =>
        f.path.startsWith("attachments/") ||
        /^native\/[^/]+\/attachments\//.test(f.path),
    ))
      await rm(join(staging, f.path), { force: true });
    manifest.files = manifest.files.filter(
      (f) =>
        !(
          f.path.startsWith("attachments/") ||
          /^native\/[^/]+\/attachments\//.test(f.path)
        ),
    );
    for (const f of manifest.files.filter((f) =>
      f.path.startsWith("conversations/"),
    )) {
      f.size = (await stat(join(staging, f.path))).size;
      f.sha256 = await digest(join(staging, f.path));
    }
    manifest.notes.push(
      "Portable image files were omitted during import. Native history may retain embedded images.",
    );
    await writeFile(
      join(staging, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }
  await renameWithRetry(staging, target);
  const sources: Source[] = manifest.sources.map((original) => ({
    id: hash(jobId + original.id).slice(0, 24),
    provider: original.provider as Source["provider"],
    name:
      "Imported " +
      {
        codex: "Codex",
        claude: "Claude Code",
        opencode: "OpenCode",
        t3: "T3 Code",
        chatgpt: "ChatGPT",
        freebuff: "Freebuff",
      }[original.provider as Source["provider"]],
    root: target,
    available: true,
    imported: true,
    format: "portable" as const,
    count: catalog.chats.filter((c: any) => c.sourceId === original.id).length,
    originalSourceId: original.id,
    originalRoot: original.root,
    archiveNativePath: original.nativePath,
    imagesIncluded: args.includeImages !== false,
  }));
  progress("Import complete", 1);
  return {
    path: target,
    chatCount: manifest.chatCount,
    sources,
    notes: manifest.notes,
  };
}
async function importChatGPT(
  stage: string,
  target: string,
  file: string,
  jobId: string,
  progress: Progress,
  includeImages = true,
) {
  const input = JSON.parse(
    await readFile(join(stage, "conversations.json"), "utf8"),
  );
  if (
    !Array.isArray(input) ||
    !input.every((c) => c && typeof c === "object" && c.mapping)
  )
    throw new Error("The JSON file is not a ChatGPT conversation export");
  const native = "native/chatgpt-export";
  await mkdir(join(stage, native), { recursive: true });
  await copy(
    join(stage, "conversations.json"),
    join(stage, native, "conversations.json"),
  );
  await mkdir(join(stage, "conversations"), { recursive: true });
  const catalog: any[] = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i],
      nativeId = String(
        c.conversation_id || c.id || hash(JSON.stringify(c)).slice(0, 32),
      );
    const chain: any[] = [];
    let node = c.current_node;
    const seen = new Set<string>();
    while (node && c.mapping[node] && !seen.has(node)) {
      seen.add(node);
      chain.unshift(c.mapping[node]);
      node = c.mapping[node].parent;
    }
    const rows = chain.length ? chain : Object.values(c.mapping);
    const body: any[] = rows
      .filter(
        (n: any) =>
          n.message &&
          ["user", "assistant", "system"].includes(n.message.author?.role),
      )
      .map((n: any) => ({
        id: String(n.id || n.message.id),
        role: n.message.author.role,
        text: (n.message.content?.parts || [])
          .map((p: any) =>
            typeof p === "string"
              ? p
              : p?.content_type === "image_asset_pointer"
                ? "[Image attachment]"
                : "",
          )
          .filter(Boolean)
          .join("\n"),
        at: Number(n.message.create_time || 0) * 1000,
      }))
      .filter((m: any) => m.text);
    const imageFiles = [...files(stage, "")].filter((p) =>
      /\.(png|jpe?g|gif|webp|bmp)$/i.test(p),
    );
    for (const node of rows as any[]) {
      const message = body.find(
        (m) => m.id === String(node.id || node.message?.id),
      );
      if (!message) continue;
      const parts = node.message?.content?.parts || [];
      const attachments = [];
      for (const p of parts) {
        if (p?.content_type !== "image_asset_pointer") continue;
        const id = String(p.asset_pointer || "")
          .replace(/^file-service:\/\//, "")
          .split("/")[0];
        const matches = id
          ? imageFiles.filter((file) => basename(file).startsWith(id))
          : [];
        const a: any = {
          id: hash(
            nativeId + ":" + message.id + ":" + attachments.length,
          ).slice(0, 32),
          name:
            matches.length === 1 ? basename(matches[0]) : "Image attachment",
          mime: "image/png",
          available: false,
          missing: includeImages
            ? "The export does not contain this image file."
            : "Image files were omitted during import.",
        };
        if (includeImages && matches.length === 1) {
          try {
            const image = await materializeImage(stage, {
              ...a,
              ref: { path: matches[0] },
            });
            a.archivePath = "attachments/" + basename(image.path);
            a.mime = image.mime;
            a.bytes = image.bytes;
            a.available = true;
            delete a.missing;
            await mkdir(join(stage, "attachments"), { recursive: true });
            await copy(image.path, join(stage, a.archivePath));
          } catch {}
        }
        attachments.push(a);
      }
      if (attachments.length) message.attachments = attachments;
    }
    const normalizedPath = "conversations/" + hash(nativeId) + ".json";
    const chat: Chat = {
      id: "chatgpt-export:" + nativeId,
      sourceId: "chatgpt-export",
      provider: "chatgpt",
      nativeId,
      title: c.title || "Untitled conversation",
      cwd: "",
      createdAt: Number(c.create_time || 0) * 1000,
      updatedAt: Number(c.update_time || 0) * 1000,
      archived: !!c.is_archived,
      locator: "",
      imported: true,
    };
    await writeFile(
      join(stage, normalizedPath),
      JSON.stringify({ chat, messages: body }),
    );
    catalog.push({ ...chat, normalizedPath });
    progress(
      "Importing ChatGPT · " + (i + 1) + " of " + input.length,
      0.3 + ((i + 1) / Math.max(1, input.length)) * 0.5,
    );
  }
  // Keep only the selected conversation export and normalized messages; account profile files are omitted.
  await writeFile(
    join(stage, "catalog.json"),
    JSON.stringify({ version: 1, chats: catalog }),
  );
  const keep = [
    "catalog.json",
    ...catalog.map((c) => c.normalizedPath),
    native + "/conversations.json",
    ...[...files(join(stage, "attachments"), "")].map((f) =>
      relative(stage, f).replaceAll("\\", "/"),
    ),
  ];
  const manifest: Manifest = {
    format: "chatport",
    version: 1,
    createdAt: new Date().toISOString(),
    machine: "ChatGPT export",
    chatCount: catalog.length,
    sources: [
      {
        id: "chatgpt-export",
        provider: "chatgpt",
        root: dirname(file),
        nativePath: native,
      },
    ],
    files: [],
    notes: [
      "Imported from a user-provided ChatGPT data export.",
      "The active branch is shown in the reader; the original JSON retains all exported branches.",
      "Image files present in the supplied export are matched by their attachment IDs; unavailable files remain marked missing.",
    ],
  };
  for (const path of keep)
    manifest.files.push({
      path,
      size: (await stat(join(stage, path))).size,
      sha256: await digest(join(stage, path)),
    });
  for (const f of files(stage, ""))
    if (!keep.includes(relative(stage, f).replaceAll("\\", "/"))) await rm(f);
  await writeFile(
    join(stage, "manifest.json"),
    JSON.stringify(manifest, null, 2),
  );
  await renameWithRetry(stage, target);
  const s: Source = {
    id: hash(jobId + "chatgpt").slice(0, 24),
    provider: "chatgpt",
    name: "Imported ChatGPT",
    root: target,
    available: true,
    imported: true,
    format: "portable",
    originalSourceId: "chatgpt-export",
    originalRoot: dirname(file),
    archiveNativePath: native,
    count: catalog.length,
  };
  progress("ChatGPT import complete", 1);
  return {
    path: target,
    chatCount: catalog.length,
    sources: [s],
    notes: manifest.notes,
  };
}
export async function restoreCodex(
  args: { dataDir: string; source: Source; target: string; jobId: string },
  progress: Progress,
) {
  const { source, target, dataDir, jobId } = args;
  if (!source.imported)
    throw new Error("Choose an imported Codex archive to restore");
  const manifest = readJSON(join(source.root, "manifest.json")) as Manifest;
  const native = manifest.sources.filter(
    (s) =>
      s.provider === "codex" &&
      s.nativePath &&
      s.id === source.originalSourceId,
  );
  if (native.length !== 1)
    throw new Error("This archive has no matching native Codex source");
  const original = join(source.root, zipPath(native[0].nativePath!));
  if (!inside(source.root, original))
    throw new Error("Invalid native source path");
  if (!existsSync(join(original, "state_5.sqlite")))
    throw new Error("This archive has no native Codex database");
  const absolute = resolve(target);
  if (
    inside(source.root, absolute) ||
    inside(absolute, source.root) ||
    inside(dataDir, absolute)
  )
    throw new Error("Choose a separate provider profile folder");
  await mkdir(absolute, { recursive: true });
  const entries = await readdir(absolute);
  if (entries.some((n) => !["auth.json", "config.toml"].includes(n)))
    throw new Error(
      "Restore requires an empty profile folder (existing auth.json and config.toml may remain). Existing conversations are never replaced.",
    );
  const stage = join(dataDir, "jobs", jobId, "profile");
  await mkdir(stage, { recursive: true });
  const list = [...files(original, "")];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    await copy(f, join(stage, relative(original, f)));
    progress(
      "Preparing native Codex profile",
      0.1 + ((i + 1) / list.length) * 0.55,
    );
  }
  const db = new DatabaseSync(join(stage, "state_5.sqlite"));
  try {
    const oldRoot = native[0].root;
    for (const r of db.prepare("SELECT id,rollout_path FROM threads").all()) {
      const path = String(r.rollout_path || "");
      const rel = relativePortable(oldRoot,path);
      if (rel && !rel.includes(".."))
        db.prepare("UPDATE threads SET rollout_path=? WHERE id=?").run(
          join(absolute, ...rel.split('/')),
          r.id,
        );
    }
  } finally {
    db.close();
  }
  // Install only into a reviewed empty destination, retaining any login/config already there.
  const created: string[] = [];
  try {
    for (const f of files(stage, "")) {
      const dest = join(absolute, relative(stage, f));
      if (!inside(absolute, dest) || existsSync(dest))
        throw new Error("A file appeared in the destination; restore stopped");
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(f, dest, 1);
      created.push(dest);
    }
  } catch (e) {
    for (const f of created.reverse()) await rm(f, { force: true });
    throw e;
  }
  progress("Native profile restored", 1);
  return {
    path: absolute,
    provider: "codex",
    chatCount: manifest.chatCount,
    notes: [
      "Use this folder as CODEX_HOME, then sign in on the destination machine if needed.",
      "Original conversation IDs are retained. Working-folder overrides can be set in ChatPort before resuming.",
    ],
  };
}
