// Story 052, task 1.1 — tech-review regression (fix round 1): raw-text containers.
// Requirements: R1.1, R1.3.
//
// compiler-rs parses markup inside `<textarea>`, `<title>`, `<xmp>`, … as real elements, but the
// browser shows the content of these containers as text: a `data-zeo-src` written on a child
// would become visible (a textarea's default value, the tab title, xmp content). The container
// itself is still tagged; nothing inside it is, an expression child included.
//
// Hostile halves: the child stays untagged (wrongly tagged), while the container and a sibling
// after it ARE tagged (wrongly skipped by a fix that drops the whole subtree or stops the walk).
import * as compiler from "@astrojs/compiler-rs";
import { describe, expect, it } from "vitest";
import { tagAstroModule } from "../src/astro-tagger.js";

const ROOT = "/proj";
const ID = `${ROOT}/src/components/Raw.astro`;

function tag(code: string) {
  return tagAstroModule(code, ID, ROOT, new Set(), compiler);
}

/** Every opening tag `<name …>` in `out`, as raw text. */
function openingTags(out: string, name: string): string[] {
  return out.match(new RegExp(`<${name}(?=[\\s/>])[^>]*>`, "g")) ?? [];
}

const isTagged = (raw: string | undefined) => raw !== undefined && /data-zeo-src="/.test(raw);

const RAW_TEXT = [
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noscript",
  "noembed",
  "noframes",
  "plaintext",
] as const;

describe("raw-text containers: tagged themselves, their content left alone (R1.1, R1.3)", () => {
  for (const name of RAW_TEXT) {
    it(`<${name}> is tagged and the <b> inside it is not`, () => {
      const out = tag(`<${name}><b>x</b></${name}>`);
      expect(out).toBeDefined();
      const code = out!.code;
      expect(isTagged(openingTags(code, name)[0]), name).toBe(true);
      expect(openingTags(code, "b")).toEqual(["<b>"]);
      expect(code).toContain(`><b>x</b></${name}>`);
    });
  }

  // `plaintext` is left out: the browser turns everything after it into text, siblings included,
  // and this case only pins that the fix does not stop the walk at the container.
  for (const name of RAW_TEXT.filter((n) => n !== "plaintext")) {
    it(`a sibling after <${name}> is still tagged`, () => {
      const code = tag(`<div><${name}><b>x</b></${name}><p>after</p></div>`)!.code;
      expect(isTagged(openingTags(code, "div")[0])).toBe(true);
      expect(isTagged(openingTags(code, name)[0])).toBe(true);
      expect(isTagged(openingTags(code, "p")[0])).toBe(true);
      expect(openingTags(code, "b")).toEqual(["<b>"]);
    });
  }

  it("<noscript> inside <head>: head and noscript tagged, the markup inside untagged", () => {
    const src = [
      "<html>",
      "  <head>",
      '    <noscript><link rel="stylesheet" href="/no-js.css" /><b>x</b></noscript>',
      "  </head>",
      "  <body><p>y</p></body>",
      "</html>",
    ].join("\n");
    const code = tag(src)!.code;
    for (const name of ["html", "head", "noscript", "body", "p"]) {
      expect(isTagged(openingTags(code, name)[0]), name).toBe(true);
    }
    expect(openingTags(code, "link")).toEqual(['<link rel="stylesheet" href="/no-js.css" />']);
    expect(openingTags(code, "b")).toEqual(["<b>"]);
  });

  it("an expression child inside <title> stays untagged", () => {
    const code = tag("<head><title>{cond && <b>x</b>}</title></head>")!.code;
    expect(isTagged(openingTags(code, "head")[0])).toBe(true);
    expect(isTagged(openingTags(code, "title")[0])).toBe(true);
    expect(code).toContain("{cond && <b>x</b>}</title>");
  });

  it("the same <b> outside a container is tagged, so the checks above can fail", () => {
    const code = tag("<div><b>x</b></div>")!.code;
    expect(isTagged(openingTags(code, "b")[0])).toBe(true);
  });
});
