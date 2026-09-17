import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:8080",
  },
  webServer: {
    command: "npm run start",
    port: 8080,
    reuseExistingServer: !process.env.CI,
  },
});
