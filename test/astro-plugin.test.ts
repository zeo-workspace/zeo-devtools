// Story 052, task 1.2 — `zeo()` routes `.astro` modules to the tagger, with the app's own
// `@astrojs/compiler-rs`, in `serve` only and never in `test` mode. Requirements: R1.3 (built-in
// and user exclude through the plugin), R1.6, R1.7, R1.8.
//
// A REAL Vite dev server runs over a throwaway app root in the OS temp dir, so what "the app"
// can resolve is under the test's control: `withCompiler` links the real `@astrojs/compiler-rs`
// into the app's node_modules, `withoutCompiler` does not. Astro's own compiler is replaced by a
// stand-in `enforce: "pre"` plugin listed AFTER zeo(): it records the code the tagger handed on
// and turns the module into `export default "<that code>"` so Vite's import analysis accepts it.
// The real Astro pipeline is exercised by e2e/astro.spec.ts (task 2.2).
//
// Hostile halves first:
//   - compiler resolution: the plugin's own package can resolve `@astrojs/compiler-rs` (a
//     devDependency), yet an app that cannot must still get `astro_compiler_missing` and no tag
//     (wrongly found through the plugin), while an app that can gets tags and no warning;
//   - "once per dev-server start": two modules on one server give ONE line (wrongly repeated),
//     and a second server started afterwards gives its own line (wrongly silenced process-wide);
//   - parse failures: two broken files give two lines, each naming its own root-relative file
//     (wrongly collapsed into one), while a module that parses but holds nothing to tag gives
//     no line at all (nothing-to-tag wrongly read as a failure);
//   - scope: Astro's sub-module ids (`?astro&type=style…`), a sibling directory sharing the
//     root as a string prefix (`app-outside/`) and a module under node_modules stay untagged,
//     while a directory merely NAMED like node_modules (`my_node_modules/`) is tagged;
//   - modes: `mode: "test"` and `vite build` tag nothing, while the same module in dev does.
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build, createServer, type Logger, type Plugin, type ViteDevServer } from "vite";
import { zeo, type ZeoPluginOptions } from "../src/index.js";

const OWN_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));

const CARD = [
  "---",
  'import Header from "./Header.astro";',
  "---",
  '<article class="card">',
  "  <h2>Card title</h2>",
  "  <section>excluded by option</section>",
  '  <Header title="x" />',
  "</article>",
  "<style>",
  "  article { color: red; }",
  "</style>",
].join("\n");

const FILES: Record<string, string> = {
  "src/components/Card.astro": CARD,
  "src/components/Other.astro": '<div class="other">other</div>',
  "src/components/Scene.astro": "<div><mesh /></div>",
  "src/components/Broken.astro": "<p>fine</p>\n<div attr={></div>",
  "src/components/Broken2.astro": "<div><p>unclosed</div>",
  "src/components/OnlyComponents.astro":
    '---\nimport Header from "./Header.astro";\n---\n<Header title="x" />',
  "src/my_node_modules/Near.astro": '<div id="near">near</div>',
  "node_modules/ui-kit/Lib.astro": '<div id="lib">from a package</div>',
};

interface App {
  /** The Vite root: `<tmp>/app`. */
  root: string;
  /** A sibling directory sharing the root as a string prefix: `<tmp>/app-outside`. */
  outside: string;
  dispose(): Promise<void>;
}

async function makeApp(withCompiler: boolean): Promise<App> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "zeo-astro-")));
  const root = join(base, "app");
  const outside = join(base, "app-outside");
  for (const [rel, text] of Object.entries(FILES)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), text);
  }
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, "Outside.astro"), '<div id="outside">outside</div>');
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "astro-app", private: true, type: "module" }),
  );
  await symlink(join(OWN_MODULES, "zod"), join(root, "node_modules/zod"), "dir");
  if (withCompiler) {
    await mkdir(join(root, "node_modules/@astrojs"), { recursive: true });
    await symlink(
      join(OWN_MODULES, "@astrojs/compiler-rs"),
      join(root, "node_modules/@astrojs/compiler-rs"),
      "dir",
    );
  }
  return { root, outside, dispose: () => rm(base, { recursive: true, force: true }) };
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

/**
 * Stand-in for Astro's compiler: records what it receives and makes it a JS module. It also
 * takes `.jsx`, so the JSX check needs no React in the throwaway app.
 */
function astroStandIn(seen: Map<string, string>): Plugin {
  return {
    name: "test:astro-stand-in",
    enforce: "pre",
    transform(code, id) {
      if (!/\.(?:astro|jsx)(?:$|\?)/.test(id)) {
        return null;
      }
      seen.set(id, code);
      return { code: `export default ${JSON.stringify(code)};`, map: null };
    },
  };
}

interface Dev {
  server: ViteDevServer;
  logs: LogLine[];
  seen: Map<string, string>;
  /** The code the tagger handed on for `url` (a root-relative URL or an `/@fs/` one). */
  served(url: string): Promise<string>;
}

const servers: ViteDevServer[] = [];
const consoleLines: string[] = [];

async function dev(
  app: App,
  options?: ZeoPluginOptions,
  mode: "development" | "test" = "development",
): Promise<Dev> {
  const logs: LogLine[] = [];
  const seen = new Map<string, string>();
  const server = await createServer({
    root: app.root,
    configFile: false,
    mode,
    logLevel: "info",
    customLogger: capturingLogger(logs),
    plugins: [zeo(options), astroStandIn(seen)],
    // The base holds the root and its prefix-sharing sibling, so `/@fs/` may load both.
    server: { middlewareMode: true, hmr: false, fs: { allow: [dirname(app.root)] } },
    optimizeDeps: { noDiscovery: true },
  });
  servers.push(server);
  return {
    server,
    logs,
    seen,
    async served(url: string) {
      await server.transformRequest(url);
      const id = url.startsWith("/@fs/") ? url.slice("/@fs".length) : join(app.root, url);
      const code = seen.get(id);
      if (code === undefined) {
        throw new Error(`the stand-in never saw ${id}; it saw ${[...seen.keys()].join(", ")}`);
      }
      return code;
    },
  };
}

/** Every warning line, from Vite's logger or the console, that carries `needle`. */
const lines = (d: Dev, needle: string) =>
  [...d.logs.map((l) => l.msg), ...consoleLines].filter((m) => m.includes(needle));

const PARSE_FAILED = "zeo-devtools event=warning reason=astro_parse_failed";
const COMPILER_MISSING = "zeo-devtools event=warning reason=astro_compiler_missing";

let withCompiler: App;
let withoutCompiler: App;

beforeAll(async () => {
  withCompiler = await makeApp(true);
  withoutCompiler = await makeApp(false);
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
  await withCompiler?.dispose();
  await withoutCompiler?.dispose();
});

describe("dev tags .astro modules with the app's compiler", () => {
  it("tags a component served in dev, with its root-relative path and file name", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/src/components/Card.astro");
    expect(code).toMatch(/<article data-zeo-src="src\/components\/Card\.astro:4:1-8"/);
    expect(code).toMatch(/<h2 data-zeo-src="src\/components\/Card\.astro:5:3-5" data-zeo-c="Card"/);
    expect(lines(d, COMPILER_MISSING)).toHaveLength(0);
  });

  it("applies the built-in exclude list with no option (R1.3)", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/src/components/Scene.astro");
    expect(code).toMatch(/<div data-zeo-src=/);
    expect(code).not.toMatch(/<mesh[^>]*data-zeo-/);
  });

  it("applies the user's exclude option to .astro templates (R1.3)", async () => {
    const d = await dev(withCompiler, { exclude: ["section"] });
    const code = await d.served("/src/components/Card.astro");
    expect(code).toMatch(/<section>excluded by option<\/section>/);
    expect(code).toMatch(/<h2 data-zeo-src=/);
  });
});

describe("which ids are tagged", () => {
  it("hostile: Astro's sub-module ids are left alone, though the same file's main id is tagged", async () => {
    const d = await dev(withCompiler);
    const style = await d.served("/src/components/Card.astro?astro&type=style&index=0");
    const script = await d.served("/src/components/Card.astro?astro&type=script&index=0");
    expect(style).not.toContain("data-zeo-");
    expect(script).not.toContain("data-zeo-");
    expect(await d.served("/src/components/Card.astro")).toContain("data-zeo-src=");
  });

  it("hostile: a sibling directory sharing the root as a string prefix is outside the root", async () => {
    const d = await dev(withCompiler);
    const code = await d.served(`/@fs${join(withCompiler.outside, "Outside.astro")}`);
    expect(code).toBe('<div id="outside">outside</div>');
    expect(await d.served("/src/components/Other.astro")).toContain("data-zeo-src="); // tagger on
  });

  it("hostile: a module under node_modules is left alone", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/node_modules/ui-kit/Lib.astro");
    expect(code).toBe('<div id="lib">from a package</div>');
    expect(await d.served("/src/components/Other.astro")).toContain("data-zeo-src="); // tagger on
  });

  it("converse: a directory merely named like node_modules is tagged", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/src/my_node_modules/Near.astro");
    expect(code).toMatch(/<div data-zeo-src="src\/my_node_modules\/Near\.astro:1:1-1"/);
  });
});

describe("a module that does not parse (R1.6)", () => {
  it("is served unchanged, with one warning naming its root-relative path", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/src/components/Broken.astro");
    expect(code).toBe(FILES["src/components/Broken.astro"]);
    const warned = lines(d, PARSE_FAILED);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("file=src/components/Broken.astro");
    expect(warned[0]).not.toContain(withCompiler.root); // root-relative, never absolute
  });

  it("hostile collapse: two broken files give two lines, each naming its own file", async () => {
    const d = await dev(withCompiler);
    await d.served("/src/components/Broken.astro");
    await d.served("/src/components/Broken2.astro");
    const warned = lines(d, PARSE_FAILED);
    expect(warned).toHaveLength(2);
    expect(warned.some((l) => l.includes("file=src/components/Broken.astro"))).toBe(true);
    expect(warned.some((l) => l.includes("file=src/components/Broken2.astro"))).toBe(true);
  });

  it("hostile: a module that parses but holds nothing to tag is not a parse failure", async () => {
    const d = await dev(withCompiler);
    const code = await d.served("/src/components/OnlyComponents.astro");
    expect(code).toBe(FILES["src/components/OnlyComponents.astro"]);
    expect(lines(d, PARSE_FAILED)).toHaveLength(0);
    await d.served("/src/components/Broken.astro"); // the same server does report a real failure
    expect(lines(d, PARSE_FAILED)).toHaveLength(1);
  });

  it("does not stop the next module from being tagged", async () => {
    const d = await dev(withCompiler);
    await d.served("/src/components/Broken.astro");
    expect(await d.served("/src/components/Other.astro")).toContain("data-zeo-src=");
  });
});

describe("the app cannot load @astrojs/compiler-rs (R1.7)", () => {
  it("hostile: leaves every .astro module unchanged, though the plugin's own package could resolve it", async () => {
    const d = await dev(withoutCompiler);
    expect(await d.served("/src/components/Card.astro")).toBe(CARD);
    expect(await d.served("/src/components/Other.astro")).toBe(FILES["src/components/Other.astro"]);
    expect(lines(d, COMPILER_MISSING)).toHaveLength(1);
  });

  it("logs astro_compiler_missing once for the whole server, not once per module", async () => {
    const d = await dev(withoutCompiler);
    await d.served("/src/components/Card.astro");
    await d.served("/src/components/Other.astro");
    await d.served("/src/components/Scene.astro");
    expect(lines(d, COMPILER_MISSING)).toHaveLength(1);
    expect(lines(d, PARSE_FAILED)).toHaveLength(0);
  });

  it("hostile: a second dev-server start logs its own line (not silenced process-wide)", async () => {
    const first = await dev(withoutCompiler);
    await first.served("/src/components/Card.astro");
    expect(lines(first, COMPILER_MISSING)).toHaveLength(1);
    await first.server.close();
    servers.splice(servers.indexOf(first.server), 1);
    consoleLines.length = 0;
    const second = await dev(withoutCompiler);
    await second.served("/src/components/Card.astro");
    expect(lines(second, COMPILER_MISSING)).toHaveLength(1);
  });

  it("does not stop the JSX path: no throw, and a JSX module in the same app is still tagged", async () => {
    await writeFile(
      join(withoutCompiler.root, "src/components/Island.jsx"),
      "export const Island = () => <p>island</p>;",
    );
    const d = await dev(withoutCompiler);
    await d.served("/src/components/Card.astro");
    expect(await d.served("/src/components/Island.jsx")).toContain("data-zeo-src");
    expect(lines(d, COMPILER_MISSING)).toHaveLength(1);
  });
});

describe("test mode and build tag nothing (R1.8)", () => {
  it("mode test leaves a module untagged that dev tags", async () => {
    const devMode = await dev(withCompiler);
    expect(await devMode.served("/src/components/Card.astro")).toContain("data-zeo-src=");
    const testMode = await dev(withCompiler, undefined, "test");
    expect(await testMode.served("/src/components/Card.astro")).toBe(CARD);
  });

  it("vite build output carries the component's text and no data-zeo- attribute", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "zeo-astro-build-"));
    try {
      await build({
        root: withCompiler.root,
        configFile: false,
        logLevel: "silent",
        plugins: [zeo(), astroStandIn(new Map())],
        build: {
          outDir,
          emptyOutDir: true,
          minify: false,
          lib: {
            entry: join(withCompiler.root, "src/components/Card.astro"),
            formats: ["es"],
            fileName: "card",
          },
        },
      });
      const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
      const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
      const output = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
      expect(output).toContain("Card title"); // non-vacuous: the component really is there
      expect(output).not.toContain("data-zeo-");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
