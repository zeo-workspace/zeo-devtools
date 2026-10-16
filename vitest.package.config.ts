import { defineConfig } from "vitest/config";

// `npm run test:package`: checks that need the built package in dist/, run after `npm run build`.
export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["test/package-sourcemaps.test.ts"],
  },
});
