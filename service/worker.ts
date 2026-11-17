import { parentPort, workerData } from "node:worker_threads";
import { discover, listChats, allMessages } from "./adapters";
import { exportBundle, importBundle, restoreCodex } from "./transfer";
import { cleanupTask } from "./cleanup";
import { activities } from "./activity";
import type { Source, Chat } from "../src/types";
const progress = (stage: string, progress: number) =>
  parentPort!.postMessage({ type: "progress", stage, progress });
(async () => {
  const task = workerData;
  if (task.type === "activity") {
    parentPort!.postMessage({
      type: "done",
      result: await activities(task.sources, task.chats),
    });
    return;
  }
  if (task.type === "scan") {
    const sources = discover(task.custom, task.home),
      chats: Chat[] = [];
    for (const s of sources) {
      try {
        const list = listChats(s);
        s.count = list.length;
        chats.push(...list);
      } catch (e: any) {
        s.error = e.message;
        s.available = false;
      }
    }
    parentPort!.postMessage({ type: "done", result: { sources, chats } });
    return;
  }
  if (task.type === "index") {
    for (let i = 0; i < task.chats.length; i++) {
      const c = task.chats[i] as Chat,
        s = task.sources.find((s: Source) => s.id === c.sourceId);
      if (!s) continue;
      try {
        const body = await allMessages(s, c);
        parentPort!.postMessage({
          type: "indexed",
          id: c.id,
          version: c.updatedAt,
          text: body.map((m) => m.text).join("\n"),
        });
      } catch {}
      progress(
        "Indexing messages " + (i + 1) + " / " + task.chats.length,
        (i + 1) / task.chats.length,
      );
    }
    parentPort!.postMessage({
      type: "done",
      result: { indexed: task.chats.length },
    });
    return;
  }
  const result =
    task.type === "export"
      ? await exportBundle(task, progress)
      : task.type === "import"
        ? await importBundle(task, progress)
        : await restoreCodex(task, progress);
  await cleanupTask(task);
  parentPort!.postMessage({ type: "done", result });
})().catch(async (e) => {
  if (["export", "import", "restore"].includes(workerData.type))
    await cleanupTask(workerData);
  parentPort!.postMessage({ type: "failed", error: e.message });
});
