import { fixture } from "./helpers.mjs";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
const f = await fixture();
const env = {
  ...process.env,
  CHATPORT_DATA: f.data,
  CHATPORT_NO_DISCOVERY:'1', CHATPORT_NEARBY_BIND:'127.0.0.1',
  CHATPORT_HOME: f.home,
  CODEX_HOME: join(f.home, ".codex"),
  CLAUDE_CONFIG_DIR: join(f.home, ".claude"),
  FREEBUFF_CONFIG_DIR: join(f.home, ".config/manicode"),
  T3CODE_HOME: join(f.home, ".t3/userdata"),
};
const service = spawn(process.execPath, ["chatport-runtime/service.cjs"], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
for (let i = 0; i < 100 && !existsSync(join(f.data, "service.json")); i++)
  await new Promise((r) => setTimeout(r, 50));
const ui = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  env,
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    service.kill();
    ui.kill();
    process.exit();
  });
