// Story 052, task 1.2, tech-review fix round 2 — the `.astro` tagger must not depend on Vite
// honouring its hook filter. Requirements: R1.6, R1.7, R2.7.
//
// Vite applies a hook's `filter` only from 6.3.0 on; older versions call the handler for every
// module ("for older versions, make sure to also run the filter inside the hook handlers"), and
// the package accepts `vite >=6.0.9`. So the astro-tagger's transform handler is called here
// DIRECTLY, bypassing the filter, as such a Vite would call it.
//
// Hostile halves first:
//   - a `.jsx`, a `.ts` and a `.tsx` module of the app, with the compiler resolvable: returned
//     unchanged (null), never tagged as an Astro component, and no `astro_parse_failed` line;
//   - the same ids in an app WITHOUT the compiler: no `astro_compiler_missing` line, so a
//     React-only app never loads (or reports) the Astro compiler;
//   - non-vacuous: the same handler on a `.astro` id does tag, and does report the missing
//     compiler where it is missing.
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { Logger, Plugin, ResolvedConfig } from "vite";
import { zeo } from "../src/index.js";

const OWN_MODULES = fileURLToPath(new URL("../node_modules/", import.meta.url));

const SOURCES: Record<string, string> = {
  "src/App.jsx": 'export const App = () => <div className="app"><p>hi</p></div>;\n',
  "src/util.ts": "export const twice = (n: number): number => n * 2;\n",
  "src/View.tsx": "export const View = (): JSX.Element => <section>view</section>;\n",
};
const ASTRO = '<div class="card"><h2>title</h2></div>\n';

const PARSE_FAILED = "reason=astro_parse_failed";
const COMPILER_MISSING = "reason=astro_compiler_missing";

const temps: string[] = [];

afterAll(async () => {
  await Promise.all(temps.splice(0).map((t) => rm(t, { recursive: true, force: true })));
});

async function appRoot(withCompiler: boolean): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "zeo-astro-filter-")));
  temps.push(base);
  const root = join(base, "app");
  await mkdir(root, { recursive: true });
  if (withCompiler) {
    const target = join(root, "node_modules/@astrojs/compiler-rs");
    await mkdir(dirname(target), { recursive: true });
    await symlink(join(OWN_MODULES, "@astrojs/compiler-rs"), target, "dir");
  }
  return root;
}

type Handler = (this: unknown, code: string, id: string) => unknown;

/** The astro-tagger's transform handler, configured for `root`, with every log line captured. */
function astroHandler(root: string): { handler: Handler; logs: string[] } {
  const logs: string[] = [];
  const push = (msg: string) => {
    logs.push(String(msg));
  };
  const logger: Logger = {
    info: push,
    warn: push,
    warnOnce: push,
    error: push,
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
  const config = { root, mode: "development", logger } as unknown as ResolvedConfig;
  const plugin = zeo().find((p: Plugin) => p.name === "zeo-devtools:astro-tagger");
  if (plugin === undefined) {
    throw new Error("zeo() returned no zeo-devtools:astro-tagger plugin");
  }
  const configResolved = plugin.configResolved as (this: unknown, c: ResolvedConfig) => void;
  configResolved.call({}, config);
  const hook = plugin.transform as { handler: Handler };
  return { handler: hook.handler, logs };
}

describe("the astro-tagger handler re-checks the id (Vite < 6.3 ignores hook filters)", () => {
  it("hostile: .jsx, .ts and .tsx ids are left untouched, with no parse-failure line", async () => {
    const root = await appRoot(true);
    const { handler, logs } = astroHandler(root);
    for (const [rel, code] of Object.entries(SOURCES)) {
      const result = await handler.call({}, code, join(root, rel));
      expect(result ?? null, rel).toBeNull();
    }
    expect(logs.filter((l) => l.includes(PARSE_FAILED))).toEqual([]);
    expect(logs).toEqual([]);
    // Non-vacuous: the same handler, same root, tags a `.astro` module.
    const astro = (await handler.call({}, ASTRO, join(root, "src/Card.astro"))) as {
      code: string;
    } | null;
    expect(astro?.code).toContain("data-zeo-src=");
  });

  it("hostile: a React-only app never loads the compiler, so never reports it missing", async () => {
    const root = await appRoot(false);
    const { handler, logs } = astroHandler(root);
    for (const [rel, code] of Object.entries(SOURCES)) {
      const result = await handler.call({}, code, join(root, rel));
      expect(result ?? null, rel).toBeNull();
    }
    expect(logs.filter((l) => l.includes(COMPILER_MISSING))).toEqual([]);
    expect(logs).toEqual([]);
    // Non-vacuous: a `.astro` module in that app does report the missing compiler, once.
    expect(await handler.call({}, ASTRO, join(root, "src/Card.astro"))).toBeNull();
    expect(logs.filter((l) => l.includes(COMPILER_MISSING))).toHaveLength(1);
  });
});
