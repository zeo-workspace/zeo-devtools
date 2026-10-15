// @lucascouts/vite-plugin-zeo (story 033): in `vite dev`, tag every intrinsic JSX element with
// its source and relay picker selections to Zeo's devtools bridge. Both plugins are
// serve-only, so `vite build` output carries nothing of either (R11.1). Story 052 adds the
// intrinsic elements of `.astro` templates, parsed with the app's `@astrojs/compiler-rs` (the
// copy its Astro resolves, else the app root's).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { version as viteVersion, type Plugin, type ResolvedConfig } from "vite";
import { z } from "zod";
import {
  isUnder,
  parseSelection,
  selectionFromPage,
  selectionToZeo,
  type DevtoolsResult,
} from "./contract.js";
import { tagAstroModuleOutcome, type AstroCompiler } from "./astro-tagger.js";
import { resolveSocketPath, sendToZeo } from "./socket.js";
import { DEFAULT_EXCLUDE, tagModule } from "./tagger.js";

const optionsSchema = z
  .strictObject({
    /** Default: `$ZEO_DEVTOOLS_SOCKET`, else `$XDG_RUNTIME_DIR/zeo/devtools.sock`. */
    socketPath: z.string().min(1).optional(),
    /** Default `Alt+Shift+Z`. */
    shortcut: z.string().min(1).optional(),
    /** Extra intrinsic tag names never tagged, on top of the react-three-fiber list. */
    exclude: z.array(z.string().min(1)).optional(),
    /** Default `true`: the first send in a tab asks to share it, for an element screenshot. */
    screenshot: z.boolean().optional(),
  })
  .optional();

export type ZeoPluginOptions = NonNullable<z.input<typeof optionsSchema>>;

/** Strips Vite's query suffix (`?t=…`, `?v=…`) so the id is a file path again. */
const cleanId = (id: string) => {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
};

const TAGGER = "zeo-devtools:tagger";
const ASTRO_TAGGER = "zeo-devtools:astro-tagger";
const CLIENT_URL = "/@zeo-devtools/client";
const CLIENT_ID = "\0zeo-devtools-client";
/** The first Vite whose HMR socket checks Origin and a token (CVE-2025-24010). */
const VITE_MIN = "6.0.9";

/** Numeric `major.minor.patch` comparison: `6.0.10` is newer than `6.0.9`. */
export function viteAtLeast(found: string, required: string): boolean {
  const parse = (v: string) =>
    v
      .split(/[.+-]/)
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(found);
  const b = parse(required);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) {
      return a[i]! > b[i]!;
    }
  }
  return true;
}

/** The picker module next to this file: `.js` once built, `.ts` when run from source. */
function clientEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = resolvePath(here, "client/index.js");
  return existsSync(built) ? built : resolvePath(here, "client/index.ts");
}

/** Decoded bytes of a base64 string, for the log line (the bytes themselves are never logged). */
const decodedBytes = (b64: string) =>
  Math.max(
    0,
    Math.floor((b64.length * 3) / 4) - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0),
  );

const failure = (error: "bad_request" | "outside_project" | "unreachable", message: string) =>
  ({ v: 1, ok: false, error, message }) as const satisfies DevtoolsResult;
/** plugin-react's `compiler: true` plugin: also `enforce: "pre"`, and it compiles JSX away. */
const REACT_COMPILER = "vite:react-compiler";
const JSX_ID = /\.[jt]sx(?:$|\?)/;
const ASTRO_ID = /\.astro(?:$|\?)/;
const ASTRO_COMPILER = "@astrojs/compiler-rs";

/** A log value as-is, or JSON-quoted when it would break the `key=value` line apart. */
const logValue = (value: string) => (/^[^\s"=]+$/.test(value) ? value : JSON.stringify(value));

/** Imports `@astrojs/compiler-rs` as `from` resolves it, or says why it could not. */
async function importAstroCompiler(
  from: string,
): Promise<{ compiler: AstroCompiler } | { compiler: undefined; error: string }> {
  try {
    const resolved = createRequire(from).resolve(ASTRO_COMPILER);
    const loaded: unknown = await import(pathToFileURL(resolved).href);
    if (typeof (loaded as Partial<AstroCompiler> | null)?.parse !== "function") {
      return { compiler: undefined, error: "no_parse_export" };
    }
    return { compiler: loaded as AstroCompiler };
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return { compiler: undefined, error: typeof code === "string" ? code : "load_failed" };
  }
}

/**
 * `@astrojs/compiler-rs` as the APP's installation provides it, never this package's own copy:
 * first the copy the app's `astro` resolves (Astro nests its own, so this is the parser the
 * app's Astro compiles with), then the app root's copy (an optional peer). `undefined` when
 * neither loads, with the app root's reason as a short code for the log line.
 */
async function loadAstroCompiler(
  root: string,
): Promise<{ compiler: AstroCompiler } | { compiler: undefined; error: string }> {
  const app = join(root, "package.json");
  try {
    const astro = createRequire(app).resolve("astro/package.json");
    const fromAstro = await importAstroCompiler(astro);
    if (fromAstro.compiler !== undefined) {
      return fromAstro;
    }
  } catch {
    // The app has no resolvable `astro`: only the app root's copy is left to try.
  }
  return importAstroCompiler(app);
}

/** One dev-server start's `.astro` state: its compiler, loaded once, and its warnings. */
interface AstroState {
  compiler: Promise<AstroCompiler | undefined>;
  /** Files already reported as `astro_parse_failed` by this server. */
  parseFailed: Set<string>;
}

export function zeo(options?: ZeoPluginOptions): Plugin[] {
  // Validated here, not in a hook, so invalid options fail `vite build` as well as `vite dev`.
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error("vite-plugin-zeo: invalid options", { cause: parsed.error });
  }
  const exclude: ReadonlySet<string> = new Set([
    ...DEFAULT_EXCLUDE,
    ...(parsed.data?.exclude ?? []),
  ]);
  let root = "";
  let mode = "development";
  let lastConfig: ResolvedConfig | undefined;
  // Keyed by the server's top-level config, so one zeo() result shared by two servers, or a
  // restarted server, logs and loads per server start rather than once per process (R1.7).
  const astroStates = new WeakMap<ResolvedConfig, AstroState>();

  const astroStateFor = (config: ResolvedConfig): AstroState => {
    let state = astroStates.get(config);
    if (state === undefined) {
      // Created on the server's first `.astro` module of the app, so the compiler loads then.
      const compiler = loadAstroCompiler(config.root).then((loaded) => {
        if (loaded.compiler === undefined) {
          config.logger.warn(
            `zeo-devtools event=warning reason=astro_compiler_missing error=${logValue(loaded.error)} ` +
              `hint=${logValue(`add ${ASTRO_COMPILER} to the app's dependencies, or no .astro element is tagged`)}`,
          );
        }
        return loaded.compiler;
      });
      state = { compiler, parseFailed: new Set() };
      astroStates.set(config, state);
    }
    return state;
  };

  /** Tags one `.astro` module of the app, or `null` to leave it to Astro unchanged. */
  const transformAstro = async (
    config: ResolvedConfig,
    code: string,
    id: string,
    envRoot: string,
  ) => {
    // Astro's sub-modules (`?astro&type=style…`) are the same file's script or style blocks:
    // only the plain module is the template, and the component name comes from its file name.
    if (id.includes("?") || !isUnder(id, envRoot)) {
      return null;
    }
    const rel = posix.relative(envRoot, id);
    if (rel.split("/").includes("node_modules")) {
      return null;
    }
    const state = astroStateFor(config);
    const compiler = await state.compiler;
    if (compiler === undefined) {
      return null;
    }
    const result = tagAstroModuleOutcome(code, id, envRoot, exclude, compiler);
    if (result.outcome === "parse_failed") {
      if (!state.parseFailed.has(id)) {
        state.parseFailed.add(id);
        // Astro reports the error itself; this line only says why the module carries no tag.
        config.logger.warn(
          `zeo-devtools event=warning reason=astro_parse_failed file=${logValue(rel)}`,
        );
      }
      return null;
    }
    return result.outcome === "tagged" ? { code: result.code, map: result.map } : null;
  };

  const tagger: Plugin = {
    name: TAGGER,
    apply: "serve",
    // Before Vite's own oxc JSX transform, whatever the plugin order (another `pre` plugin
    // listed earlier still runs first: see the react-compiler check below).
    enforce: "pre",
    configResolved(config) {
      root = config.root;
      mode = config.mode;
      const names = config.plugins.map((plugin) => plugin.name);
      const compiler = names.indexOf(REACT_COMPILER);
      if (config.mode !== "test" && compiler !== -1 && compiler < names.indexOf(TAGGER)) {
        config.logger.warn(
          "zeo-devtools event=warning reason=react_compiler_first " +
            "hint=list zeo() before react() in plugins, or no element is tagged",
        );
      }
    },
    transform: {
      filter: { id: JSX_ID },
      handler(code, id) {
        // The environment's own config, so one zeo() result shared by two servers stays correct.
        // Vitest serves with mode "test": tagging there would leak into users' snapshots.
        if ((this.environment?.config.mode ?? mode) === "test") {
          return null;
        }
        const envRoot = this.environment?.config.root ?? root;
        return tagModule(code, cleanId(id), envRoot, exclude);
      },
    },
  };

  // A plugin of its own, so only `.astro` modules move ahead: Astro lists its own
  // `enforce: "pre"` plugins before every user and integration plugin, so `enforce` alone hands
  // this hook Astro's compiled JS. `order: "pre"` runs it before every hook without one,
  // Astro's compile included; the JSX tagger above keeps its place behind a `pre` plugin
  // listed earlier, as story 033's react_compiler_first warning expects.
  // Known cost: Astro keeps the code it was handed (the tagged template) to diff a later edit
  // against the raw file, so a style-only edit of a tagged file reloads the component instead
  // of only its styles; what renders is unaffected.
  const astroTagger: Plugin = {
    name: ASTRO_TAGGER,
    apply: "serve",
    enforce: "pre",
    configResolved(config) {
      lastConfig = config;
    },
    transform: {
      order: "pre",
      filter: { id: ASTRO_ID },
      handler(code, id) {
        // Vite applies hook filters only from 6.3 on, and this package accepts older versions:
        // re-check the id, so no other module is tagged or loads the Astro compiler.
        if (!ASTRO_ID.test(id)) {
          return null;
        }
        // As the JSX tagger: the environment's own config, and never in Vitest's mode (R1.8).
        const config = this.environment?.getTopLevelConfig() ?? lastConfig;
        if (config === undefined || (this.environment?.config.mode ?? config.mode) === "test") {
          return null;
        }
        const envRoot = this.environment?.config.root ?? config.root;
        return transformAstro(config, code, id, envRoot);
      },
    },
  };

  const clientOptions = {
    shortcut: parsed.data?.shortcut,
    screenshot: parsed.data?.screenshot,
  };
  let relayEnabled = false;

  const relay: Plugin = {
    name: "zeo-devtools:relay",
    apply: "serve",
    config() {
      // The picker is injected by this plugin, so Vite's startup scan cannot see that it
      // imports zod; without this the first page load triggers a re-optimisation and a reload.
      return { optimizeDeps: { include: ["zod"] } };
    },
    configResolved(config) {
      relayEnabled = viteAtLeast(viteVersion, VITE_MIN);
      if (relayEnabled) {
        // The picker lives in this package, which may sit outside the served root.
        config.server.fs.allow.push(dirname(clientEntry()));
      }
    },
    resolveId(id) {
      return relayEnabled && id === CLIENT_URL ? CLIENT_ID : null;
    },
    load(id) {
      if (id !== CLIENT_ID) {
        return null;
      }
      return [
        `import { mount } from ${JSON.stringify(clientEntry())};`,
        `mount(${JSON.stringify(clientOptions)});`,
      ].join("\n");
    },
    transformIndexHtml() {
      if (!relayEnabled) {
        return [];
      }
      return [{ tag: "script", attrs: { type: "module", src: CLIENT_URL }, injectTo: "head" }];
    },
    configureServer(server) {
      const logger = server.config.logger;
      if (!relayEnabled) {
        logger.warn(
          `zeo-devtools event=disabled reason=vite_too_old found=${viteVersion} required=${VITE_MIN}`,
        );
        return;
      }
      if (server.config.server.ws === false) {
        logger.warn(
          "zeo-devtools event=disabled reason=ws_off hint=the picker needs Vite's HMR socket",
        );
        return;
      }
      const root = server.config.root;

      const answer = async (
        data: unknown,
      ): Promise<{ result: DevtoolsResult; items: number; shot: number }> => {
        const page = parseSelection(selectionFromPage, data);
        if (!page.ok) {
          return {
            result: { v: 1, ok: false, error: page.error, message: page.message },
            items: 0,
            shot: 0,
          };
        }
        const items = page.value.items.length;
        const shot = page.value.screenshot ? decodedBytes(page.value.screenshot.data_b64) : 0;
        const absolute = page.value.items.map((item) => ({
          ...item,
          src: { ...item.src, file: resolvePath(root, item.src.file) },
        }));
        if (absolute.some((item) => !isUnder(item.src.file, root))) {
          return {
            result: failure("outside_project", "A selected file is outside this project"),
            items,
            shot,
          };
        }
        const toZeo = parseSelection(selectionToZeo, {
          ...page.value,
          project_root: root,
          items: absolute,
        });
        if (!toZeo.ok) {
          return {
            result: { v: 1, ok: false, error: toZeo.error, message: toZeo.message },
            items,
            shot,
          };
        }
        const socket = resolveSocketPath(parsed.data?.socketPath);
        if (!socket.ok) {
          return { result: failure("unreachable", socket.message), items, shot };
        }
        return { result: await sendToZeo(socket.path, toZeo.value), items, shot };
      };

      server.ws.on("zeo:select", (data: unknown, client) => {
        const started = Date.now();
        void answer(data)
          .catch((error: unknown) => ({
            result: failure(
              "bad_request",
              `The dev server could not relay the selection: ${error instanceof Error ? error.message : "error"}`,
            ),
            items: 0,
            shot: 0,
          }))
          .then(({ result, items, shot }) => {
            // Never DOM text, attribute values, image bytes or paths (R12.3).
            const outcome = result.ok ? result.outcome : result.error;
            const log = result.ok ? logger.info : logger.warn;
            log.call(
              logger,
              `zeo-devtools event=select items=${items} screenshot_bytes=${shot} outcome=${outcome} ms=${Date.now() - started}`,
            );
            try {
              client.send("zeo:result", result);
            } catch {
              // The tab closed before its answer: nothing left to tell.
            }
          });
      });
    },
  };

  return [tagger, astroTagger, relay];
}

export default zeo;
