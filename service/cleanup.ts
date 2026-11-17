import { rm, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { inside } from "./common";
export async function cleanupTask(task: {
  dataDir: string;
  jobId: string;
  destination?: string;
  type?: string;
}) {
  for (const [base, path] of [
    [join(task.dataDir, "jobs"), join(task.dataDir, "jobs", task.jobId)],
    [
      join(task.dataDir, "imports"),
      join(task.dataDir, "imports", task.jobId + ".partial"),
    ],
  ]) {
    if (resolve(base) !== resolve(path) && inside(base, path))
      await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  if (task.destination && task.type === "export")
    for (const name of await readdir(task.destination).catch(() => []))
      if (
        name.startsWith("ChatPort-") &&
        name.endsWith("-" + task.jobId + ".chatport.zip.partial")
      ) {
        const file = join(task.destination, name);
        if (inside(task.destination, file))
          await rm(file, { force: true }).catch(() => {});
      }
}
