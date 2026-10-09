// Story 033, task 9.1 (TypeScript half) — the zod side of the contract agreement: every
// hand-written fixture under `test/contract/` (authored by Task 2.1) goes through
// `selectionToZeo` and must get the verdict its directory names. The Rust half runs the
// same files through `protocol::validate` (ZEO_DEVTOOLS_CONTRACT_DIR). Requirements:
// R6.1, R8.3 (Q14).
//
// Each invalid file names its expected `DevtoolsError` in a top-level "$expect" key, which
// is stripped before validating. The zod side can only ever answer `bad_request` or
// `unsupported_version` (the other codes need the file system or Zeo), so it asserts:
// the verdict, that "$expect" is a known code, and that every `unsupported_version` case is
// refused on the `v` field — the version is checked first, as on the Rust side.
//
// Non-vacuous guard first: an empty or missing fixture directory must FAIL, never pass.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectionToZeo } from "../src/contract.js";

const DIR = fileURLToPath(new URL("./contract/", import.meta.url));
const ERRORS = [
  "no_window",
  "no_agent_panel",
  "ai_disabled",
  "bad_request",
  "too_large",
  "outside_project",
  "unsupported_version",
  "unreachable",
  "timeout",
];

function load(kind: "valid" | "invalid") {
  const dir = `${DIR}${kind}/`;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(`${dir}${name}`, "utf8")) as Record<string, unknown>;
      const { $expect, ...body } = raw;
      return { name, expected: $expect as string | undefined, body };
    });
}

describe("fixture set (non-vacuous)", () => {
  it("holds at least 5 valid and 10 invalid cases", () => {
    expect(load("valid").length).toBeGreaterThanOrEqual(5);
    expect(load("invalid").length).toBeGreaterThanOrEqual(10);
  });
});

describe("valid fixtures are accepted by selectionToZeo", () => {
  for (const { name, body } of load("valid")) {
    it(name, () => {
      const r = selectionToZeo.safeParse(body);
      expect(r.success, JSON.stringify(r.error?.issues ?? [])).toBe(true);
    });
  }
});

describe("invalid fixtures are refused by selectionToZeo, with a known $expect", () => {
  for (const { name, expected, body } of load("invalid")) {
    it(name, () => {
      expect(ERRORS, `${name} has no known "$expect"`).toContain(expected);
      const r = selectionToZeo.safeParse(body);
      expect(r.success).toBe(false);
      if (expected === "unsupported_version") {
        const paths = (r.error?.issues ?? []).map((i) => i.path.join("."));
        expect(paths).toContain("v");
      }
    });
  }
});
