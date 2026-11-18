import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const target = resolve("src-tauri/target");
const run = (args) => {
  const result = spawnSync(process.execPath, args, {
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: target,
      CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || "2",
    },
  });
  if (result.status !== 0) process.exit(result.status || 1);
};

run(["node_modules/@tauri-apps/cli/tauri.js", "build", "--no-bundle"]);

const ext = process.platform === "win32" ? ".exe" : "";
const binary = join(target, `release/chatport${ext}`);
const output = `ChatPort${ext}`;
if (!existsSync(binary)) {
  console.error(`Build succeeded but ${binary} was not produced.`);
  process.exit(1);
}
copyFileSync(binary, output);
const hash = createHash("sha256").update(readFileSync(output)).digest("hex");
writeFileSync(`${output}.sha256`, `${hash}  ${output}\n`);
console.log(`Portable build: ${resolve(output)}`);
console.log(`SHA-256: ${hash}`);
