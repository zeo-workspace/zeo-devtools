// @lucascouts/zeo-devtools (story 033): in `vite dev`, tag every intrinsic JSX element with
// its source and relay picker selections to Zeo's devtools bridge. Both plugins are
// serve-only, so `vite build` output carries nothing of either (R11.1). Story 052 adds the
// intrinsic elements of `.astro` templates, parsed with the app's `@astrojs/compiler-rs` (the
// copy its Astro resolves, else the app root's).
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, posix, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { version as viteVersion, type Plugin, type ResolvedConfig, type ViteDevServer } from "vite";
import { z } from "zod";
import {
  isUnder,
  parseSelection,
  selectionFromPage,
  selectionToZeo,
  type DevtoolsResult,
} from "./contract.js";
import {
  astroCompilerUsesStringIndices,
  tagAstroModuleOutcome,
  type AstroCompiler,
} from "./astro-tagger.js";
import { startPanelServer, type PanelServer } from "./panel-server.js";
import { announce, logValue, type Session, type SessionLogger } from "./session.js";
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
    /** The devtools panel's port on the app's host; a free port when unset (story 055, R3.1). */
    panelPort: z.number().int().min(1024).max(65535).optional(),
    /** Default `true`: serve the devtools panel and announce the dev server to Zeo (R2.1). */
    panel: z.boolean().optional(),
  })
  .optional();

export type ZeoPluginOptions = NonNullable<z.input<typeof optionsSchema>>;

/** The options as `zeo()` and `zeoAstro()` both accept them, or the one error both throw. */
function parseOptions(options: ZeoPluginOptions | undefined): z.output<typeof optionsSchema> {
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error("zeo-devtools: invalid options", { cause: parsed.error });
  }
  return parsed.data;
}

/** Strips Vite's query suffix (`?t=…`, `?v=…`) so the id is a file path again. */
const cleanId = (id: string) => {
  const query = id.indexOf("?");
  return query === -1 ? id : id.slice(0, query);
};

const TAGGER = "zeo-devtools:tagger";
const ASTRO_TAGGER = "zeo-devtools:astro-tagger";
const RELAY = "zeo-devtools:relay";
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

/** A client module next to this file: `.js` once built, `.ts` when run from source. */
function clientModule(name: "index" | "bridge"): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = resolvePath(here, `client/${name}.js`);
  return existsSync(built) ? built : resolvePath(here, `client/${name}.ts`);
}

/** The picker module. */
const clientEntry = (): string => clientModule("index");

/**
 * How long the client module waits for the panel to start before it is served without the app
 * bridge. The panel starts as soon as the server listens, so this bounds only a panel that never
 * starts; a page is never held longer than this.
 */
const PANEL_ORIGIN_WAIT_MS = 5_000;

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

/** A compiler copy that could be used, or why none could. */
type LoadedCompiler =
  | { compiler: AstroCompiler }
  | { compiler: undefined; reason: "missing" | "incompatible"; error: string };

/**
 * Imports `@astrojs/compiler-rs` as `from` resolves it, or says why it could not: `missing` when
 * it does not load or has no `parse`, `incompatible` when it loads but reports positions in
 * UTF-8 bytes (compiler-rs before 0.4), which would tag elements at wrong columns.
 */
async function importAstroCompiler(from: string): Promise<LoadedCompiler> {
  let compiler: AstroCompiler;
  try {
    const resolved = createRequire(from).resolve(ASTRO_COMPILER);
    const loaded: unknown = await import(pathToFileURL(resolved).href);
    if (typeof (loaded as Partial<AstroCompiler> | null)?.parse !== "function") {
      return { compiler: undefined, reason: "missing", error: "no_parse_export" };
    }
    compiler = loaded as AstroCompiler;
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      compiler: undefined,
      reason: "missing",
      error: typeof code === "string" ? code : "load_failed",
    };
  }
  return astroCompilerUsesStringIndices(compiler)
    ? { compiler }
    : { compiler: undefined, reason: "incompatible", error: "byte_offsets" };
}

/**
 * `@astrojs/compiler-rs` as the APP's installation provides it, never this package's own copy:
 * first the app root's copy, then the copy the app's `astro` resolves (Astro nests its own, so
 * an app that never declared the peer still works, under pnpm too). The app root's copy may be
 * one the app declared on purpose, or one another package's dependency hoisted there (e.g.
 * astro-eslint-parser@3 wants ^0.3.1), so each copy must pass a position check before it is
 * used: a copy that reports byte offsets is skipped. `undefined` when neither copy is usable,
 * `incompatible` if either loaded but failed the check, else `missing` with the app root's
 * reason as a short code for the log line.
 */
async function loadAstroCompiler(root: string): Promise<LoadedCompiler> {
  const app = join(root, "package.json");
  const fromApp = await importAstroCompiler(app);
  if (fromApp.compiler !== undefined) {
    return fromApp;
  }
  let fromAstro: LoadedCompiler | undefined;
  try {
    const astro = createRequire(app).resolve("astro/package.json");
    fromAstro = await importAstroCompiler(astro);
  } catch {
    // The app has no resolvable `astro`: the app root's reason is the one to report.
  }
  if (fromAstro?.compiler !== undefined) {
    return fromAstro;
  }
  return fromAstro?.reason === "incompatible" ? fromAstro : fromApp;
}

/** One dev-server start's `.astro` state: its compiler, loaded once, and its warnings. */
interface AstroState {
  compiler: Promise<AstroCompiler | undefined>;
  /** Files already reported as `astro_parse_failed` by this server. */
  parseFailed: Set<string>;
}

/** How long to wait for `server.resolvedUrls` after `listening`, in 10 ms steps (Vite < 7). */
const URL_WAIT_STEPS = 200;

/**
 * Vite's resolved local URL, once there is one. Vite 8 fills `resolvedUrls` in a `listening`
 * listener it prepends, so it is already set here; older Vite sets it only after `listen()`'s
 * own await, a few ticks later, so the wait is bounded rather than assumed (GOTCHA G2).
 */
async function resolvedLocalUrl(
  server: ViteDevServer,
  stopped: () => boolean,
): Promise<string | undefined> {
  for (let step = 0; server.resolvedUrls === null && step < URL_WAIT_STEPS; step++) {
    if (stopped()) {
      return undefined;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return server.resolvedUrls?.local[0];
}

/**
 * Starts the devtools panel (A1) and the announce session (A2) once `server` listens, prints the
 * panel URL beside Vite's own, and stops both with the server (story 055, design.md §A6). Never
 * throws: whatever stops the panel is one log line, and the dev server keeps serving the app.
 */
function wirePanel(
  server: ViteDevServer,
  options: { panelPort?: number; socketPath?: string },
  /** Told the panel's URL once it runs, or `undefined` when it will not run. */
  onPanel: (url: string | undefined) => void,
): void {
  const vite = server.config.logger;
  // Vite's logger, so session and panel lines land in the dev server's own output.
  const logger: SessionLogger = {
    info: (msg) => vite.info(msg),
    warn: (msg) => vite.warn(msg),
  };
  const httpServer = server.httpServer;
  if (httpServer === null) {
    // GOTCHA G2: in middleware mode the host app owns the HTTP server, and no URL is Vite's.
    logger.warn(
      "zeo-devtools event=panel_disabled reason=middleware_mode " +
        `hint=${logValue("the devtools panel needs Vite's own HTTP server (server.middlewareMode is set)")}`,
    );
    onPanel(undefined);
    return;
  }

  const root = server.config.root;
  let stopped = false;
  let session: Session | undefined;
  /** The running panel, once its port is bound and the announce is open. */
  let running: PanelServer | undefined;
  let starting: Promise<PanelServer | undefined> | undefined;

  /** The panel server at `appUrl`'s host, or `undefined` once its failure is logged. */
  const startPanel = async (appUrl: string): Promise<PanelServer | undefined> => {
    const port = options.panelPort;
    try {
      return await startPanelServer({
        host: new URL(appUrl).hostname,
        port,
        appUrl,
        root,
        zeo: { socketPath: options.socketPath },
        logger,
      });
    } catch (error: unknown) {
      const cause =
        error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
      if (cause?.code === "EADDRINUSE" && port !== undefined) {
        // An explicit port is a promise to the operator: no silent move to another one. With
        // `panelPort` unset the server already binds a free port, so this needs one set (R3.1).
        logger.warn(
          `zeo-devtools event=panel_error reason=panel_port_in_use port=${port} ` +
            `hint=${logValue("choose another panelPort, or leave it unset for a free port")}`,
        );
        return undefined;
      }
      logger.warn(
        `zeo-devtools event=panel_error reason=panel_start_failed root=${logValue(root)} ` +
          `error=${logValue(error instanceof Error ? error.message : "error")}`,
      );
      return undefined;
    }
  };

  const start = async (): Promise<PanelServer | undefined> => {
    const appUrl = await resolvedLocalUrl(server, () => stopped);
    if (stopped) {
      return undefined;
    }
    if (appUrl === undefined) {
      logger.warn(
        `zeo-devtools event=panel_disabled reason=no_local_url ` +
          `hint=${logValue("Vite resolved no local URL for the app (see server.host)")}`,
      );
      return undefined;
    }
    const panel = await startPanel(appUrl);
    if (panel === undefined) {
      return undefined;
    }
    if (stopped) {
      // The dev server closed while the panel was starting.
      await panel.close();
      return undefined;
    }
    running = panel;
    // R2.1: the app URL exactly as Vite resolved it, base path and trailing slash included.
    session = announce(root, appUrl, panel.url, { logger, socketPath: options.socketPath });
    return panel;
  };

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      stopped = true;
      session?.close();
      session = undefined;
      const panel = await starting;
      await panel?.close();
    })();
    return stopping;
  };

  httpServer.once("listening", () => {
    // `start` logs every failure itself and never rejects.
    if (starting === undefined) {
      starting = start();
      void starting.then((panel) => onPanel(panel?.url));
    }
  });
  // A restart closes the old HTTP server without calling `server.close` (R3.7).
  httpServer.once("close", () => void stop());

  const printUrls = server.printUrls;
  server.printUrls = () => {
    printUrls.call(server);
    const line = (panel: PanelServer | undefined) => {
      if (panel !== undefined && !stopped) {
        logger.info(`  ➜  Zeo panel: ${panel.url}`);
      }
    };
    if (running !== undefined) {
      line(running);
    } else {
      // Vite's CLI prints right after `listen()`, possibly before the panel has a port.
      void starting?.then(line);
    }
  };

  const close = server.close;
  server.close = async () => {
    const ending = stop();
    try {
      await close.call(server);
    } finally {
      await ending;
    }
  };
}

export function zeo(options?: ZeoPluginOptions): Plugin[] {
  // Validated here, not in a hook, so invalid options fail `vite build` as well as `vite dev`.
  const opts = parseOptions(options);
  const exclude: ReadonlySet<string> = new Set([...DEFAULT_EXCLUDE, ...(opts?.exclude ?? [])]);
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
        if (loaded.compiler === undefined && loaded.reason === "incompatible") {
          config.logger.warn(
            `zeo-devtools event=warning reason=astro_compiler_incompatible error=${logValue(loaded.error)} ` +
              `hint=${logValue(`${ASTRO_COMPILER} >=0.4.1 is needed at the app root or in astro, or no .astro element is tagged`)}`,
          );
        } else if (loaded.compiler === undefined) {
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
    shortcut: opts?.shortcut,
    screenshot: opts?.screenshot,
  };
  /**
   * The panel page's origin, once this server's panel runs; `undefined` when it does not. The
   * client module waits for it, so the app bridge posts to the panel's origin only.
   */
  let panelOrigin: Promise<string | undefined> = Promise.resolve(undefined);
  let relayEnabled = false;

  const relay: Plugin = {
    name: RELAY,
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
    async load(id) {
      if (id !== CLIENT_ID) {
        return null;
      }
      const lines = [
        `import { mount } from ${JSON.stringify(clientEntry())};`,
        `mount(${JSON.stringify(clientOptions)});`,
      ];
      // Story 055: the app bridge (design.md §A4), only when a panel runs, and told its origin.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const origin = await Promise.race([
        panelOrigin,
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), PANEL_ORIGIN_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (origin !== undefined) {
        lines.push(
          `import { startBridge } from ${JSON.stringify(clientModule("bridge"))};`,
          `startBridge(${JSON.stringify({ panelOrigin: origin })});`,
        );
      }
      return lines.join("\n");
    },
    transformIndexHtml() {
      if (!relayEnabled) {
        return [];
      }
      return [{ tag: "script", attrs: { type: "module", src: CLIENT_URL }, injectTo: "head" }];
    },
    configureServer(server) {
      const logger = server.config.logger;
      // zeo() listed twice (e.g. story 033's zeo() kept next to zeoAstro()): only the first
      // relay listens, or every pick would reach Zeo once per copy and the extra answer could
      // pair with the wrong in-flight send (R2.5).
      const first = server.config.plugins.find((plugin) => plugin.name === RELAY);
      if (first !== relay) {
        logger.warn(
          `zeo-devtools event=warning reason=duplicate_plugin plugin=${logValue(RELAY)} ` +
            `hint=${logValue("zeo() is registered more than once; only the first copy relays picks")}`,
        );
        return;
      }
      // Story 055: the panel and the announce, from this relay so zeo() stays three plugins and
      // a second copy starts nothing. Never in Vitest's mode (R2.6); `apply: "serve"` already
      // keeps all of it out of `vite build`.
      if (opts?.panel !== false && server.config.mode !== "test") {
        let tell: (url: string | undefined) => void = () => {};
        panelOrigin = new Promise((resolve) => {
          tell = (url) => resolve(url === undefined ? undefined : new URL(url).origin);
        });
        wirePanel(server, { panelPort: opts?.panelPort, socketPath: opts?.socketPath }, tell);
      } else {
        panelOrigin = Promise.resolve(undefined);
      }
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
        const socket = resolveSocketPath(opts?.socketPath);
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

/**
 * The part of Astro's `astro:config:setup` context `zeoAstro()` uses. Declared here rather than
 * imported, so `dist/` never imports `astro`: a Vite-only app installs no Astro. Method syntax
 * keeps it assignable to Astro's own `AstroIntegration` hook type.
 */
export interface ZeoAstroConfigSetup {
  command: "dev" | "build" | "preview" | "sync";
  updateConfig(config: { vite: { plugins: Plugin[] } }): unknown;
  injectScript(stage: "page", content: string): void;
}

/** An Astro integration, as far as `zeoAstro()` fills one in. */
export interface ZeoAstroIntegration {
  name: string;
  hooks: {
    "astro:config:setup"(ctx: ZeoAstroConfigSetup): void;
  };
}

/**
 * `zeo()` for an Astro app: list `zeoAstro(options)` in `integrations`. Under `astro dev` it adds
 * `zeo(options)` to Vite's plugins and loads the picker on every page through a page script;
 * under any other command it adds nothing, so a build carries none of it (R2.1–R2.3).
 */
export function zeoAstro(options?: ZeoPluginOptions): ZeoAstroIntegration {
  // At config load, so invalid options fail `astro build` as well as `astro dev`.
  parseOptions(options);
  return {
    name: "zeo-devtools",
    hooks: {
      "astro:config:setup"({ command, updateConfig, injectScript }) {
        if (command !== "dev") {
          return;
        }
        updateConfig({ vite: { plugins: zeo(options) } });
        // Astro never runs `transformIndexHtml`, so the relay's own injection never fires here:
        // the page script imports the module the relay resolves and loads instead.
        injectScript("page", `import ${JSON.stringify(CLIENT_URL)};`);
      },
    },
  };
}

export default zeo;
