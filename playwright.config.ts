// Story 033, task 9.2 — Playwright projects for the picker E2E (design.md §Testing Strategy):
// Chromium auto-accepts the current-tab capture so the screenshot path runs without a human;
// Firefox (no single-tab surface) proves the no-screenshot degradation.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // One fake Zeo socket and one pair of dev servers per worker: keep it to one worker so
  // the fake's request log is never shared between tests running at the same time.
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  reporter: [["list"]],
  outputDir: "test-results",
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--auto-accept-this-tab-capture"] },
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
