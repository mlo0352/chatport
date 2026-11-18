import { build } from "esbuild";
import { mkdir, copyFile, chmod } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const probeTarget = process.env.CARGO_TARGET_DIR || resolve("src-tauri/target");
const probeBuild = spawnSync(
  "cargo",
  [
    "build",
    "--release",
    "--bin",
    "chatport-probe",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ],
  {
    env: {
      ...process.env,
      CARGO_TARGET_DIR: probeTarget,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "2",
      CHATPORT_SKIP_RUNTIME_EMBED: "1",
    },
    windowsHide: true,
    stdio: "inherit",
  },
);
if (probeBuild.status !== 0)
  throw new Error("Could not build the session activity probe");
await mkdir("chatport-runtime", { recursive: true });
await build({
  entryPoints: { service: "service/index.ts", worker: "service/worker.ts" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outdir: "chatport-runtime",
  outExtension: { ".js": ".cjs" },
  sourcemap: false,
});
const ext = process.platform === "win32" ? ".exe" : "";
await copyFile(process.execPath, "chatport-runtime/node" + ext);
await copyFile("docs/NODE-LICENSE.txt", "chatport-runtime/NODE-LICENSE.txt");
await copyFile(
  resolve(probeTarget, "release/chatport-probe" + ext),
  "chatport-runtime/chatport-probe" + ext,
);
if (process.platform !== "win32") {
  await chmod("chatport-runtime/node", 0o755);
  await chmod("chatport-runtime/chatport-probe", 0o755);
}
