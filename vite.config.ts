import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {appDataPath} from './service/platform';
export default defineConfig({
  plugins: [
    react(),
    {
      name: "chatport-dev",
      configureServer(server) {
        server.middlewares.use("/__bootstrap", (_req, res) => {
          try {
            res.setHeader("Content-Type", "application/json");
            res.setHeader("Cache-Control", "no-store");
            res.end(
              readFileSync(
                join(
                  process.env.CHATPORT_DATA ||
                    appDataPath(),
                  "service.json",
                ),
                "utf8",
              ),
            );
          } catch {
            res.statusCode = 503;
            res.end("{}");
          }
        });
      },
    },
  ],
  server: { port: 1435, strictPort: true, host: "127.0.0.1" },
  build: { target: "es2022" },
});
