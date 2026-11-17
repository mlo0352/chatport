import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
type Connection = { port: number; token: string };
let connection: Promise<Connection> | undefined;
export const desktop = isTauri();
async function connect() {
  return desktop
    ? invoke<Connection>("bootstrap")
    : (await fetch("/__bootstrap")).json();
}
export async function rpc<T = any>(
  method: string,
  params: unknown = {},
): Promise<T> {
  try {
    connection ??= connect();
    const c = await connection;
    const res = await fetch(`http://127.0.0.1:${c.port}/rpc`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ method, params }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || "The operation failed");
    return body.result;
  } catch (e) {
    connection = undefined;
    throw e;
  }
}
export async function pickFolder(defaultPath?: string) {
  if (!desktop) return null;
  return (await open({ directory: true, multiple: false, defaultPath })) as
    string | null;
}
export async function pickArchive() {
  if (!desktop) return null;
  return (await open({
    multiple: false,
    filters: [{ name: "Conversation archives", extensions: ["zip", "json"] }],
  })) as string | null;
}
export async function reveal(path: string) {
  if (desktop) await invoke("reveal_path", { path });
  else await navigator.clipboard.writeText(path);
}
export async function external(url: string) {
  if (desktop) await invoke("open_url", { url });
  else window.open(url, "_blank", "noopener");
}
export async function openInTermSanity(id: string) {
  const plan = await rpc("termsanity", { id });
  if (desktop && plan.handle)
    await invoke("focus_window", { handle: plan.handle, pid: plan.pid });
  return plan;
}
export async function focusChat(id: string) {
  const plan = await rpc("focus", { id });
  if (desktop && plan.handle)
    await invoke("focus_window", { handle: plan.handle, pid: plan.pid });
  else if (!desktop) throw new Error("Window focus requires the desktop app");
  else if (plan.precision !== "tab")
    throw new Error("Window activation is unavailable on this desktop");
  return plan;
}
