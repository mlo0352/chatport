import { spawn } from "node:child_process";
import "./build-service.mjs";
const service = spawn(process.execPath, ["chatport-runtime/service.cjs"], {
  stdio: "inherit",
  windowsHide: true,
});
const vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
  windowsHide: true,
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    service.kill();
    vite.kill();
    process.exit();
  });
