// Story 033, task 3.2 — the Vite plugin wrapper, against a REAL `createServer` and a REAL
// `build()` over `test/fixtures/app` (design.md §A1, §Security "Production builds").
// Requirements: R1.1 (served module tagged), R1.3 (default exclude list), R1.6, R11.1.
// Contract: `zeo(options?: ZeoPluginOptions): Plugin[]` — serve-only plugins, the first (the
// tagger) `enforce: 'pre'`. Story 052 (task 1.2) added a third, the `.astro` tagger, between the
// tagger and the relay; its own checks are in test/astro-plugin.order.test.ts.
//
// Hostile halves: plugin order — react() listed BEFORE zeo() must still tag (the case that
// breaks without `enforce: 'pre'`), and zeo() before react() must tag too. A request id
// carrying a query (`?t=…`, as HMR re-requests carry) must still be tagged. The build check
// first proves the output is the fixture's (its own text is there), so "no data-zeo-" is
// not vacuously true of an empty bundle.
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { zeo } from "../src/index.js";
import react from "@vitejs/plugin-react";
import { build, createServer, type ViteDevServer } from "vite";

const ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));

async function devServer(order: "react-first" | "zeo-first"): Promise<ViteDevServer> {
  const plugins = order === "react-first" ? [react(), zeo()] : [zeo(), react()];
  return createServer({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    plugins,
    server: { middlewareMode: true, hmr: false },
  });
}

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath ?? (e as unknown as { path: string }).path, e.name));
}

describe("zeo() shape", () => {
  it("returns three serve-only plugins, the first enforced pre", () => {
    const plugins = zeo();
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins).toHaveLength(3);
    for (const p of plugins) {
      expect(p.apply).toBe("serve");
    }
    expect(plugins[0]?.enforce).toBe("pre");
  });
});

describe("dev server tags the served module (R1.1, R1.6)", () => {
  const servers: ViteDevServer[] = [];
  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  it("hostile: with @vitejs/plugin-react listed BEFORE zeo()", async () => {
    const server = await devServer("react-first");
    servers.push(server);
    const result = await server.transformRequest("/src/App.tsx");
    expect(result?.code).toMatch(/data-zeo-src/);
    expect(result?.code).toMatch(/src\/App\.tsx:\d+:\d+-\d+/);
    expect(result?.code).toMatch(/data-zeo-c/);
  });

  it("with zeo() listed before @vitejs/plugin-react", async () => {
    const server = await devServer("zeo-first");
    servers.push(server);
    const result = await server.transformRequest("/src/App.tsx");
    expect(result?.code).toMatch(/data-zeo-src/);
  });

  it("hostile: a request id with a query is still tagged", async () => {
    const server = await devServer("react-first");
    servers.push(server);
    const result = await server.transformRequest("/src/App.tsx?t=1700000000000");
    expect(result?.code).toMatch(/data-zeo-src/);
  });

  it("applies the default exclude list (react-three-fiber intrinsics) with no option (R1.3)", async () => {
    const server = await devServer("react-first");
    servers.push(server);
    const code = (await server.transformRequest("/src/Scene.tsx"))?.code ?? "";
    expect(code).toMatch(/["']div["'],\s*\{[^}]*data-zeo-src/);
    expect(code).not.toMatch(/["']mesh["'],\s*\{[^}]*data-zeo-src/);
  });
});

describe("vite build emits nothing of the plugin (R11.1)", () => {
  let outDir = "";
  let output = "";

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), "zeo-build-"));
    await build({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      plugins: [react(), zeo()],
      build: { outDir, emptyOutDir: true, minify: false },
    });
    const files = await filesUnder(outDir);
    output = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
  }, 60_000);

  afterAll(async () => {
    if (outDir) {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  it("first: the output is really the fixture's (non-vacuous)", () => {
    expect(output).toContain("Fixture app ready");
  });

  it("holds no tagging attribute and no picker client", () => {
    expect(output).not.toContain("data-zeo-");
    expect(output).not.toContain("@zeo-devtools");
    expect(output).not.toContain("zeo:select");
  });
});
