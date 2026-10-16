// Story 055, task 17.3 (refine v3) — the package's sourcemaps are self-contained (Q19, R3.1).
// Validation: `npm run build && npm test -- package-sourcemaps`. Found by 16.2's GUI proof: a Vite
// dev server on the packed tarball printed seven sourcemap warnings per start, because the maps
// point at `../src/*.ts`, which the package does not ship (`files: ["dist", ...]`).
//
// Contract (design.md §Tooling Decisions "Sourcemaps (v3)"): every JavaScript map under `dist/` —
// tsc's and the panel bundle's (`dist/panel/assets/main.js.map`) — carries `sourcesContent` with
// one non-null entry per `sources` entry, so nothing outside `dist/` is needed to read it. `src/`
// stays out of the package.
//
// Scope: `*.js.map`. Declaration maps (`*.d.ts.map`) map types for editors' go-to-definition, are
// never loaded by Vite or a browser, and tsc has no option to embed sources in them.
//
// Integration: reads the real build output; it does not build. A missing `dist/` fails with the
// command to run.
//
// Hostile halves first:
//   - a map with `sourcesContent` but a `null` (or missing) entry for one source is not
//     self-contained — counted per source, not per map;
//   - an entry that is present but is not the source (an empty string) is not either: each entry
//     for a file of this repository equals that file's text;
//   - converse: the guard actually looked — tsc's maps and the panel bundle's map are both found;
//   - the package does not ship `src/` to make the maps resolve.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const DIST = join(ROOT, "dist");

interface SourceMap {
  sources?: unknown;
  sourcesContent?: unknown;
  sourceRoot?: unknown;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

function jsMaps(): string[] {
  expect(
    existsSync(DIST),
    "dist/ is missing: run `npm run build` before `npm test -- package-sourcemaps`",
  ).toBe(true);
  return walk(DIST)
    .filter((f) => f.endsWith(".js.map"))
    .sort();
}

const read = (file: string): SourceMap => JSON.parse(readFileSync(file, "utf8")) as SourceMap;

/** The file a map's source entry names, resolved the way a browser or Vite resolves it. */
function sourcePath(mapFile: string, map: SourceMap, source: string): string {
  const root = typeof map.sourceRoot === "string" ? map.sourceRoot : "";
  return resolve(dirname(mapFile), root, source);
}

describe("packaged sourcemaps (Q19)", () => {
  it("converse: tsc's maps and the panel bundle's map are all found", () => {
    const maps = jsMaps().map((f) => relative(ROOT, f));
    expect(maps).toContain(join("dist", "index.js.map"));
    expect(maps).toContain(join("dist", "panel", "assets", "main.js.map"));
    expect(maps.length, maps.join("\n")).toBeGreaterThanOrEqual(10);
  });

  it("hostile: every source of every .js.map has a non-null sourcesContent entry", () => {
    const missing: string[] = [];
    for (const file of jsMaps()) {
      const map = read(file);
      const sources = Array.isArray(map.sources) ? (map.sources as unknown[]) : [];
      expect(sources.length, `${relative(ROOT, file)} names its sources`).toBeGreaterThan(0);
      const content = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
      sources.forEach((source, i) => {
        if (typeof content[i] !== "string") {
          missing.push(`${relative(ROOT, file)} → ${String(source)}`);
        }
      });
    }
    expect(missing, `sources with no embedded content:\n${missing.join("\n")}`).toEqual([]);
  });

  it("hostile: each embedded entry for a file of this repository is that file's text", () => {
    const wrong: string[] = [];
    for (const file of jsMaps()) {
      const map = read(file);
      const sources = Array.isArray(map.sources) ? (map.sources as unknown[]) : [];
      const content = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
      sources.forEach((source, i) => {
        const path = sourcePath(file, map, String(source));
        if (!path.startsWith(join(ROOT, "src") + "/") || !existsSync(path)) {
          return;
        }
        if (content[i] !== readFileSync(path, "utf8")) {
          wrong.push(`${relative(ROOT, file)} → ${relative(ROOT, path)}`);
        }
      });
    }
    expect(wrong, `entries that are not the source:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("the package does not ship src/ to make the maps resolve", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      files?: string[];
    };
    const files = pkg.files ?? [];
    expect(files.some((f) => /^\.?\/?src(\/|$)/.test(f))).toBe(false);
  });
});
