// Story 052, task 2.1 — the `zeoAstro(options)` Astro integration. Requirements: R2.1–R2.3.
// Contract: `zeoAstro(options?: ZeoPluginOptions)` exported from the package entry returns an
// Astro integration `{ name, hooks: { "astro:config:setup": (ctx) => void } }`. With
// `command === "dev"` it adds `zeo(options)` to `vite.plugins` through `updateConfig` and injects
// a "page" script that loads the picker; with any other command it adds nothing.
//
// The hook context is a stand-in carrying the fields the contract names (`command`,
// `updateConfig`, `injectScript`) plus inert copies of the rest. The injected script is NOT
// matched against a string: its import is resolved and loaded through a REAL Vite dev server
// running the plugins the integration added, so the check is "the page script loads the picker".
// The real Astro pipeline is exercised by e2e/astro.spec.ts (task 2.2).
//
// Hostile halves first:
//   - loaded twice: in dev, each of zeo()'s plugins is added exactly once (wrongly duplicated),
//     and the picker script is injected exactly once;
//   - build leak: `build`, `preview` and `sync` add no plugin and inject no script (wrongly
//     added), while `dev` does both (so the first check is not vacuous);
//   - validation: invalid options throw zeo()'s own message under `build` too (wrongly validated
//     only in dev), while valid options — none, `{}`, every field — do not throw.
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createServer, type Plugin, type ViteDevServer } from "vite";
import { zeo, zeoAstro, type ZeoPluginOptions } from "../src/index.js";

const APP_ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));
type Command = "dev" | "build" | "preview" | "sync";

interface Ctx {
  command: Command;
  updateConfig: ReturnType<typeof vi.fn>;
  injectScript: ReturnType<typeof vi.fn>;
}

function makeCtx(command: Command): Ctx & Record<string, unknown> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    command,
    isRestart: false,
    config: { root: new URL("file:///tmp/astro-site/"), integrations: [], vite: {} },
    updateConfig: vi.fn((partial: unknown) => partial),
    injectScript: vi.fn(),
    addRenderer: vi.fn(),
    addWatchFile: vi.fn(),
    injectRoute: vi.fn(),
    addClientDirective: vi.fn(),
    addDevToolbarApp: vi.fn(),
    addMiddleware: vi.fn(),
    createCodegenDir: vi.fn(() => new URL("file:///tmp/astro-site/.astro/")),
    logger: { ...logger, fork: vi.fn(() => logger), label: "zeo" },
  };
}

/** Runs the integration's config:setup hook for `command`, sync or async alike. */
async function setup(command: Command, options?: ZeoPluginOptions) {
  const integration = zeoAstro(options);
  const ctx = makeCtx(command);
  const hook = integration.hooks["astro:config:setup"];
  expect(typeof hook).toBe("function");
  await hook!(ctx as never);
  return ctx;
}

/** Every Vite plugin passed to `updateConfig({ vite: { plugins } })`, flattened. */
function addedPlugins(ctx: Ctx): Plugin[] {
  const flat = (value: unknown): unknown[] =>
    Array.isArray(value) ? value.flatMap(flat) : [value];
  return ctx.updateConfig.mock.calls
    .flatMap(([partial]) =>
      flat((partial as { vite?: { plugins?: unknown } })?.vite?.plugins ?? []),
    )
    .filter((p): p is Plugin => typeof p === "object" && p !== null && "name" in p);
}

/** The module specifier imported by an injected script. */
function importedSpecifier(script: string): string {
  const match = script.match(/import\s*(?:[^'"]*?\sfrom\s*)?["']([^"']+)["']/);
  if (match === null) {
    throw new Error(`the injected script imports nothing: ${script}`);
  }
  return match[1]!;
}

const zeoMessage = (options: unknown): string => {
  try {
    zeo(options as ZeoPluginOptions);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("zeo() accepted options this test treats as invalid");
};

const servers: ViteDevServer[] = [];
afterAll(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/** Loads the page script's import through a real dev server running `plugins`. */
async function loadThrough(plugins: Plugin[], specifier: string): Promise<string> {
  const server = await createServer({
    root: APP_ROOT,
    configFile: false,
    logLevel: "silent",
    plugins,
    server: { middlewareMode: true, hmr: false },
  });
  servers.push(server);
  const result = await server.transformRequest(specifier);
  return result?.code ?? "";
}

describe("zeoAstro() shape (R2.1)", () => {
  it("is an Astro integration with a name and an astro:config:setup hook", () => {
    const integration = zeoAstro();
    expect(typeof integration.name).toBe("string");
    expect(integration.name.length).toBeGreaterThan(0);
    expect(typeof integration.hooks["astro:config:setup"]).toBe("function");
  });
});

describe("astro dev loads the plugin and the picker (R2.1, R2.2)", () => {
  it("hostile: adds each of zeo()'s plugins exactly once", async () => {
    const ctx = await setup("dev");
    const names = addedPlugins(ctx).map((p) => p.name);
    const expected = zeo().map((p) => p.name);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual([...expected].sort());
  });

  it("injects exactly one page-stage script", async () => {
    const ctx = await setup("dev");
    expect(ctx.injectScript).toHaveBeenCalledTimes(1);
    const [stage, content] = ctx.injectScript.mock.calls[0]!;
    expect(stage).toBe("page");
    expect(typeof content).toBe("string");
  });

  it("the injected script's import loads the picker through the plugins it added", async () => {
    const ctx = await setup("dev");
    const specifier = importedSpecifier(ctx.injectScript.mock.calls[0]![1] as string);
    const code = await loadThrough(addedPlugins(ctx), specifier);
    expect(code).toMatch(/mount\(/);
  });

  it("passes its options to zeo(): the picker gets the configured shortcut", async () => {
    const ctx = await setup("dev", { shortcut: "Alt+Shift+X", screenshot: false });
    const specifier = importedSpecifier(ctx.injectScript.mock.calls[0]![1] as string);
    const code = await loadThrough(addedPlugins(ctx), specifier);
    expect(code).toContain("Alt+Shift+X");
  });
});

describe("other commands add nothing (R2.3)", () => {
  it.each(["build", "preview", "sync"] as const)(
    "hostile: %s adds no plugin and injects no script",
    async (command) => {
      const ctx = await setup(command);
      expect(addedPlugins(ctx)).toHaveLength(0);
      expect(ctx.injectScript).not.toHaveBeenCalled();
    },
  );

  it("converse: the same options under dev do add both (non-vacuous)", async () => {
    const ctx = await setup("dev");
    expect(addedPlugins(ctx).length).toBeGreaterThan(0);
    expect(ctx.injectScript).toHaveBeenCalled();
  });
});

describe("options are validated like zeo() (R2.1)", () => {
  const INVALID: unknown[] = [{ bogus: true }, { exclude: "section" }, { shortcut: "" }];

  it.each(INVALID)("hostile: %j throws zeo()'s message under build, not only dev", async (bad) => {
    const message = zeoMessage(bad);
    for (const command of ["build", "dev"] as const) {
      await expect(
        (async () => {
          await setup(command, bad as ZeoPluginOptions);
        })(),
      ).rejects.toThrow(message);
    }
  });

  it("converse: no options, empty options and every valid field are accepted", async () => {
    for (const options of [
      undefined,
      {},
      {
        socketPath: "/tmp/zeo.sock",
        shortcut: "Alt+Shift+Z",
        exclude: ["section"],
        screenshot: true,
      },
    ] satisfies (ZeoPluginOptions | undefined)[]) {
      await expect(setup("dev", options)).resolves.toBeDefined();
    }
  });
});
