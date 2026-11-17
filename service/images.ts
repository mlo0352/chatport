import { basename, join, dirname, resolve } from "node:path";
import { existsSync, statSync, createReadStream } from "node:fs";
import {
  readFile,
  writeFile,
  mkdir,
  copyFile,
  rename,
  rm,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { hash, inside } from "./common";
import type { Attachment, Chat, Message, Source } from "../src/types";
import { displayPath } from "../src/paths";
const mimeExt: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
export const imageTextKey = (text: string) =>
  hash(text.replaceAll("\r\n", "\n").trim());
export function imageRefs(
  content: any,
  identity: string,
  extra: Partial<NonNullable<Attachment["ref"]>> = {},
): Attachment[] {
  const result: Attachment[] = [];
  function walk(v: any) {
    if (!v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const p of v) walk(p);
      return;
    }
    const type = String(v.type || "");
    let path: string | undefined,
      dataUrl: string | undefined,
      mime: string | undefined;
    if (/image|file/i.test(type) || v.mime?.startsWith("image/")) {
      path = v.path || v.filePath;
      if (typeof v.url === "string" && v.url.startsWith("file:")) {
        try {
          path = fileURLToPath(v.url);
        } catch {}
      }
      const url = v.image_url?.url || v.image_url || v.url || v.image;
      if (typeof url === "string" && url.startsWith("data:image/"))
        dataUrl = url;
      if (
        v.source?.type === "base64" &&
        v.source.media_type?.startsWith("image/")
      )
        dataUrl = `data:${v.source.media_type};base64,${v.source.data}`;
      mime = v.mime || v.media_type || v.source?.media_type;
    }
    if (path || dataUrl) {
      if (path) path = displayPath(String(path));
      mime =
        mime ||
        dataUrl?.match(/^data:([^;]+);base64,/)?.[1] ||
        (
          {
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".gif": "image/gif",
            ".webp": "image/webp",
            ".bmp": "image/bmp",
          } as any
        )[path?.slice(path.lastIndexOf(".")).toLowerCase() || ""];
      if (mime && mimeExt[mime]) {
        const index = result.length;
        result.push({
          id: hash(identity + ":" + index).slice(0, 32),
          name: path ? basename(path) : `Image ${index + 1}.${mimeExt[mime]}`,
          mime,
          available: !!dataUrl || !!(path && existsSync(path)),
          recoverable: !!extra.transcript,
          ref: { path, dataUrl, ...extra, imageIndex: index },
        });
      }
      return;
    }
    if (v.content) walk(v.content);
    if (v.blocks) walk(v.blocks);
  }
  walk(content);
  return result;
}
function cacheDB(dataDir: string) {
  const db = new DatabaseSync(join(dataDir, "library.sqlite"));
  db.exec(
    "PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS attachment_refs(chat_id TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(chat_id,id));",
  );
  return db;
}
export function registerImages(
  db: DatabaseSync,
  chat: Chat,
  source: Source,
  messages: Message[],
) {
  const put = db.prepare(
    "INSERT INTO attachment_refs VALUES(?,?,?) ON CONFLICT(chat_id,id) DO UPDATE SET json=excluded.json",
  );
  return messages.map((m) => ({
    ...m,
    attachments: m.attachments?.map((a) => {
      const old = db
        .prepare("SELECT json FROM attachment_refs WHERE chat_id=? AND id=?")
        .get(chat.id, a.id);
      const prior = old ? JSON.parse(String(old.json)) : {};
      const value = {
        ...a,
        ...(prior.cachedPath
          ? {
              cachedPath: prior.cachedPath,
              available: existsSync(prior.cachedPath),
            }
          : {}),
        ...(a.archivePath ? { archiveRoot: source.root } : {}),
        ...(source.imagesIncluded === false
          ? {
              available: false,
              missing: "Image files were omitted during import.",
              ref: undefined,
              archivePath: undefined,
              cachedPath: undefined,
            }
          : {}),
      };
      if (source.format === "portable" && value.ref) {
        value.ref = {
          ...value.ref,
          path: undefined,
          ...(value.ref.transcript && !inside(source.root, value.ref.transcript)
            ? { transcript: undefined }
            : {}),
        };
      }
      put.run(chat.id, a.id, JSON.stringify(value));
      const { ref, ...publicValue } = value;
      delete publicValue.cachedPath;
      delete publicValue.archiveRoot;
      return publicValue as Attachment;
    }),
  }));
}
function imageMime(bytes: Buffer) {
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return "image/jpeg";
  if (
    bytes
      .subarray(0, 6)
      .toString()
      .match(/^GIF8[79]a$/)
  )
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(0, 2).toString() === "BM") return "image/bmp";
  return undefined;
}
async function recover(a: Attachment) {
  const ref = a.ref;
  if (!ref?.transcript || !existsSync(ref.transcript)) return;
  const start = Math.max(0, ref.offset || 0),
    end =
      ref.end && ref.end > start
        ? Math.min(ref.end - 1, start + 64 * 1024 * 1024)
        : undefined;
  const stream = createReadStream(ref.transcript, {
    start,
    ...(end ? { end } : {}),
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0,
    started = false;
  const candidates: string[] = [],
    exact: string[] = [];
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > 256 * 1024 * 1024) break;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.type === "event_msg" && e.payload?.type === "task_started") {
        if (started) break;
        started = true;
      }
      if (
        e.type !== "response_item" ||
        e.payload?.type !== "message" ||
        e.payload?.role !== "user"
      )
        continue;
      const content = e.payload.content || [],
        text = content
          .filter((p: any) => ["input_text", "text"].includes(p.type))
          .map((p: any) => p.text || "")
          .join("\n");
      const found = imageRefs(content, "recovery")[ref.imageIndex || 0]?.ref
        ?.dataUrl;
      if (!found) continue;
      candidates.push(found);
      if (ref.textKey && imageTextKey(text) === ref.textKey) exact.push(found);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  // Match the exact prompt, or a single image-bearing user record within a known native turn.
  if (exact.length === 1) return exact[0];
  if (!exact.length && ref.offset !== undefined && candidates.length === 1)
    return candidates[0];
}
export async function materializeImage(
  dataDir: string,
  a: Attachment,
): Promise<{ path: string; mime: string; bytes: number }> {
  const internal = a as any;
  if (
    internal.cachedPath &&
    inside(join(dataDir, "assets"), internal.cachedPath) &&
    existsSync(internal.cachedPath)
  ) {
    const cached = await readFile(internal.cachedPath).catch(() => undefined);
    if (
      cached &&
      imageMime(cached) &&
      basename(internal.cachedPath).startsWith(
        createHash("sha256").update(cached).digest("hex") + ".",
      )
    )
      return {
        path: internal.cachedPath,
        mime: imageMime(cached)!,
        bytes: cached.length,
      };
  }
  let data: Buffer | undefined;
  if (a.archivePath && internal.archiveRoot) {
    const p = resolve(internal.archiveRoot, a.archivePath);
    if (!inside(internal.archiveRoot, p))
      throw new Error("Image points outside its archive");
    if (existsSync(p) && statSync(p).size <= 64 * 1024 * 1024)
      data = await readFile(p);
  }
  let url = a.ref?.dataUrl;
  if (
    !data &&
    a.ref?.path &&
    existsSync(a.ref.path) &&
    statSync(a.ref.path).size <= 64 * 1024 * 1024
  )
    data = await readFile(a.ref.path);
  if (!data && !url) url = await recover(a);
  if (!data && url) {
    const match = url.match(
      /^data:(image\/[a-zA-Z]+);base64,([a-zA-Z0-9+/=\r\n]+)$/,
    );
    if (match && match[2].length <= 90 * 1024 * 1024)
      data = Buffer.from(match[2], "base64");
  }
  if (!data)
    throw new Error(
      a.missing ||
        "The original image is missing and no matching embedded image could be recovered.",
    );
  const mime = imageMime(data);
  if (!mime) throw new Error("This attachment is not a supported image file");
  const sha = createHash("sha256").update(data).digest("hex"),
    file = join(dataDir, "assets", sha + "." + mimeExt[mime]);
  await mkdir(dirname(file), { recursive: true });
  const existing = existsSync(file)
    ? await readFile(file).catch(() => undefined)
    : undefined;
  if (
    !existing ||
    createHash("sha256").update(existing).digest("hex") !== sha
  ) {
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, data, { flag: "wx", flush: true });
      try {
        await rename(temporary, file);
      } catch (e) {
        const completed = await readFile(file).catch(() => undefined);
        if (
          !completed ||
          createHash("sha256").update(completed).digest("hex") !== sha
        )
          throw e;
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }
  return { path: file, mime, bytes: data.length };
}
export async function loadImage(dataDir: string, chatId: string, id: string) {
  const db = cacheDB(dataDir);
  try {
    const row = db
      .prepare("SELECT json FROM attachment_refs WHERE chat_id=? AND id=?")
      .get(chatId, id);
    if (!row)
      throw new Error("This image is not registered to this conversation");
    const a = JSON.parse(String(row.json));
    const image = await materializeImage(dataDir, a);
    db.prepare(
      "UPDATE attachment_refs SET json=? WHERE chat_id=? AND id=?",
    ).run(
      JSON.stringify({
        ...a,
        cachedPath: image.path,
        available: true,
        mime: image.mime,
        bytes: image.bytes,
      }),
      chatId,
      id,
    );
    return image;
  } finally {
    db.close();
  }
}
export async function exportImages(
  dataDir: string,
  staging: string,
  source: Source,
  chat: Chat,
  messages: Message[],
  include: boolean,
) {
  const db = cacheDB(dataDir);
  let saved = 0,
    missing = 0;
  try {
    for (const m of messages)
      for (const a of m.attachments || []) {
        if (!include) {
          delete a.ref;
          delete a.archivePath;
          a.available = false;
          a.recoverable = false;
          a.missing = "Image files were omitted from this export.";
          continue;
        }
        const old = db
          .prepare("SELECT json FROM attachment_refs WHERE chat_id=? AND id=?")
          .get(chat.id, a.id);
        const registered = old ? JSON.parse(String(old.json)) : {};
        try {
          const value = {
            ...registered,
            ...a,
            ...(a.archivePath ? { archiveRoot: source.root } : {}),
          };
          const image = await materializeImage(dataDir, value);
          const rel = "attachments/" + basename(image.path);
          await mkdir(join(staging, "attachments"), { recursive: true });
          if (!existsSync(join(staging, rel)))
            await copyFile(image.path, join(staging, rel));
          delete a.ref;
          a.archivePath = rel;
          a.available = true;
          a.recoverable = false;
          a.mime = image.mime;
          a.bytes = image.bytes;
          delete a.missing;
          saved++;
        } catch (e: any) {
          delete a.ref;
          delete a.archivePath;
          a.available = false;
          a.recoverable = false;
          a.missing = e.message;
          missing++;
        }
      }
    return { saved, missing };
  } finally {
    db.close();
  }
}
