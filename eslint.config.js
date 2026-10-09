import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/",
      "dist/",
      "coverage/",
      "test-results/",
      "playwright-report/",
      "test/fixtures/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "smart"],
      curly: ["error", "all"],
    },
  },
  {
    // Tests strip ANSI colour codes from captured logs, which needs a control character in a regex.
    files: ["test/**/*.ts", "e2e/**/*.ts"],
    rules: { "no-control-regex": "off" },
  },
);
