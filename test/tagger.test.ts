// Story 033, task 3.1 — the source tagger (design.md §A1). Requirements: R1.1–R1.5.
// Contract: `tagModule(code, id, root, exclude: Set<string>)` →
//   `{ code, map } | null`, writing `data-zeo-src="<rel>:<line>:<col>-<endLine>"` (1-based
//   line and column) and `data-zeo-c="<Component>"` on intrinsic elements.
//
// Hostile halves first:
//   - scope: `/proj2/...` shares `/proj` as a string prefix and must NOT be tagged; a
//     directory merely named like node_modules (`my_node_modules`) MUST still be tagged.
//   - component naming: two components in one file must each name their own elements
//     (wrongly collapsed onto the first); a lowercase helper nested inside a component must
//     not hide the component's name (wrongly split off).
//   - idempotence: a second pass adds nothing, AND a hand-written `data-zeo-src` is left as
//     written while its untagged sibling is still tagged.
//   - exclude is an exact name: `canvas` excluded must not exclude `canvas-wrapper`.
import { describe, expect, it } from "vitest";
import { tagModule } from "../src/tagger.js";

const ROOT = "/proj";
const NONE = new Set<string>();

function tag(code: string, id = `${ROOT}/src/App.tsx`, exclude = NONE) {
  return tagModule(code, id, ROOT, exclude);
}

/** The n-th opening tag `<name ...>` in `out`, as raw text. */
function openingTag(out: string, name: string, nth = 0): string | undefined {
  const re = new RegExp(`<${name}(?=[\\s/>])[^>]*>`, "g");
  return out.match(re)?.[nth];
}

/** Attributes of the n-th opening tag `<name ...>` in `out`. */
function attrsOf(out: string, name: string, nth = 0): { src?: string; c?: string } | undefined {
  const raw = openingTag(out, name, nth);
  if (raw === undefined) {
    return undefined;
  }
  return {
    src: raw.match(/data-zeo-src="([^"]*)"/)?.[1],
    c: raw.match(/data-zeo-c="([^"]*)"/)?.[1],
  };
}

const count = (out: string, needle: string) => out.split(needle).length - 1;

const APP = [
  "export function App() {", //            1
  "  return (", //                          2
  '    <div className="a">', //            3  col 5
  "      <span>hi</span>", //               4  col 7
  '      <img alt="x" />', //              5  col 7
  "    </div>", //                          6
  "  );", //                                7
  "}", //                                   8
].join("\n");

describe("intrinsic elements get their source range (R1.1)", () => {
  it("writes project-relative file, 1-based start line and column, and end line", () => {
    const out = tag(APP);
    expect(out).not.toBeNull();
    const code = out!.code;
    expect(attrsOf(code, "div")?.src).toBe("src/App.tsx:3:5-6");
    expect(attrsOf(code, "span")?.src).toBe("src/App.tsx:4:7-4");
    expect(attrsOf(code, "img")?.src).toBe("src/App.tsx:5:7-5");
  });

  it("tags .jsx modules too", () => {
    const out = tag("export const A = () => <p>x</p>;", `${ROOT}/src/A.jsx`);
    expect(attrsOf(out!.code, "p")?.src).toBe("src/A.jsx:1:24-1");
  });

  it("returns a source map", () => {
    const out = tag(APP);
    expect(out!.map).toBeDefined();
    expect(String((out!.map as { mappings?: string }).mappings ?? "")).not.toBe("");
  });

  it("parses TypeScript generics in .tsx and still tags", () => {
    const code = [
      "function List<T,>(props: { items: T[] }) {",
      "  const id = <U,>(x: U): U => x;",
      "  return <ul>{props.items.map((i) => id(String(i)))}</ul>;",
      "}",
    ].join("\n");
    const out = tag(code, `${ROOT}/src/List.tsx`);
    expect(attrsOf(out!.code, "ul")?.src).toBe("src/List.tsx:3:10-3");
    expect(attrsOf(out!.code, "ul")?.c).toBe("List");
  });

  it("keeps offsets right after astral characters (UTF-16 offsets)", () => {
    const out = tag("export const E = () => <div>😀😀<b>x</b></div>;", `${ROOT}/src/E.tsx`);
    const code = out!.code;
    expect(code).toContain("😀😀");
    expect(code).toMatch(/<b\s+[^>]*data-zeo-src="src\/E\.tsx:1:/);
    expect(code).toMatch(/<\/b><\/div>/);
  });

  it("tags a custom element (dash in a lowercase name)", () => {
    const out = tag("export const W = () => <canvas-wrapper />;", `${ROOT}/src/W.tsx`);
    expect(attrsOf(out!.code, "canvas-wrapper")?.src).toBeDefined();
  });
});

describe("module scope (R1.1)", () => {
  it("hostile: a sibling directory sharing the root as a string prefix is not tagged", () => {
    expect(tag(APP, "/proj2/src/App.tsx")).toBeNull();
  });
  it("leaves node_modules and files outside the root alone", () => {
    expect(tag(APP, `${ROOT}/node_modules/lib/App.tsx`)).toBeNull();
    expect(tag(APP, "/elsewhere/App.tsx")).toBeNull();
  });
  it("hostile converse: a directory merely named like node_modules is still tagged", () => {
    const out = tag(APP, `${ROOT}/src/my_node_modules/App.tsx`);
    expect(out).not.toBeNull();
    expect(attrsOf(out!.code, "div")?.src).toBe("src/my_node_modules/App.tsx:3:5-6");
  });
  it("leaves .ts and .js modules alone", () => {
    expect(tag("export const x = 1 < 2;", `${ROOT}/src/x.ts`)).toBeNull();
    expect(tag("export const x = 1 < 2;", `${ROOT}/src/x.js`)).toBeNull();
  });
  it("leaves a module with no `<` alone", () => {
    expect(tag("export const x = 1;", `${ROOT}/src/x.tsx`)).toBeNull();
  });
});

describe("component name (R1.2)", () => {
  it("hostile: two components in one file each name their own elements", () => {
    const code = [
      "export function Header() { return <header>h</header>; }",
      "export const Footer = () => <footer>f</footer>;",
    ].join("\n");
    const out = tag(code, `${ROOT}/src/Layout.tsx`)!.code;
    expect(attrsOf(out, "header")?.c).toBe("Header");
    expect(attrsOf(out, "footer")?.c).toBe("Footer");
  });

  it("hostile: a lowercase helper inside a component does not hide the component", () => {
    const code = [
      "export const Card = () => {",
      "  function helper() { return <i>x</i>; }",
      "  const render = () => <em>y</em>;",
      "  return <section>{helper()}{render()}</section>;",
      "};",
    ].join("\n");
    const out = tag(code, `${ROOT}/src/Card.tsx`)!.code;
    expect(attrsOf(out, "i")?.c).toBe("Card");
    expect(attrsOf(out, "em")?.c).toBe("Card");
    expect(attrsOf(out, "section")?.c).toBe("Card");
  });

  it("takes the nearest uppercase declaration when components nest", () => {
    const code = [
      "export function Outer() {",
      "  const Inner = () => <span>in</span>;",
      "  return <div><Inner /></div>;",
      "}",
    ].join("\n");
    const out = tag(code, `${ROOT}/src/Nest.tsx`)!.code;
    expect(attrsOf(out, "span")?.c).toBe("Inner");
    expect(attrsOf(out, "div")?.c).toBe("Outer");
  });

  it("names function-expression components", () => {
    const out = tag(
      "export const Modal = function () { return <dialog />; };",
      `${ROOT}/src/M.tsx`,
    )!.code;
    expect(attrsOf(out, "dialog")?.c).toBe("Modal");
  });

  it("gives no component name outside any uppercase declaration, but still tags", () => {
    const code = ["const el = <aside>a</aside>;", "function render() { return <p>p</p>; }"].join(
      "\n",
    );
    const out = tag(code, `${ROOT}/src/Plain.tsx`)!.code;
    expect(attrsOf(out, "aside")?.src).toBeDefined();
    expect(attrsOf(out, "aside")?.c).toBeUndefined();
    expect(attrsOf(out, "p")?.src).toBeDefined();
    expect(attrsOf(out, "p")?.c).toBeUndefined();
  });
});

describe("elements left alone (R1.3)", () => {
  it("components, fragments, member and namespaced names carry no attribute", () => {
    const code = [
      "import React from 'react';",
      "export function App() {",
      "  return (",
      "    <>",
      "      <Button label='x' />",
      "      <React.Fragment><motion.div /></React.Fragment>",
      "      <svg><svg:rect /></svg>",
      "    </>",
      "  );",
      "}",
    ].join("\n");
    const out = tag(code)!.code;
    expect(out).toMatch(/<Button label='x' \/>/);
    expect(out).toMatch(/<React\.Fragment>/);
    expect(out).toMatch(/<motion\.div \/>/);
    expect(out).toMatch(/<svg:rect \/>/);
    expect(out).toMatch(/<>/);
    expect(count(out, "data-zeo-src")).toBe(1); // only <svg>
    expect(attrsOf(out, "svg")?.src).toBeDefined();
  });

  it("an excluded tag is left alone; exact names only (hostile: canvas-wrapper stays tagged)", () => {
    const code = "export const S = () => <div><canvas /><canvas-wrapper /></div>;";
    const out = tag(code, `${ROOT}/src/S.tsx`, new Set(["canvas"]))!.code;
    expect(out).toMatch(/<canvas \/>/);
    expect(attrsOf(out, "canvas-wrapper")?.src).toBeDefined();
    expect(attrsOf(out, "div")?.src).toBeDefined();
  });
});

describe("parse errors (R1.4)", () => {
  it("returns null and does not throw on a syntax error", () => {
    expect(() => tag("export const A = () => <div>;", `${ROOT}/src/Bad.tsx`)).not.toThrow();
    expect(tag("export const A = () => <div>;", `${ROOT}/src/Bad.tsx`)).toBeNull();
  });
});

describe("idempotence (R1.5)", () => {
  it("a second pass produces the same output, with no duplicated attribute", () => {
    const first = tag(APP)!.code;
    const second = tag(first);
    expect(second?.code ?? first).toBe(first);
    expect(count(first, "data-zeo-src")).toBe(3);
    expect(count(first, "data-zeo-c")).toBe(3);
  });

  it("hostile: a hand-written data-zeo-src is kept as written, and its sibling still tagged", () => {
    const line2 = '  return <div><p data-zeo-src="custom:1:1-1">a</p><p>b</p></div>;';
    const code = ["export function App() {", line2, "}"].join("\n");
    const out = tag(code)!.code;
    const handWritten = openingTag(out, "p", 0)!;
    expect(attrsOf(out, "p", 0)?.src).toBe("custom:1:1-1");
    expect(count(handWritten, "data-zeo-src")).toBe(1);
    const siblingCol = line2.lastIndexOf("<p>") + 1;
    expect(attrsOf(out, "p", 1)?.src).toBe(`src/App.tsx:2:${siblingCol}-2`);
  });
});
