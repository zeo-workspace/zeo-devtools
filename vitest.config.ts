import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The packaged-sourcemap check reads dist/, which `npm test` does not build: it runs in
    // `npm run test:package` (vitest.package.config.ts), after the build.
    exclude: ["test/fixtures/**", "e2e/**", "node_modules/**", "test/package-sourcemaps.test.ts"],
    // CI=true turns Vite's terminal colours on, and an ANSI reset between "Local" and ":" breaks
    // tests that read Vite's printed URLs; the suite asserts text, not colour.
    env: { NO_COLOR: "1", FORCE_COLOR: "0" },
    // The panel page links its stylesheet and frames the app; happy-dom would fetch both from
    // servers that do not exist in a unit test. Layout and the real app frame are the
    // real-browser suite's (e2e/panel*.spec.ts).
    environmentOptions: {
      happyDOM: {
        settings: {
          disableCSSFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
          navigation: { disableChildFrameNavigation: true },
        },
      },
    },
  },
});
