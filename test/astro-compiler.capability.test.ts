// Story 052, task 2.2, tech-review fix round 1 — a compiler copy that counts positions in UTF-8
// bytes is never used (R1.4, R1.7). `@astrojs/compiler-rs` before 0.4 reports byte offsets;
// 0.4 on reports string indices, which is what the tagger turns into the line and column the
// editor shows. Such an old copy can sit at the app root without the app declaring it: another
// package's dependency (astro-eslint-parser@3 wants ^0.3.1) gets hoisted there.
//
// The stand-in for an old copy is the real compiler with every `start`/`end` rewritten to the
// UTF-8 byte offset of the same position, so it differs from the real one ONLY in that way.
//
// Hostile halves first:
//   - a byte-offset copy at the app root, a string-index copy inside the app's `astro`: the
//     nested one must be used, so an element after a non-ASCII character keeps its column
//     (wrongly: the root copy loads, so it is used, and the column is off by one per extra byte);
//   - both copies count bytes: ONE `astro_compiler_incompatible` line and the module unchanged
//     (wrongly: tagged at wrong positions, silently);
//   - converse: a string-index copy at the app root is used, with no warning, even when the
//     copy inside `astro` counts bytes (so the check rejects nothing it should accept).
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Logger, type Plugin, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";

const OWN_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const REAL_COMPILER = join(OWN_MODULES, "@astrojs/compiler-rs");
const REAL_ENTRY = createRequire(import.meta.url).resolve("@astrojs/compiler-rs");

// `é` is one string index but two UTF-8 bytes: a byte-offset copy puts `<a>` one column right.
const CARD = ["<p>é</p><a>link</a>", "<div>é</div>"].join("\n");

const INCOMPATIBLE = "zeo-devtools event=warning reason=astro_compiler_incompatible";
const MISSING = "reason=astro_compiler_missing";

/** What a compiler location holds: the real copy, or the byte-offset stand-in. */
type Copy = "strings" | "bytes" | "none";

const temps: string[] = [];

async function link(target: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, "dir");
}

/** A compiler package at `dir` that reports UTF-8 byte offsets, as compiler-rs < 0.4 did. */
async function writeByteOffsetCompiler(dir: string) {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@astrojs/compiler-rs",
      version: "0.3.2",
      type: "module",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" },
    }),
  );
  const real = JSON.stringify(pathToFileURL(REAL_ENTRY).href);
  await writeFile(
    join(dir, "index.mjs"),
    [
      `import * as real from ${real};`,
      `export * from ${real};`,
      "export function parse(source) {",
      "  const result = real.parse(source);",
      "  const bytes = (i) => Buffer.byteLength(source.slice(0, i), 'utf8');",
      "  const walk = (node) => {",
      "    if (Array.isArray(node)) { node.forEach(walk); return; }",
      "    if (node === null || typeof node !== 'object') { return; }",
      "    for (const [key, value] of Object.entries(node)) {",
      "      if ((key === 'start' || key === 'end') && typeof value === 'number') {",
      "        node[key] = bytes(value);",
      "      } else {",
      "        walk(value);",
      "      }",
      "    }",
      "  };",
      "  const ast = typeof result.ast === 'string' ? JSON.parse(result.ast) : result.ast;",
      "  walk(ast);",
      "  return { ...result, ast };",
      "}",
    ].join("\n"),
  );
}

async function place(copy: Copy, dir: string) {
  if (copy === "strings") {
    await link(REAL_COMPILER, dir);
  } else if (copy === "bytes") {
    await writeByteOffsetCompiler(dir);
  }
}

/** A throwaway app: `root` is the app root's copy, `nested` the one its `astro` resolves. */
async function makeApp(root: Copy, nested: Copy): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "zeo-astro-capability-")));
  temps.push(base);
  const app = join(base, "app");
  await mkdir(join(app, "src/components"), { recursive: true });
  await writeFile(join(app, "src/components/Card.astro"), CARD);
  await writeFile(
    join(app, "package.json"),
    JSON.stringify({ name: "astro-capability-app", private: true, type: "module" }),
  );
  await link(join(OWN_MODULES, "zod"), join(app, "node_modules/zod"));
  await place(root, join(app, "node_modules/@astrojs/compiler-rs"));
  // A stand-in `astro` package: only its package.json and its own nested compiler.
  const astro = join(app, "node_modules/astro");
  await mkdir(astro, { recursive: true });
  await writeFile(
    join(astro, "package.json"),
    JSON.stringify({
      name: "astro",
      version: "0.0.0-zeo-test",
      type: "module",
      exports: { "./package.json": "./package.json" },
    }),
  );
  await place(nested, join(astro, "node_modules/@astrojs/compiler-rs"));
  return app;
}

interface LogLine {
  level: string;
  msg: string;
}

function capturingLogger(lines: LogLine[]): Logger {
  const push = (level: string) => (msg: string) => {
    lines.push({ level, msg: String(msg) });
  };
  return {
    info: push("info"),
    warn: push("warn"),
    warnOnce: push("warn"),
    error: push("error"),
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

/** Astro's compiler stand-in, listed first as Astro lists its own: records what it receives. */
function astroStandIn(seen: Map<string, string>): Plugin {
  return {
    name: "test:astro-stand-in",
    enforce: "pre",
    transform(code, id) {
      if (!/\.astro(?:$|\?)/.test(id)) {
        return null;
      }
      seen.set(id, code);
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

const servers: ViteDevServer[] = [];
const consoleLines: string[] = [];

/** The code Astro's stand-in received for Card.astro, and every log line of that server. */
async function cardAsReceived(app: string): Promise<{ code: string; logs: string[] }> {
  const logs: LogLine[] = [];
  const seen = new Map<string, string>();
  const server = await createServer({
    root: app,
    configFile: false,
    mode: "development",
    logLevel: "info",
    customLogger: capturingLogger(logs),
    plugins: [astroStandIn(seen), zeo()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  servers.push(server);
  await server.transformRequest("/src/components/Card.astro");
  // A second module of the same server: the warning stays once per server start.
  await server.transformRequest("/src/components/Card.astro?v=2");
  const code = seen.get(join(app, "src/components/Card.astro"));
  if (code === undefined) {
    throw new Error("the stand-in never saw Card.astro");
  }
  return { code, logs: [...logs.map((l) => l.msg), ...consoleLines] };
}

beforeAll(() => {
  for (const method of ["warn", "error", "log", "info"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      consoleLines.push(args.map(String).join(" "));
    });
  }
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  consoleLines.length = 0;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all(temps.splice(0).map((t) => rm(t, { recursive: true, force: true })));
});

const withNeedle = (logs: string[], needle: string) => logs.filter((m) => m.includes(needle));

describe("a compiler that counts bytes is never used (R1.4, R1.7)", () => {
  it("hostile: a byte-offset copy at the app root yields to Astro's string-index copy", async () => {
    const { code, logs } = await cardAsReceived(await makeApp("bytes", "strings"));
    // `<a>` starts at string index 8 of line 1: column 9, as the editor shows it.
    expect(code).toContain('<a data-zeo-src="src/components/Card.astro:1:9-1"');
    expect(code).toContain('<p data-zeo-src="src/components/Card.astro:1:1-1"');
    expect(code).toContain('<div data-zeo-src="src/components/Card.astro:2:1-2"');
    expect(withNeedle(logs, INCOMPATIBLE)).toHaveLength(0);
    expect(withNeedle(logs, MISSING)).toHaveLength(0);
  });

  it("hostile: both copies count bytes — one astro_compiler_incompatible line, nothing tagged", async () => {
    const { code, logs } = await cardAsReceived(await makeApp("bytes", "bytes"));
    expect(code).toBe(CARD);
    const lines = withNeedle(logs, INCOMPATIBLE);
    expect(lines).toHaveLength(1);
    // Every field is one `key=value` token.
    expect(lines[0]!.replace(/^.*?zeo-devtools /, "")).toMatch(
      /^(?:\w+=(?:"(?:[^"\\]|\\.)*"|[^\s"=]+)(?: |$))+$/,
    );
    expect(withNeedle(logs, MISSING)).toHaveLength(0);
  });

  it("a byte-offset copy with no other copy is incompatible, not missing", async () => {
    const { code, logs } = await cardAsReceived(await makeApp("bytes", "none"));
    expect(code).toBe(CARD);
    expect(withNeedle(logs, INCOMPATIBLE)).toHaveLength(1);
    expect(withNeedle(logs, MISSING)).toHaveLength(0);
  });

  it("converse: a string-index copy at the app root is used, with no warning", async () => {
    const { code, logs } = await cardAsReceived(await makeApp("strings", "bytes"));
    expect(code).toContain('<a data-zeo-src="src/components/Card.astro:1:9-1"');
    expect(withNeedle(logs, INCOMPATIBLE)).toHaveLength(0);
    expect(withNeedle(logs, MISSING)).toHaveLength(0);
  });
});

describe("the position probe never throws (R1.7)", () => {
  it("hostile: an AST whose start getter throws reads as incompatible, not as an exception", async () => {
    const { astroCompilerUsesStringIndices } = await import("../src/astro-tagger.js");
    const element = {
      type: "JSXElement",
      get start(): number {
        throw new Error("getter boom");
      },
    };
    const compiler = {
      parse: () => ({ ast: { type: "AstroRoot", body: [element] }, diagnostics: [] }),
    };
    expect(() => astroCompilerUsesStringIndices(compiler)).not.toThrow();
    expect(astroCompilerUsesStringIndices(compiler)).toBe(false);
  });
});
