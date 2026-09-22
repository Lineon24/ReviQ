import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser", timeout: 30000, fullyParallel: false,
  use: {
    baseURL: "http://localhost:3000", ...devices["Desktop Chrome"],
    launchOptions: process.platform === "darwin" ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" } : {},
  },
});
