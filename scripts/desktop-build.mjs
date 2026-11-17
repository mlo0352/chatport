import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const target = resolve(
  process.platform === "win32" && existsSync("../termsanity/src-tauri/target")
    ? "../termsanity/src-tauri/target"
    : "src-tauri/target",
);
const run = (args) => {
  const r = spawnSync(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "2",
    },
  });
  if (r.status !== 0) process.exit(r.status || 1);
};
run([
  "node_modules/@tauri-apps/cli/tauri.js",
  "build",
  ...(process.platform === "linux"
    ? ["--config", "src-tauri/tauri.linux.conf.json"]
    : []),
]);
if (process.platform !== "win32") {
  console.log("Packages: " + join(target, "release/bundle"));
  process.exit(0);
}
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const installer = join(
  target,
  `release/bundle/nsis/ChatPort_${version}_${process.arch === "arm64" ? "arm64" : "x64"}-setup.exe`,
);
copyFileSync(installer, "ChatPort-Setup.exe");
console.log("Installer: " + resolve("ChatPort-Setup.exe"));
