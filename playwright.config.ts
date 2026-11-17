import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/ui",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:1435",
    viewport: { width: 1440, height: 940 },
    headless: true,
  },
  webServer: {
    command: "node tests/ui-server.mjs",
    url: "http://127.0.0.1:1435",
    timeout: 30000,
    reuseExistingServer: false,
  },
});
