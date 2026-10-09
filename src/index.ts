// @lucascouts/vite-plugin-zeo (story 033): in `vite dev`, tag every intrinsic JSX element with
// its source and relay picker selections to Zeo's devtools bridge. Both plugins are
// serve-only, so `vite build` output carries nothing of either (R11.1).
import type { Plugin } from "vite";
import { z } from "zod";
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
/** plugin-react's `compiler: true` plugin: also `enforce: "pre"`, and it compiles JSX away. */
const REACT_COMPILER = "vite:react-compiler";
const JSX_ID = /\.[jt]sx(?:$|\?)/;

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

  // Completed by Task 5.2: serves the picker client and relays `zeo:select` to Zeo.
  const relay: Plugin = {
    name: "zeo-devtools:relay",
    apply: "serve",
  };

  return [tagger, relay];
}

export default zeo;
