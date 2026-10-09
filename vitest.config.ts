import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/fixtures/**", "e2e/**", "node_modules/**"],
  },
});
