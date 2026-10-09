// Story 033, task 3.1 — regressions found by the tech review of the tagger (2026-10-09).
import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import { tagModule } from "../src/tagger.js";

const tag = (code: string, file = "src/A.tsx") =>
  tagModule(code, `/proj/${file}`, "/proj", new Set());

describe("tech review regressions", () => {
  it("inserts after TSX type arguments, so the output still parses", () => {
    const out = tag("export const A = () => <div<string> id='x' />;")!.code;
    expect(() =>
      parse(out, { sourceType: "module", plugins: ["jsx", "typescript"] }),
    ).not.toThrow();
    expect(out).toMatch(/<div<string> data-zeo-src="/);
  });

  it("names memo() and forwardRef() components", () => {
    const out = tag(
      [
        "export const Badge = memo(() => <b>x</b>);",
        "export const Field = React.forwardRef((p, ref) => <input ref={ref} />);",
      ].join("\n"),
    )!.code;
    expect(out).toMatch(/<b [^>]*data-zeo-c="Badge"/);
    expect(out).toMatch(/<input [^>]*data-zeo-c="Field"/);
  });

  it("names class components, and a lowercase call still gives no name", () => {
    const out = tag(
      [
        "export class Panel { render() { return <div>p</div>; } }",
        "export const x = wrap(() => <i>i</i>);",
      ].join("\n"),
    )!.code;
    expect(out).toMatch(/<div [^>]*data-zeo-c="Panel"/);
    expect(out).not.toMatch(/<i [^>]*data-zeo-c=/);
  });
});

describe("plugin wrapper review regressions (3.2)", () => {
  it("refuses invalid options when zeo() is called, whatever the command", async () => {
    const { zeo } = await import("../src/index.js");
    expect(() => zeo({ screenshot: "yes" } as never)).toThrow(/invalid options/);
  });

  it("does not tag under Vitest's mode 'test', and does under development", async () => {
    const { zeo } = await import("../src/index.js");
    const { createServer } = await import("vite");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("./fixtures/app", import.meta.url));
    for (const [mode, tagged] of [
      ["test", false],
      ["development", true],
    ] as const) {
      const server = await createServer({
        root,
        mode,
        configFile: false,
        logLevel: "silent",
        plugins: [zeo()],
        server: { middlewareMode: true, hmr: false },
      });
      const code = (await server.transformRequest("/src/App.tsx"))?.code ?? "";
      await server.close();
      expect(code.includes("data-zeo-src"), mode).toBe(tagged);
    }
  });
});

describe("one zeo() result shared by two servers (3.2 review, cycle 2)", () => {
  it("a later mode 'test' server does not stop the development server from tagging", async () => {
    const { zeo } = await import("../src/index.js");
    const { createServer } = await import("vite");
    const { fileURLToPath } = await import("node:url");
    const root = fileURLToPath(new URL("./fixtures/app", import.meta.url));
    const plugins = zeo();
    const make = (mode: string) =>
      createServer({
        root,
        mode,
        configFile: false,
        logLevel: "silent",
        plugins,
        server: { middlewareMode: true, hmr: false },
      });
    const dev = await make("development");
    const test = await make("test");
    try {
      expect((await test.transformRequest("/src/App.tsx"))?.code ?? "").not.toContain(
        "data-zeo-src",
      );
      dev.moduleGraph.invalidateAll();
      expect((await dev.transformRequest("/src/App.tsx"))?.code ?? "").toContain("data-zeo-src");
    } finally {
      await Promise.all([dev.close(), test.close()]);
    }
  });
});
