// Story 052, task 1.1 — the `.astro` tagger. Requirements: R1.1–R1.6.
// Contract: `tagAstroModule(code, id, root, exclude: Set<string>, compiler)` →
//   `{ code, map } | undefined`, writing `data-zeo-src="<rel>:<line>:<col>-<endLine>"` (1-based
//   line and column, as an editor shows them) and `data-zeo-c="<file name without .astro>"` on
//   every intrinsic element of the template. `compiler` is the `@astrojs/compiler-rs` module.
//
// Expected positions are computed from the source TEXT (string indices), never from the
// compiler, so the oracle is independent of how the compiler counts offsets.
//
// Hostile halves first:
//   - offsets: multi-byte characters (ç, →, an emoji) in the frontmatter, in a comment, in text
//     and on the same line before an element must not shift any line or column (wrongly
//     shifted), and the module must come back byte-identical once the inserted attributes are
//     removed (wrongly inserted mid-text);
//   - untagged names: script, style, slot, Fragment, Header, Foo.Bar and a dotted lowercase name
//     stay untagged (wrongly tagged) — while the elements nested INSIDE a slot, a Fragment and a
//     component, and the custom elements merely starting with those names, ARE tagged (wrongly
//     skipped);
//   - exclude is an exact name: `section` excluded leaves `section-card` tagged;
//   - expressions: elements inside `{list.map(...)}`, a ternary and `&&` are tagged;
//   - component name: two files in one run each name their own component (wrongly collapsed),
//     and every element of one file carries the same name (wrongly split by nesting);
//   - root with and without a trailing slash gives the same path (wrongly split);
//   - parse errors: a module whose error comes AFTER a well-formed element still comes back
//     unchanged (wrongly tagged from the partial tree), while a warning-only diagnostic still
//     tags (wrongly refused); a throwing `parse` returns undefined instead of throwing.
import * as compiler from "@astrojs/compiler-rs";
import { describe, expect, it } from "vitest";
import { tagAstroModule } from "../src/astro-tagger.js";

const ROOT = "/proj";
const NONE = new Set<string>();
const CARD_ID = `${ROOT}/src/components/Card.astro`;

function tag(code: string, id = CARD_ID, exclude: Set<string> = NONE, root = ROOT) {
  return tagAstroModule(code, id, root, exclude, compiler);
}

/** Every opening tag `<name …>` in `out`, as raw text. */
function openingTags(out: string, name: string): string[] {
  const re = new RegExp(`<${name.replace(".", "\\.")}(?=[\\s/>])[^>]*>`, "g");
  return out.match(re) ?? [];
}

/** Attributes of the n-th opening tag `<name …>` in `out`. */
function attrsOf(out: string, name: string, nth = 0): { src?: string; c?: string } | undefined {
  const raw = openingTags(out, name)[nth];
  if (raw === undefined) {
    return undefined;
  }
  return {
    src: raw.match(/data-zeo-src="([^"]*)"/)?.[1],
    c: raw.match(/data-zeo-c="([^"]*)"/)?.[1],
  };
}

const count = (out: string, needle: string) => out.split(needle).length - 1;

/** The module with every inserted attribute removed: must equal the input byte for byte. */
const stripped = (out: string) => out.replace(/\s+data-zeo-(?:src|c)="[^"]*"/g, "");

/** 1-based line and column of string index `index` in `text`. */
function lineCol(text: string, index: number): { line: number; col: number } {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  return { line, col: index - (before.lastIndexOf("\n") + 1) + 1 };
}

/**
 * The `data-zeo-src` value expected for the n-th occurrence of `open` (e.g. `<em>`) whose
 * element ends at the first `close` after it (e.g. `</em>`, or `/>` for a self-closing one).
 */
function expectedSrc(text: string, rel: string, open: string, close: string, nth = 0): string {
  let start = -1;
  for (let i = 0; i <= nth; i++) {
    start = text.indexOf(open, start + 1);
    if (start < 0) {
      throw new Error(`not in fixture: ${open} #${nth}`);
    }
  }
  const end = text.indexOf(close, start) + close.length - 1;
  const s = lineCol(text, start);
  return `${rel}:${s.line}:${s.col}-${lineCol(text, end).line}`;
}

const CARD = [
  "---", //                                                   1
  'import Header from "./Header.astro";', //                  2
  'import * as Foo from "./foo";', //                         3
  'const items = ["one", "two"];', //                         4
  'const markup = "<div>not a tag</div>";', //                5
  "const ok = true;", //                                      6
  "---", //                                                   7
  '<article class="card">', //                                8  col 1, ends 21
  "  <h2>Title</h2>", //                                      9  col 3
  "  <ul>", //                                                10 col 3, ends 12
  "    {items.map((i) => <li>{i}</li>)}", //                  11 col 23
  "  </ul>", //                                               12
  "  <div>{ok ? <b>yes</b> : <i>no</i>}{ok && <u>z</u>}</div>", // 13
  '  <Header title="x"><p id="in-component">child</p></Header>', // 14
  "  <Foo.Bar />", //                                         15
  "  <ui.button>dotted</ui.button>", //                       16
  "  <Fragment><span>in fragment</span></Fragment>", //       17
  "  <slot><em>fallback</em></slot>", //                      18
  "  <scripted>custom</scripted>", //                         19
  "  <styled-box>custom</styled-box>", //                     20
  "</article>", //                                            21
  "<style>", //                                               22
  "  article { color: red; }", //                             23
  "</style>", //                                              24
  "<script>", //                                              25
  '  const el = document.querySelector("article");', //       26
  "</script>", //                                             27
].join("\n");

const REL = "src/components/Card.astro";

describe("intrinsic elements get their source range (R1.1)", () => {
  it("writes the root-relative file, 1-based start line and column, and end line", () => {
    const out = tag(CARD);
    expect(out).toBeDefined();
    const code = out!.code;
    // Literal anchors, so the position helper itself cannot hide an off-by-one.
    expect(attrsOf(code, "article")?.src).toBe(`${REL}:8:1-21`);
    expect(attrsOf(code, "h2")?.src).toBe(`${REL}:9:3-9`);
    expect(attrsOf(code, "ul")?.src).toBe(`${REL}:10:3-12`);
    expect(attrsOf(code, "li")?.src).toBe(`${REL}:11:23-11`);
  });

  it("tags elements inside template expressions: .map(), a ternary and &&", () => {
    const code = tag(CARD)!.code;
    expect(attrsOf(code, "li")?.src).toBe(expectedSrc(CARD, REL, "<li>", "</li>"));
    expect(attrsOf(code, "b")?.src).toBe(expectedSrc(CARD, REL, "<b>", "</b>"));
    expect(attrsOf(code, "i")?.src).toBe(expectedSrc(CARD, REL, "<i>", "</i>"));
    expect(attrsOf(code, "u")?.src).toBe(expectedSrc(CARD, REL, "<u>", "</u>"));
  });

  it("changes nothing but the inserted attributes: frontmatter, style and script stay as written", () => {
    const code = tag(CARD)!.code;
    expect(stripped(code)).toBe(CARD);
    const frontmatter = CARD.slice(0, CARD.indexOf("---", 3) + 3);
    expect(code.startsWith(frontmatter)).toBe(true);
    expect(code).toContain('const markup = "<div>not a tag</div>";');
  });

  it("tags exactly the intrinsic elements: one attribute pair per element, no more", () => {
    const code = tag(CARD)!.code;
    // article h2 ul li div b i u p span em scripted styled-box
    expect(count(code, "data-zeo-src=")).toBe(13);
    expect(count(code, "data-zeo-c=")).toBe(13);
  });

  it("returns undefined when the template has nothing to tag", () => {
    const onlyComponents = [
      "---",
      'import Header from "./Header.astro";',
      "---",
      '<Header title="x" />',
      "<slot />",
      "<style>p { color: red; }</style>",
      "<script>console.debug(1);</script>",
    ].join("\n");
    expect(tag(onlyComponents)).toBeUndefined();
    expect(tag("---\nconst x = 1;\n---\n")).toBeUndefined();
    expect(tag("")).toBeUndefined();
  });

  it("hostile split: a root with a trailing slash gives the same path", () => {
    const a = tag(CARD, CARD_ID, NONE, "/proj")!.code;
    const b = tag(CARD, CARD_ID, NONE, "/proj/")!.code;
    expect(attrsOf(b, "article")?.src).toBe(`${REL}:8:1-21`);
    expect(b).toBe(a);
  });
});

describe("the component is the file name (R1.2)", () => {
  it("names every element of a component file after the file, however deeply nested", () => {
    const code = tag(CARD)!.code;
    for (const name of ["article", "h2", "li", "b", "p", "span", "em", "styled-box"]) {
      expect(attrsOf(code, name)?.c, name).toBe("Card");
    }
  });

  it("hostile collapse: two files each name their own component, not the first one tagged", () => {
    const body = '<div class="x"><span>s</span></div>';
    const header = tag(body, `${ROOT}/src/components/Header.astro`)!.code;
    const footer = tag(body, `${ROOT}/src/components/Footer.astro`)!.code;
    expect(attrsOf(header, "div")?.c).toBe("Header");
    expect(attrsOf(header, "div")?.src).toBe("src/components/Header.astro:1:1-1");
    expect(attrsOf(footer, "div")?.c).toBe("Footer");
    expect(attrsOf(footer, "span")?.src).toBe("src/components/Footer.astro:1:16-1");
  });

  it("names a page after its file: src/pages/index.astro gives index", () => {
    const code = tag("<main><h1>Home</h1></main>", `${ROOT}/src/pages/index.astro`)!.code;
    expect(attrsOf(code, "main")).toEqual({ src: "src/pages/index.astro:1:1-1", c: "index" });
    expect(attrsOf(code, "h1")?.c).toBe("index");
  });

  it("a component used in the template does not rename the file's own elements", () => {
    const code = tag(
      '---\nimport Header from "./Header.astro";\n---\n<section><Header /><header>own</header></section>',
      `${ROOT}/src/components/Hero.astro`,
    )!.code;
    expect(attrsOf(code, "section")?.c).toBe("Hero");
    expect(attrsOf(code, "header")?.c).toBe("Hero");
  });
});

describe("what stays untagged (R1.3)", () => {
  it("hostile: script, style, slot, Fragment, a component and dotted names carry no attribute", () => {
    const code = tag(CARD)!.code;
    for (const name of ["script", "style", "slot", "Fragment", "Header", "Foo.Bar", "ui.button"]) {
      const tags = openingTags(code, name);
      expect(tags.length, `${name} present in output`).toBeGreaterThan(0);
      for (const raw of tags) {
        expect(raw, name).not.toMatch(/data-zeo-/);
      }
    }
  });

  it("an attribute on <script> would inline it: is:inline and is:global ones stay untouched too", () => {
    const src =
      "<p>x</p>\n<script is:inline>a()</script>\n<style is:global>p { margin: 0; }</style>";
    const code = tag(src)!.code;
    expect(code).toContain("<script is:inline>a()</script>");
    expect(code).toContain("<style is:global>p { margin: 0; }</style>");
  });

  it("converse: elements nested inside a slot, a Fragment and a component ARE tagged", () => {
    const code = tag(CARD)!.code;
    expect(attrsOf(code, "em")?.src).toBe(expectedSrc(CARD, REL, "<em>", "</em>"));
    expect(attrsOf(code, "span")?.src).toBe(expectedSrc(CARD, REL, "<span>", "</span>"));
    expect(attrsOf(code, "p")?.src).toBe(expectedSrc(CARD, REL, '<p id="in-component">', "</p>"));
  });

  it("converse: custom elements whose names merely start with script/style are tagged", () => {
    const code = tag(CARD)!.code;
    expect(attrsOf(code, "scripted")?.src).toBe(
      expectedSrc(CARD, REL, "<scripted>", "</scripted>"),
    );
    expect(attrsOf(code, "styled-box")?.src).toBe(
      expectedSrc(CARD, REL, "<styled-box>", "</styled-box>"),
    );
  });

  it("a tag in the exclude set stays untagged; a longer name sharing its prefix does not", () => {
    const src = "<div><section>a</section><section-card>b</section-card><mesh /></div>";
    const code = tag(src, CARD_ID, new Set(["section", "mesh"]))!.code;
    expect(openingTags(code, "section")[0]).not.toMatch(/data-zeo-/);
    expect(openingTags(code, "mesh")[0]).not.toMatch(/data-zeo-/);
    expect(attrsOf(code, "section-card")?.src).toBe(`${REL}:1:26-1`);
    expect(attrsOf(code, "div")?.src).toBe(`${REL}:1:1-1`);
  });
});

describe("multi-byte characters do not shift positions (R1.4)", () => {
  const UTF = [
    "---", //                                                     1
    'const greeting = "Olá, 😀 mundo → ç";', //                   2
    "---", //                                                     3
    "<!-- emoji 😀😀 and ç → before the elements -->", //         4
    "<p>ç → 😀 ok</p>", //                                        5  col 1
    '<section id="after">', //                                    6  col 1, ends 9
    "  <span>açúcar → café</span><em>x</em>", //                  7  em: col 29
    "  <strong>😀</strong>", //                                   8
    "</section>", //                                              9
    "<footer>{['ç', '→'].map((s) => <b>{s}</b>)}</footer>", //    10
  ].join("\n");
  const rel = "src/components/Utf.astro";
  const id = `${ROOT}/${rel}`;

  it("hostile: an element after multi-byte text keeps the line and column an editor shows", () => {
    const code = tag(UTF, id)!.code;
    expect(attrsOf(code, "p")?.src).toBe(`${rel}:5:1-5`);
    expect(attrsOf(code, "section")?.src).toBe(`${rel}:6:1-9`);
    expect(attrsOf(code, "span")?.src).toBe(`${rel}:7:3-7`);
    // Same line, after BMP multi-byte text (ç, ú, →, é): the column counts characters.
    expect(attrsOf(code, "em")?.src).toBe(`${rel}:7:29-7`);
    expect(attrsOf(code, "strong")?.src).toBe(`${rel}:8:3-8`);
    expect(attrsOf(code, "footer")?.src).toBe(`${rel}:10:1-10`);
    expect(attrsOf(code, "b")?.src).toBe(expectedSrc(UTF, rel, "<b>", "</b>"));
  });

  it("hostile: every attribute lands inside its own opening tag, and the text is intact", () => {
    const code = tag(UTF, id)!.code;
    expect(stripped(code)).toBe(UTF);
    expect(code).toMatch(/<em data-zeo-src="[^"]*"[^>]*>x<\/em>/);
    expect(code).toContain(">açúcar → café</span>");
    expect(code).toContain(">😀</strong>");
    expect(count(code, "data-zeo-src=")).toBe(7);
  });
});

/** Minimal VLQ decoder for source map `mappings` (no dependency on a map library). */
function decodeMappings(mappings: string): number[][][] {
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lines: number[][][] = [];
  const state = [0, 0, 0, 0, 0];
  for (const line of mappings.split(";")) {
    const segments: number[][] = [];
    state[0] = 0;
    for (const raw of line.split(",")) {
      if (raw === "") {
        continue;
      }
      const values: number[] = [];
      let value = 0;
      let shift = 0;
      for (const ch of raw) {
        const digit = B64.indexOf(ch);
        value += (digit & 31) << shift;
        if (digit & 32) {
          shift += 5;
        } else {
          values.push(value & 1 ? -(value >>> 1) : value >>> 1);
          value = 0;
          shift = 0;
        }
      }
      const seg: number[] = [];
      for (let i = 0; i < values.length; i++) {
        state[i] = (state[i] ?? 0) + values[i]!;
        seg.push(state[i]!);
      }
      segments.push(seg);
    }
    lines.push(segments);
  }
  return lines;
}

/** Original (0-based line, 0-based column) of a generated position, by the nearest segment. */
function originalOf(mappings: string, line0: number, col0: number) {
  const segments = decodeMappings(mappings)[line0] ?? [];
  const before = segments.filter((s) => s[0]! <= col0 && s.length >= 4);
  const seg = before[before.length - 1];
  if (seg === undefined) {
    return undefined;
  }
  return { line0: seg[2]!, col0: seg[3]! + (col0 - seg[0]!) };
}

describe("a source map comes back (R1.5)", () => {
  it("carries the original content and keeps every line on its own line", () => {
    const out = tag(CARD)!;
    const map = out.map as unknown as { mappings: string; sourcesContent?: (string | null)[] };
    expect(typeof map.mappings).toBe("string");
    expect(map.mappings).not.toBe("");
    expect(map.sourcesContent?.[0]).toBe(CARD);
    expect(out.code.split("\n")).toHaveLength(CARD.split("\n").length);
  });

  it("maps an element shifted by an earlier insertion on its line back to its original column", () => {
    const src = "<div><span>a</span><em>b</em></div>\n<p>two</p>";
    const out = tag(src)!;
    const map = out.map as unknown as { mappings: string };
    const generated = out.code.split("\n")[0]!.indexOf("<em");
    expect(generated).toBeGreaterThan(src.indexOf("<em")); // really shifted
    expect(originalOf(map.mappings, 0, generated)).toEqual({ line0: 0, col0: src.indexOf("<em") });
    const p = out.code.split("\n")[1]!.indexOf("<p");
    expect(originalOf(map.mappings, 1, p)).toEqual({ line0: 1, col0: 0 });
  });
});

describe("a module that does not parse is left alone (R1.6)", () => {
  it("hostile: an error AFTER a well-formed element still returns undefined", () => {
    const broken = "<p>fine</p>\n<div attr={></div>";
    expect(compiler.parse(broken).diagnostics.length).toBeGreaterThan(0); // non-vacuous
    expect(tag(broken)).toBeUndefined();
  });

  it("a frontmatter syntax error returns undefined, though the template is well formed", () => {
    expect(tag("---\nconst = ;\n---\n<p>x</p>")).toBeUndefined();
  });

  it("an unclosed element returns undefined", () => {
    expect(tag("<div><p>unclosed</div>")).toBeUndefined();
  });

  it("a parse() that throws gives undefined instead of an exception", () => {
    const throwing = {
      ...compiler,
      parse: () => {
        throw new Error("binding crashed");
      },
    } as unknown as typeof compiler;
    expect(() => tagAstroModule("<p>x</p>", CARD_ID, ROOT, NONE, throwing)).not.toThrow();
    expect(tagAstroModule("<p>x</p>", CARD_ID, ROOT, NONE, throwing)).toBeUndefined();
  });

  it("converse: a warning-only diagnostic is not a parse error, so the module is tagged", () => {
    const warning = {
      ...compiler,
      parse: (source: string) => {
        const result = compiler.parse(source);
        return {
          ...result,
          diagnostics: [
            ...result.diagnostics,
            { severity: "warning", text: "a warning", hint: "", labels: [] },
          ],
        };
      },
    } as unknown as typeof compiler;
    const out = tagAstroModule("<p>x</p>", CARD_ID, ROOT, NONE, warning);
    expect(attrsOf(out!.code, "p")?.src).toBe(`${REL}:1:1-1`);
  });
});
