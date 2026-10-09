// @vitest-environment happy-dom
// Story 033, task 4.1 — the DOM summary builder (design.md §Data Models `dom`).
// Requirements: R4.1, R4.2, R4.3.
// Contract: `summarize(el: Element, win: Window): DomSummary`, whose shape is the wire
// `dom` object: { tag, id, classes, text, attrs, styles, rect: { x, y, w, h } }.
//
// Hostile halves first:
//   - form values: an <input>'s typed value and a <textarea>'s content must never appear
//     anywhere in the summary (wrongly included), while the input's allowlisted `name`
//     MUST be kept (wrongly dropped by a blanket "skip form fields").
//   - attribute allowlist: `aria-valuenow` — a value-looking name — must be kept; `data-*`,
//     `onclick`, `style`, `title` must be dropped.
//   - the 4 KiB cap is UTF-8 bytes (multi-byte classes); truncation order is text first,
//     then classes, then styles: classes survive while cutting text is enough.
import { beforeEach, describe, expect, it } from "vitest";
import { summarize } from "../../src/client/summary.js";
import { DOM_SUMMARY_MAX_BYTES, STYLE_KEYS } from "../../src/contract.js";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

/** Mounts trusted, test-authored markup through DOMParser and returns its first element. */
function mount(markup: string): Element {
  const parsed = new DOMParser().parseFromString(`<body>${markup}</body>`, "text/html");
  const el = parsed.body.firstElementChild;
  if (!el) {
    throw new Error("fixture did not parse");
  }
  const adopted = document.adoptNode(el);
  document.body.replaceChildren(adopted);
  return adopted;
}

function classed(classes: string[], text: string): Element {
  const el = document.createElement("div");
  el.className = classes.join(" ");
  el.textContent = text;
  document.body.replaceChildren(el);
  return el;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe("fields (R4.1)", () => {
  it("captures tag, id, classes and whitespace-collapsed visible text", () => {
    const el = mount('<button id="save" class="btn  btn-primary">  Save \n\t  draft  </button>');
    const s = summarize(el, window);
    expect(s.tag).toBe("button");
    expect(s.id).toBe("save");
    expect(s.classes).toEqual(["btn", "btn-primary"]);
    expect(s.text).toBe("Save draft");
  });

  it("gives null id and empty collections for a bare element", () => {
    const s = summarize(mount("<div></div>"), window);
    expect(s.id).toBeNull();
    expect(s.classes).toEqual([]);
    expect(s.text).toBe("");
    expect(s.attrs).toEqual({});
  });

  it("takes the viewport rectangle from getBoundingClientRect", () => {
    const el = mount("<div>r</div>");
    el.getBoundingClientRect = () =>
      ({
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        top: 20,
        left: 10,
        right: 40,
        bottom: 60,
      }) as DOMRect;
    expect(summarize(el, window).rect).toEqual({ x: 10, y: 20, w: 30, h: 40 });
  });

  it("takes computed styles only from the fixed list", () => {
    const el = mount('<div style="padding: 7px; color: red">s</div>');
    const keys = Object.keys(summarize(el, window).styles);
    expect(keys.length).toBeLessThanOrEqual(24);
    for (const k of keys) {
      expect(STYLE_KEYS).toContain(k);
    }
  });

  it("cuts visible text to 500 characters", () => {
    const s = summarize(classed([], "x".repeat(900)), window);
    expect(s.text.length).toBeLessThanOrEqual(500);
  });
});

describe("attributes (R4.3)", () => {
  it("hostile: never includes an input's value or a textarea's content", () => {
    const input = mount('<input name="email" type="email" value="initial-secret@x.test">');
    (input as HTMLInputElement).value = "typed-secret@x.test";
    const s = summarize(input, window);
    const all = JSON.stringify(s);
    expect(all).not.toContain("initial-secret");
    expect(all).not.toContain("typed-secret");
    expect(s.attrs).not.toHaveProperty("value");

    const area = mount('<textarea name="note">textarea-secret</textarea>');
    expect(JSON.stringify(summarize(area, window))).not.toContain("textarea-secret");
  });

  it("hostile converse: keeps a form field's allowlisted attributes", () => {
    const s = summarize(mount('<input name="email" type="email">'), window);
    expect(s.attrs).toMatchObject({ name: "email", type: "email" });
  });

  it("keeps exactly the allowlist: role, aria-*, href, type, name, alt", () => {
    const el = mount(
      '<a role="link" aria-label="Home" aria-valuenow="5" href="/home" data-track="x" onclick="void 0" style="color:red" title="t">Home</a>',
    );
    expect(summarize(el, window).attrs).toEqual({
      role: "link",
      "aria-label": "Home",
      "aria-valuenow": "5",
      href: "/home",
    });
  });

  it("keeps alt on an image", () => {
    expect(summarize(mount('<img alt="Logo" src="/x.png">'), window).attrs).toEqual({
      alt: "Logo",
    });
  });
});

describe("4 KiB cap (R4.2)", () => {
  it("never exceeds DOM_SUMMARY_MAX_BYTES, measured in UTF-8 bytes", () => {
    const classes = Array.from({ length: 32 }, (_, i) => `${i}${"é".repeat(120)}`);
    const s = summarize(classed(classes, "ü".repeat(500)), window);
    expect(bytes(s)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
  });

  it("hostile: cuts text first and keeps every class while that is enough", () => {
    // Calibrate: add ASCII classes until the text-less summary is close to, but under, 4 KiB;
    // a 500-char text then pushes it over, so only the text may be cut.
    const classList: string[] = [];
    while (classList.length < 32) {
      const next = [...classList, `k${classList.length}-${"a".repeat(110)}`];
      if (bytes(summarize(classed(next, ""), window)) > DOM_SUMMARY_MAX_BYTES - 150) {
        break;
      }
      classList.push(next[next.length - 1]!);
    }
    expect(bytes(summarize(classed(classList, ""), window))).toBeGreaterThan(
      DOM_SUMMARY_MAX_BYTES - 500,
    );

    const s = summarize(classed(classList, "t".repeat(500)), window);
    expect(bytes(s)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
    expect(s.classes).toEqual(classList);
    expect(s.text.length).toBeLessThan(500);
  });

  it("drops classes from the end only after text is gone, and keeps styles while that is enough", () => {
    const classList = Array.from({ length: 32 }, (_, i) => `k${i}-${"é".repeat(124)}`);
    const s = summarize(classed(classList, "t".repeat(500)), window);
    expect(bytes(s)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
    expect(s.classes.length).toBeLessThan(classList.length);
    expect(s.classes).toEqual(classList.slice(0, s.classes.length));
    expect(s.text).toBe("");
    const plain = summarize(classed(["x"], "t"), window);
    expect(Object.keys(s.styles).length).toBe(Object.keys(plain.styles).length);
  });
});
