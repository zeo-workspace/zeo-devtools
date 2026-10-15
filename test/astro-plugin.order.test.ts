// Story 052, task 1.2, tech-review fix round 1 — the `.astro` tagger must run BEFORE Astro
// compiles the module, in Astro's real plugin order, without moving the JSX path. Requirements:
// R1.1 (tagged under a real `astro dev`), R1.6, R1.7, R2.7 (JSX path unchanged).
//
// Why this file exists: test/astro-plugin.test.ts lists its Astro stand-in AFTER zeo(), the
// reverse of Astro's real order. Astro puts its own `enforce: "pre"` plugins first
// (astro/dist/core/create-vite.js) and merges user and integration plugins after them, so a
// plain `enforce: "pre"` tagger received Astro's compiled JS, logged a false
// `astro_parse_failed` for every file and tagged nothing.
//
// Hostile halves first:
//   - order: the Astro stand-in listed BEFORE zeo() must still receive tagged code, with no
//     `astro_parse_failed` (wrongly handed compiled JS), under a real `astro dev` too;
//   - JSX path unchanged: a `pre` plugin listed before zeo() still sees a JSX module UNTAGGED
//     (wrongly hoisted ahead of it, which would silence story 033's `react_compiler_first`
//     warning), and the JSX plugin's hook is neither `order: "pre"` nor routed `.astro` ids;
//   - which compiler: Astro's own nested copy is used when the app root has none, and it wins
//     over a broken copy at the app root (wrongly resolved from the app root only); when
//     neither resolves, ONE `astro_compiler_missing` line whose free-text `hint` is quoted.
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Logger, type Plugin, type ViteDevServer } from "vite";
import { dev } from "astro";
import { zeo } from "../src/index.js";

const OWN_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));
const ASTRO_FIXTURE = fileURLToPath(new URL("./fixtures/astro/", import.meta.url));
const REAL_COMPILER = join(OWN_MODULES, "@astrojs/compiler-rs");

const CARD = [
  "---",
  'import Header from "./Header.astro";',
  "---",
  '<article class="card">',
  "  <h2>Card title</h2>",
  '  <Header title="x" />',
  "</article>",
].join("\n");

const PARSE_FAILED = "zeo-devtools event=warning reason=astro_parse_failed";
const COMPILER_MISSING = "zeo-devtools event=warning reason=astro_compiler_missing";

/** How the throwaway app can reach `@astrojs/compiler-rs`. */
type Compilers =
  | "root" // the app root only (as test/astro-plugin.test.ts's `withCompiler`)
  | "astro-nested" // only inside the app's `astro` package, as Astro installs its own copy
  | "astro-nested-root-broken" // Astro's copy, plus a root copy with no `parse` export
  | "none"; // neither

interface App {
  root: string;
  dispose(): Promise<void>;
}

const temps: string[] = [];

async function tempBase(prefix: string): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  temps.push(base);
  return base;
}

async function link(target: string, path: string) {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path, "dir");
}

async function makeApp(compilers: Compilers): Promise<App> {
  const base = await tempBase("zeo-astro-order-");
  const root = join(base, "app");
  await mkdir(join(root, "src/components"), { recursive: true });
  await writeFile(join(root, "src/components/Card.astro"), CARD);
  await writeFile(join(root, "src/components/Other.astro"), '<div class="other">other</div>');
  await writeFile(
    join(root, "src/components/Island.jsx"),
    "export const Island = () => <p>island</p>;",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "astro-order-app", private: true, type: "module" }),
  );
  await link(join(OWN_MODULES, "zod"), join(root, "node_modules/zod"));
  if (compilers === "root") {
    await link(REAL_COMPILER, join(root, "node_modules/@astrojs/compiler-rs"));
  }
  if (compilers === "astro-nested" || compilers === "astro-nested-root-broken") {
    // A stand-in `astro` package: only its package.json and its own nested compiler.
    const astro = join(root, "node_modules/astro");
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
    await link(REAL_COMPILER, join(astro, "node_modules/@astrojs/compiler-rs"));
  }
  if (compilers === "astro-nested-root-broken") {
    const broken = join(root, "node_modules/@astrojs/compiler-rs");
    await mkdir(broken, { recursive: true });
    await writeFile(
      join(broken, "package.json"),
      JSON.stringify({
        name: "@astrojs/compiler-rs",
        version: "0.0.0-zeo-broken",
        type: "module",
        exports: { ".": "./index.mjs", "./package.json": "./package.json" },
      }),
    );
    await writeFile(join(broken, "index.mjs"), 'export const version = "broken";\n');
  }
  return { root, dispose: () => rm(base, { recursive: true, force: true }) };
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

/** Astro's compiler stand-in: records what it receives, then makes it a JS module. */
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
  logs: LogLine[];
  /** The code the stand-in received for `url`, a root-relative URL. */
  received(url: string): Promise<string>;
}

const servers: ViteDevServer[] = [];
const consoleLines: string[] = [];

/** A Vite dev server in ASTRO's order: the stand-in compiler first, then zeo()'s plugins. */
async function astroOrderDev(app: App): Promise<Dev> {
  const logs: LogLine[] = [];
  const seen = new Map<string, string>();
  const server = await createServer({
    root: app.root,
    configFile: false,
    mode: "development",
    logLevel: "info",
    customLogger: capturingLogger(logs),
    plugins: [astroStandIn(seen), zeo()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true },
  });
  servers.push(server);
  return {
    logs,
    async received(url: string) {
      await server.transformRequest(url);
      const code = seen.get(join(app.root, url));
      if (code === undefined) {
        throw new Error(`the stand-in never saw ${url}; it saw ${[...seen.keys()].join(", ")}`);
      }
      return code;
    },
  };
}

const lines = (d: Dev, needle: string) =>
  [...d.logs.map((l) => l.msg), ...consoleLines].filter((m) => m.includes(needle));

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

describe("Astro's plugin order: its compiler listed before zeo() (R1.1, R1.6)", () => {
  it("hostile: the compiler still receives the tagged template, and nothing is a parse failure", async () => {
    const d = await astroOrderDev(await makeApp("root"));
    const code = await d.received("/src/components/Card.astro");
    expect(code).toMatch(/<article data-zeo-src="src\/components\/Card\.astro:4:1-7"/);
    expect(code).toMatch(/<h2 data-zeo-src="src\/components\/Card\.astro:5:3-5" data-zeo-c="Card"/);
    expect(await d.received("/src/components/Other.astro")).toContain("data-zeo-src=");
    expect(lines(d, PARSE_FAILED)).toHaveLength(0);
    expect(lines(d, COMPILER_MISSING)).toHaveLength(0);
  });
});

describe("the JSX path is unchanged (R2.7)", () => {
  it("hostile: a pre plugin listed before zeo() still sees a JSX module untagged", async () => {
    const d = await astroOrderDev(await makeApp("root"));
    const island = await d.received("/src/components/Island.jsx");
    expect(island).toBe("export const Island = () => <p>island</p>;");
    // Non-vacuous: the same server does hand the stand-in a tagged .astro module.
    expect(await d.received("/src/components/Other.astro")).toContain("data-zeo-src=");
  });

  it("the JSX plugin's transform is not order pre, and routes no .astro id", () => {
    const filterIds = (p: Plugin): RegExp[] => {
      const hook = p.transform;
      if (typeof hook !== "object" || hook === null) {
        return [];
      }
      const id = (hook.filter as { id?: unknown } | undefined)?.id;
      return (Array.isArray(id) ? id : [id]).filter((r): r is RegExp => r instanceof RegExp);
    };
    const jsx = zeo().filter((p) => filterIds(p).some((r) => r.test("/app/src/A.tsx")));
    expect(jsx).toHaveLength(1);
    const hook = jsx[0]!.transform as { order?: unknown };
    expect(hook.order).not.toBe("pre");
    expect(filterIds(jsx[0]!).some((r) => r.test("/app/src/Card.astro"))).toBe(false);
  });
});

describe("which @astrojs/compiler-rs (R1.7)", () => {
  it("uses Astro's nested copy when the app root has none", async () => {
    const d = await astroOrderDev(await makeApp("astro-nested"));
    expect(await d.received("/src/components/Card.astro")).toContain("data-zeo-src=");
    expect(lines(d, COMPILER_MISSING)).toHaveLength(0);
  });

  it("hostile: Astro's copy wins over a broken copy at the app root", async () => {
    const d = await astroOrderDev(await makeApp("astro-nested-root-broken"));
    expect(await d.received("/src/components/Card.astro")).toContain("data-zeo-src=");
    expect(lines(d, COMPILER_MISSING)).toHaveLength(0);
  });

  it("neither resolves: one astro_compiler_missing line, its hint value quoted", async () => {
    const d = await astroOrderDev(await makeApp("none"));
    expect(await d.received("/src/components/Card.astro")).toBe(CARD);
    expect(await d.received("/src/components/Other.astro")).not.toContain("data-zeo-");
    const missing = lines(d, COMPILER_MISSING);
    expect(missing).toHaveLength(1);
    const hint = missing[0]!.match(/ hint=("(?:[^"\\]|\\.)*")$/);
    expect(hint).not.toBeNull();
    expect(JSON.parse(hint![1]!)).toContain("@astrojs/compiler-rs");
    // Every field is one `key=value` token: nothing after the quoted hint, no bare words.
    const fields = missing[0]!.replace(/^zeo-devtools /, "");
    expect(fields).toMatch(/^(?:\w+=(?:"(?:[^"\\]|\\.)*"|[^\s"=]+)(?: |$))+$/);
  });
});

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

describe("a real astro dev (R1.1)", () => {
  // Astro skips its own dev middleware when `VITEST` is set (vite-plugin-astro-server/plugin.js),
  // so the flag is lifted only while `dev()` builds the server, and restored after.
  const ENV = ["VITEST", "ASTRO_TELEMETRY_DISABLED", "ASTRO_DISABLE_UPDATE_CHECK"] as const;

  it("hostile: zeo() added through an integration's updateConfig tags the served page", async () => {
    const base = await tempBase("zeo-astro-dev-");
    const root = join(base, "site");
    await cp(join(ASTRO_FIXTURE, "src"), join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "astro-order-site", private: true, type: "module" }),
    );
    // The app root resolves the compiler too, so the old code is red for the ORDER, not for a
    // missing compiler.
    for (const pkg of ["astro", "zod", "@astrojs/compiler-rs"]) {
      await link(join(OWN_MODULES, pkg), join(root, "node_modules", pkg));
    }
    const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    let server: Awaited<ReturnType<typeof dev>> | undefined;
    try {
      delete process.env.VITEST;
      process.env.ASTRO_TELEMETRY_DISABLED = "1";
      process.env.ASTRO_DISABLE_UPDATE_CHECK = "true";
      server = await dev({
        root,
        configFile: false,
        logLevel: "warn",
        devToolbar: { enabled: false },
        server: { host: "127.0.0.1", port: await freePort() },
        integrations: [
          {
            name: "zeo-order-test",
            hooks: {
              "astro:config:setup": ({ updateConfig }) => {
                updateConfig({ vite: { plugins: zeo() } });
              },
            },
          },
        ],
      });
      const response = await fetch(`http://127.0.0.1:${server.address.port}/`);
      const html = await response.text();
      expect(response.status).toBe(200);
      expect(html).toContain("Astro fixture ready"); // non-vacuous: the fixture's page
      expect(html).toContain('data-zeo-src="src/');
      expect(html).toMatch(/<html[^>]* data-zeo-src="src\/layouts\/Base\.astro:5:1-21"/);
      expect(html).toMatch(/<button[^>]* data-zeo-src="src\/components\/Hero\.astro:9:3-9"/);
      expect(written.filter((w) => w.includes("astro_parse_failed"))).toHaveLength(0);
    } finally {
      await server?.stop();
      spy.mockRestore();
      for (const k of ENV) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  }, 120_000);
});
