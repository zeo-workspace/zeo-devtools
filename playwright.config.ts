// Story 033, task 9.2 — Playwright projects for the picker E2E (design.md §Testing Strategy):
// Chromium auto-accepts the current-tab capture so the screenshot path runs without a human;
// Firefox (no single-tab surface) proves the no-screenshot degradation.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  // tsconfig.json without its type-only `paths` (see tsconfig.playwright.json).
  tsconfig: "./tsconfig.playwright.json",
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
        // The full browser: the default chromium-headless-shell rejects getDisplayMedia.
        channel: "chromium",
        launchOptions: {
          // One renderer per site: the R6.2 background tab is otherwise starved to ~3 rAF/s.
          args: ["--auto-accept-this-tab-capture", "--process-per-site"],
        },
      },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
  ],
});
