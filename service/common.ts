import { createHash, randomBytes } from "node:crypto";
import { join, resolve, relative, isAbsolute } from "node:path";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { displayPath } from "../src/paths";
import { appDataPath } from "./platform";
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const token = () => randomBytes(32).toString("hex");
export function readJSON(file: string) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}
export function atomicJSON(file: string, data: any) {
  const temp = file + "." + process.pid + ".tmp";
  writeFileSync(temp, JSON.stringify(data), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(temp, file);
      break;
    } catch (e: any) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(e.code) || attempt >= 20)
        throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}
export function dataDir() {
  const i = process.argv.indexOf("--data");
  const root = resolve(
    i >= 0 ? process.argv[i + 1] : process.env.CHATPORT_DATA || appDataPath(),
  );
  mkdirSync(root, { recursive: true });
  return root;
}
export function inside(root: string, file: string) {
  const rel = relative(resolve(displayPath(root)), resolve(displayPath(file)));
  return !rel.startsWith("..") && !isAbsolute(rel);
}
export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export function safeId(id: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id))
    throw new Error("Invalid conversation identity");
  return id;
}
