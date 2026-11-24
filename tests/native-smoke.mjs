import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer } from "node:net";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { fixture } from "./helpers.mjs";
const f = await fixture(),
  binary = resolve(
    process.argv[2] || "../termsanity/src-tauri/target/release/chatport.exe",
  );
const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, "127.0.0.1", () => {
    const port = s.address().port;
    s.close(() => resolve(port));
  });
});
const env = {
  ...process.env,
  CHATPORT_DATA: f.data,
  CHATPORT_NO_DISCOVERY:'1', CHATPORT_NEARBY_BIND:'127.0.0.1',
  CHATPORT_HOME: f.home,
  CODEX_HOME: f.codex,
  CLAUDE_CONFIG_DIR: join(f.home, ".claude"),
  T3CODE_HOME: join(f.home, ".t3/userdata"),
  WEBVIEW2_USER_DATA_FOLDER:join(f.data,"webview"),
  FREEBUFF_CONFIG_DIR:join(f.home,".config/manicode"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + port,
};
let app, browser, creds;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 30000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const result = await fn();
      if (result) return result;
    } catch (e) {
      last = e;
    }
    await delay(150);
  }
  throw last || new Error("Native check timed out");
}
async function launch() {
  app = spawn(binary, [], { env, windowsHide: true, stdio: "ignore" });
  await until(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`);
    return r.ok;
  });
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return until(() =>
    browser
      .contexts()[0]
      ?.pages()
      .find((p) => p.url().includes("tauri.localhost")),
  );
}
async function rpc(method, params = {}) {
  creds = JSON.parse(await readFile(join(f.data, "service.json"), "utf8"));
  const r = await fetch(`http://127.0.0.1:${creds.port}/rpc`, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + creds.token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ method, params }),
  });
  const b = await r.json();
  if (!r.ok) throw new Error(b.error);
  return b.result;
}
try {
  let page = await launch();
  await page
    .getByRole("button", { name: /First café/ })
    .waitFor({ timeout: 30000 });
  assert.equal(await page.locator(".chat-row").count(), 2);
  const expectedVersion=JSON.parse(await readFile('package.json','utf8')).version;
  assert.ok((await page.locator('.statusbar').innerText()).includes('ChatPort '+expectedVersion),'Bundled UI version should match the release');
  assert.ok(
    await page
      .locator(".brand .app-mark")
      .evaluate((img) => img.complete && img.naturalWidth === 256),
  );
  await page.getByRole("button", { name: /First café/ }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  const folder = join(f.root, "Native resume folder");
  await mkdir(folder);
  await page.getByRole("dialog").locator(".path-field input").fill(folder);
  await page.getByRole("button", { name: "Save folder" }).click();
  await until(
    async () =>
      await page
        .locator(".working-folder")
        .innerText()
        .then((text) => text.includes(folder)),
  );
  const selected = (await rpc("library")).chats.find(
    (c) => c.title === "First café 日本語",
  );
  assert.equal(selected.resumeCwd, folder);
  const originalPid = creds.pid;
  process.kill(originalPid);
  await until(async () => {
    const l = await rpc("library");
    return (
      creds.pid !== originalPid &&
      l.chats.find((c) => c.id === selected.id)?.resumeCwd === folder
    );
  }, 45000);
  await page.getByRole("button", { name: "Export all", exact: true }).waitFor();
  const recoveredPid = creds.pid;
  await page.getByLabel("Select First café 日本語", { exact: true }).check();
  await page.getByRole("button", { name: "Export 1", exact: true }).click();
  const drive = join(f.root, "Native USB destination");
  await mkdir(drive);
  await page.getByRole("dialog").locator(".path-field input").fill(drive);
  await page.getByRole("button", { name: "Create archive" }).click();
  await until(async () => {
    const j = (await rpc("library")).jobs[0];
    if (j?.state === "failed") throw new Error(j.error);
    return j?.state === "completed";
  });
  const exited = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("ChatPort did not exit after closing its window")),
      15000,
    );
    app.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await page.getByRole("button", { name: "Close" }).click();
  await exited;
  await until(async () => {
    try {
      const c = JSON.parse(await readFile(join(f.data, "service.json"), "utf8"));
      const r = await fetch(`http://127.0.0.1:${c.port}/health`, {
        headers: { Authorization: "Bearer " + c.token },
      });
      return !r.ok;
    } catch {
      return true;
    }
  }, 15000);
  await browser.close().catch(() => {});
  await delay(600);
  page = await launch();
  await page.getByRole("button", { name: /First café/ }).waitFor();
  await page.getByRole("button", { name: /First café/ }).click();
  await until(async () =>
    (await page.locator(".working-folder").innerText()).includes(folder),
  );
  const restarted = await rpc("library");
  assert.notEqual(creds.pid, recoveredPid);
  assert.equal(
    restarted.chats.find((c) => c.id === selected.id).resumeCwd,
    folder,
  );
  await page.screenshot({
    path: ".test-data/native-chatport.png",
    scale: "css",
  });
  await writeFile(
    ".test-data/native-verification.json",
    JSON.stringify(
      {
        binary,
        nativeUI: true,
        serviceCrashRecovered: true,
        folderOverrideSurvived: true,
        exportCompleted: true,
        serviceStoppedWithWindow: true,
        serviceRestartedCleanly: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS: packaged WebView2 UI, icon, folder persistence, automatic service recovery, clean shutdown on window close, portable export, and a fresh service on reopen.",
  );
} finally {
  app?.kill();
  await browser?.close().catch(() => {});
  await rpc("shutdown").catch(() => {});
}
