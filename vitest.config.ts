import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "e2e/**", "node_modules/**"],
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
