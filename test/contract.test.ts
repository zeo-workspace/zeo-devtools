// Story 033, task 2.2 — the zod wire contract (design.md §Data Models, §Validation rules).
// Requirements: R4.2, R4.3, R6.1, R6.5, R8.2, R8.3.
// Contract: `src/contract.ts` exports `selectionFromPage` (relative paths, as the page sends
// them), `selectionToZeo` (absolute paths, as the relay writes them), `devtoolsResult`,
// `DOM_SUMMARY_MAX_BYTES`, `MAX_ITEMS`, `ATTR_ALLOWLIST`, `STYLE_KEYS`.
//
// Hostile halves first, for every SAME/DIFFERENT rule:
//   - the 4 KiB cap is UTF-8 bytes: a summary under 4096 UTF-16 units but over 4096 bytes
//     must be refused (wrongly accepted by `.length`), and one of exactly 4096 bytes accepted
//     (wrongly refused by an off-by-one);
//   - the attribute allowlist is exact: `roles`, `xaria-label`, `data-aria-label`, `value`
//     must be refused (wrongly accepted by a prefix/contains check), while `aria-valuenow` —
//     a "value"-looking name — must be accepted (wrongly refused by a substring deny-list).
import { describe, expect, it } from "vitest";
import {
  ATTR_ALLOWLIST,
  DOM_SUMMARY_MAX_BYTES,
  MAX_ITEMS,
  STYLE_KEYS,
  devtoolsResult,
  parseSelection,
  selectionFromPage,
  selectionToZeo,
} from "../src/contract.js";

type Json = Record<string, unknown>;

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;

function dom(overrides: Json = {}): Json {
  return {
    tag: "button",
    id: "save",
    classes: ["btn", "btn-primary"],
    text: "Save draft",
    attrs: { role: "button", "aria-label": "Save" },
    styles: { [STYLE_KEYS[0]]: "8px" },
    rect: { x: 10, y: 20, w: 120, h: 32 },
    ...overrides,
  };
}

function item(file: string, overrides: Json = {}): Json {
  return {
    src: { file, line: 12, column: 5, end_line: 14 },
    component: "Toolbar",
    dom: dom(),
    ...overrides,
  };
}

function toZeo(overrides: Json = {}, items?: Json[]): Json {
  return {
    v: 1,
    project_root: "/home/dev/app",
    page_url: "http://localhost:5173/",
    items: items ?? [item("/home/dev/app/src/Toolbar.tsx")],
    screenshot: null,
    ...overrides,
  };
}

function fromPage(overrides: Json = {}, items?: Json[]): Json {
  return {
    v: 1,
    page_url: "http://localhost:5173/",
    items: items ?? [item("src/Toolbar.tsx")],
    screenshot: null,
    ...overrides,
  };
}

const accepts = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success, JSON.stringify(v).slice(0, 200)).toBe(true);
const refuses = (schema: { safeParse(v: unknown): { success: boolean } }, v: unknown) =>
  expect(schema.safeParse(v).success, JSON.stringify(v).slice(0, 200)).toBe(false);

/** A dom summary whose `JSON.stringify` is exactly `target` UTF-8 bytes (ASCII padding). */
function domOfBytes(target: number): Json {
  const d = dom({ classes: [], text: "" });
  const classes = d.classes as string[];
  while (target - bytes(d) > 131) {
    const overhead = classes.length === 0 ? 2 : 3;
    classes.push("c".repeat(Math.min(128, target - bytes(d) - overhead)));
  }
  d.text = "t".repeat(target - bytes(d));
  return d;
}

describe("contract constants", () => {
  it("names the limits of the design's validation table", () => {
    expect(DOM_SUMMARY_MAX_BYTES).toBe(4096);
    expect(MAX_ITEMS).toBe(20);
    expect(STYLE_KEYS.length).toBeGreaterThan(0);
    expect(STYLE_KEYS.length).toBeLessThanOrEqual(24);
    expect(new Set(STYLE_KEYS).size).toBe(STYLE_KEYS.length);
    expect(ATTR_ALLOWLIST).toBeDefined();
  });
});

describe("version (R8.2)", () => {
  it("refuses v: 2 and a string version, accepts v: 1", () => {
    refuses(selectionToZeo, toZeo({ v: 2 }));
    refuses(selectionToZeo, toZeo({ v: "1" }));
    refuses(selectionFromPage, fromPage({ v: 2 }));
    accepts(selectionToZeo, toZeo());
    accepts(selectionFromPage, fromPage());
  });
});

describe("item count (R8.3)", () => {
  it("refuses 0 and 21 items, accepts 1 and 20", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => item(`/home/dev/app/src/F${i}.tsx`));
    refuses(selectionToZeo, toZeo({}, []));
    refuses(selectionToZeo, toZeo({}, many(21)));
    accepts(selectionToZeo, toZeo({}, many(1)));
    accepts(selectionToZeo, toZeo({}, many(20)));
  });
});

describe("unknown keys are refused at every level (R8.3)", () => {
  it("top level, item, src and dom", () => {
    refuses(selectionToZeo, toZeo({ extra: true }));
    refuses(selectionToZeo, toZeo({}, [item("/home/dev/app/a.tsx", { extra: 1 })]));
    refuses(
      selectionToZeo,
      toZeo({}, [
        item("/home/dev/app/a.tsx", {
          src: { file: "/home/dev/app/a.tsx", line: 1, column: 1, end_line: 1, x: 1 },
        }),
      ]),
    );
    refuses(
      selectionToZeo,
      toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ value: "secret" }) })]),
    );
  });
});

describe("path form (R6.1)", () => {
  // Hostile first: each form must refuse the other form's path.
  it("the socket form refuses a relative src.file; the page form refuses an absolute one", () => {
    refuses(selectionToZeo, toZeo({}, [item("src/Toolbar.tsx")]));
    refuses(selectionFromPage, fromPage({}, [item("/etc/passwd")]));
  });
  it("the socket form refuses a relative project_root", () => {
    refuses(selectionToZeo, toZeo({ project_root: "home/dev/app" }));
  });
  it("each form accepts its own path shape", () => {
    accepts(selectionToZeo, toZeo());
    accepts(selectionFromPage, fromPage());
  });
});

describe("source location", () => {
  it("refuses a negative or fractional line, accepts a positive integer one", () => {
    const at = (src: Json) => toZeo({}, [item("/home/dev/app/a.tsx", { src })]);
    refuses(selectionToZeo, at({ file: "/home/dev/app/a.tsx", line: -1, column: 1, end_line: 1 }));
    refuses(selectionToZeo, at({ file: "/home/dev/app/a.tsx", line: 1.5, column: 1, end_line: 2 }));
    refuses(selectionToZeo, at({ file: "/home/dev/app/a.tsx", line: 3, column: -2, end_line: 3 }));
    accepts(selectionToZeo, at({ file: "/home/dev/app/a.tsx", line: 3, column: 1, end_line: 9 }));
  });
});

describe("per-field limits (R8.3)", () => {
  const withDom = (d: Json) => toZeo({}, [item("/home/dev/app/a.tsx", { dom: d })]);
  const withItem = (o: Json) => toZeo({}, [item("/home/dev/app/a.tsx", o)]);

  it("component: null and 128 chars accepted, 129 refused", () => {
    accepts(selectionToZeo, withItem({ component: null }));
    accepts(selectionToZeo, withItem({ component: "C".repeat(128) }));
    refuses(selectionToZeo, withItem({ component: "C".repeat(129) }));
  });
  it("tag ≤ 64", () => {
    accepts(selectionToZeo, withDom(dom({ tag: "t".repeat(64) })));
    refuses(selectionToZeo, withDom(dom({ tag: "t".repeat(65) })));
  });
  it("id null or ≤ 128", () => {
    accepts(selectionToZeo, withDom(dom({ id: null })));
    accepts(selectionToZeo, withDom(dom({ id: "i".repeat(128) })));
    refuses(selectionToZeo, withDom(dom({ id: "i".repeat(129) })));
  });
  it("classes ≤ 32 entries, each ≤ 128", () => {
    accepts(selectionToZeo, withDom(dom({ classes: Array(32).fill("c") })));
    refuses(selectionToZeo, withDom(dom({ classes: Array(33).fill("c") })));
    accepts(selectionToZeo, withDom(dom({ classes: ["c".repeat(128)] })));
    refuses(selectionToZeo, withDom(dom({ classes: ["c".repeat(129)] })));
  });
  it("text ≤ 500 chars", () => {
    accepts(selectionToZeo, withDom(dom({ text: "x".repeat(500) })));
    refuses(selectionToZeo, withDom(dom({ text: "x".repeat(501) })));
  });
  it("styles ≤ 24 keys from the fixed list; an unknown key refused", () => {
    const all = Object.fromEntries(STYLE_KEYS.map((k) => [k, "1px"]));
    accepts(selectionToZeo, withDom(dom({ styles: all })));
    refuses(selectionToZeo, withDom(dom({ styles: { "not-a-style-key": "1" } })));
  });
  it("every optional dom field empty is accepted", () => {
    accepts(
      selectionToZeo,
      withDom(dom({ id: null, classes: [], text: "", attrs: {}, styles: {} })),
    );
  });
});

describe("attribute allowlist (R4.3)", () => {
  const withAttrs = (attrs: Json) =>
    toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ attrs }) })]);

  it("refuses names that only look like allowlisted ones (hostile: wrongly accepted)", () => {
    for (const key of [
      "roles",
      "xaria-label",
      "data-aria-label",
      "value",
      "onclick",
      "style",
      "hrefs",
    ]) {
      refuses(selectionToZeo, withAttrs({ [key]: "v" }));
    }
  });
  it("accepts every allowlisted name, including a value-looking aria-* (hostile: wrongly refused)", () => {
    accepts(
      selectionToZeo,
      withAttrs({
        role: "button",
        "aria-label": "Save",
        "aria-valuenow": "5",
        "aria-describedby": "hint",
        href: "/x",
        type: "submit",
        name: "email",
        alt: "logo",
      }),
    );
  });
  it("attribute values ≤ 200", () => {
    accepts(selectionToZeo, withAttrs({ "aria-label": "a".repeat(200) }));
    refuses(selectionToZeo, withAttrs({ "aria-label": "a".repeat(201) }));
  });
});

describe("serialized dom summary ≤ 4 KiB in UTF-8 bytes (R4.2)", () => {
  const withDom = (d: Json) => toZeo({}, [item("/home/dev/app/a.tsx", { dom: d })]);

  it("hostile: under 4096 UTF-16 units but over 4096 bytes is refused", () => {
    const d = dom({ classes: Array.from({ length: 30 }, () => "é".repeat(100)), text: "" });
    expect(JSON.stringify(d).length).toBeLessThan(4096);
    expect(bytes(d)).toBeGreaterThan(4096);
    refuses(selectionToZeo, withDom(d));
  });
  it("exactly 4096 bytes is accepted, 4097 refused", () => {
    const exact = domOfBytes(4096);
    const over = domOfBytes(4097);
    expect(bytes(exact)).toBe(4096);
    expect(bytes(over)).toBe(4097);
    accepts(selectionToZeo, withDom(exact));
    refuses(selectionToZeo, withDom(over));
  });
});

describe("screenshot", () => {
  it("refuses image/jpeg, accepts image/png and null", () => {
    const shot = (mime: string) => ({ mime, data_b64: "iVBORw0KGgo=", w: 10, h: 10 });
    refuses(selectionToZeo, toZeo({ screenshot: shot("image/jpeg") }));
    accepts(selectionToZeo, toZeo({ screenshot: shot("image/png") }));
    accepts(selectionToZeo, toZeo({ screenshot: null }));
  });
});

describe("devtoolsResult", () => {
  it("accepts both success outcomes and every error code", () => {
    accepts(devtoolsResult, { v: 1, ok: true, outcome: "inserted", items: 2, image: "included" });
    accepts(devtoolsResult, {
      v: 1,
      ok: true,
      outcome: "opened_new_thread",
      items: 1,
      image: "none",
    });
    accepts(devtoolsResult, {
      v: 1,
      ok: true,
      outcome: "inserted",
      items: 1,
      image: "skipped_unsupported",
    });
    accepts(devtoolsResult, {
      v: 1,
      ok: true,
      outcome: "opened_new_thread",
      items: 1,
      image: "pending",
    });
    for (const error of [
      "no_window",
      "no_agent_panel",
      "ai_disabled",
      "bad_request",
      "too_large",
      "outside_project",
      "unsupported_version",
      "unreachable",
      "timeout",
    ]) {
      accepts(devtoolsResult, { v: 1, ok: false, error, message: "m" });
    }
  });
  it("refuses an unknown error code or outcome", () => {
    refuses(devtoolsResult, { v: 1, ok: false, error: "exploded", message: "m" });
    // There is no `disabled` code: a disabled bridge has no socket, so the page sees `unreachable`.
    refuses(devtoolsResult, { v: 1, ok: false, error: "disabled", message: "m" });
    refuses(devtoolsResult, { v: 1, ok: true, outcome: "sent", items: 1, image: "none" });
    // R9.7: a success must say what happened to the screenshot.
    refuses(devtoolsResult, { v: 1, ok: true, outcome: "inserted", items: 1 });
    refuses(devtoolsResult, { v: 1, ok: true, outcome: "inserted", items: 1, image: "dropped" });
    refuses(devtoolsResult, { v: 1, ok: false, error: "no_window" });
  });
});

describe("selectionToZeo path confinement (R8.4, agreed with the Rust validator)", () => {
  it("refuses a file outside project_root, including a string-prefix sibling", () => {
    refuses(selectionToZeo, toZeo({}, [item("/home/dev/app2/src/Toolbar.tsx")]));
    refuses(selectionToZeo, toZeo({}, [item("/etc/passwd")]));
    refuses(selectionToZeo, toZeo({}, [item("/home/dev/app/../app2/x.tsx")]));
  });
  it("hostile converse: a file anywhere under project_root is accepted", () => {
    accepts(selectionToZeo, toZeo({}, [item("/home/dev/app/src/deep/nested/Card.tsx")]));
    accepts(selectionToZeo, toZeo({}, [item("/home/dev/app/src/../src/Toolbar.tsx")]));
  });
});

// Story 033, task 9.1 — the relay answers the code Zeo answers (fixes from the 6.2 tech review).
describe("parseSelection answers in Zeo's order: version, field limits, confinement", () => {
  const code = (input: unknown) => {
    const r = parseSelection(selectionToZeo, input);
    return r.ok ? "accepted" : r.error;
  };
  it("a relative src.file on the socket form is bad_request, never outside_project", () => {
    expect(code(toZeo({}, [item("src/Toolbar.tsx")]))).toBe("bad_request");
  });
  it("a field limit on one item beats confinement on another", () => {
    const broken = item("/home/dev/app/src/Toolbar.tsx", { component: "c".repeat(129) });
    expect(code(toZeo({}, [broken, item("/etc/passwd")]))).toBe("bad_request");
    expect(code(toZeo({ page_url: "u".repeat(2049) }, [item("/etc/passwd")]))).toBe("bad_request");
  });
  it("outside_project when it is the only kind of issue, and the version beats it", () => {
    expect(code(toZeo({}, [item("/etc/passwd")]))).toBe("outside_project");
    expect(code(toZeo({ v: 2 }, [item("/etc/passwd")]))).toBe("unsupported_version");
  });
  it("the bad_request message names the field limit, not the confinement issue", () => {
    const r = parseSelection(
      selectionToZeo,
      toZeo({}, [item("/etc/passwd"), item("/home/dev/app/a.tsx", { component: "c".repeat(129) })]),
    );
    expect(r).toMatchObject({ ok: false, error: "bad_request" });
    expect(r.ok ? "" : r.message).toContain("items.1.component");
  });
});

describe("a lone UTF-16 surrogate is refused as bad_request, as serde_json refuses it", () => {
  const lone = "a\uD800b";
  const cases: Array<[string, Json]> = [
    ["dom.text", toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ text: lone }) })])],
    ["dom.id", toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ id: lone }) })])],
    ["dom.classes", toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ classes: [lone] }) })])],
    [
      "dom.attrs value",
      toZeo({}, [item("/home/dev/app/a.tsx", { dom: dom({ attrs: { "aria-label": "\uDC00" } }) })]),
    ],
    ["component", toZeo({}, [item("/home/dev/app/a.tsx", { component: lone })])],
    ["page_url", toZeo({ page_url: lone })],
    ["src.file", toZeo({}, [item(`/home/dev/app/${lone}.tsx`)])],
  ];
  for (const [field, input] of cases) {
    it(field, () => {
      expect(parseSelection(selectionToZeo, input)).toMatchObject({
        ok: false,
        error: "bad_request",
      });
    });
  }
  it("the page form refuses it too, and a well-formed pair is accepted", () => {
    refuses(selectionFromPage, fromPage({}, [item("src/a.tsx", { dom: dom({ text: lone }) })]));
    accepts(selectionFromPage, fromPage({}, [item("src/a.tsx", { dom: dom({ text: "a😀b" }) })]));
  });
});
