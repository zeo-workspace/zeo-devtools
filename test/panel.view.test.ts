// @vitest-environment happy-dom
// Story 055, task 6.1 — the thread view moved from zeo-browser into the panel page, on the SSE /
// rpc transport instead of the extension's native port (design.md §A3, D6). Requirements: R5.7,
// R6.2, R6.3, R6.4, R6.5, R6.6 (Q3, Q5, Q17). Validation filter: `npm test -- panel`.
//
// Seam: test/helpers/panel-harness.ts — `src/panel/main.ts` mounts on import; the transport is
// design.md §A1's (`POST /api/panels`, `EventSource /api/events`, `POST /api/rpc { panel, msg }`).
// A thread is bound through `sessionStorage.boundThread` (design.md §A3) before the page loads.
//
// Hostile halves first:
//   - transcript identity: `entry_updated` at index 1 replaces index 1 only (never appends, never
//     touches 0); `entries_removed` [1, 2) removes exactly that entry;
//   - permissions: `permission_resolved` for ANOTHER request leaves the card; its own removes it;
//   - model output (R6.6): raw HTML is inert text, an image never becomes `<img>` (it becomes a
//     link), and every link carries `noopener noreferrer` — while ordinary Markdown still renders;
//   - no follow target (R5.7) and no `chrome.*` API anywhere in `src/panel/`.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  button,
  buttons,
  composer,
  mountPanel,
  snapshot,
  submit,
  text,
  type,
  unmountPanel,
  type Harness,
} from "./helpers/panel-harness.js";

const BOUND = "t-bound";
let h: Harness;

beforeEach(async () => {
  sessionStorage.setItem("boundThread", BOUND);
  h = await mountPanel();
});

afterEach(() => unmountPanel());

const entry = (role: string, markdown: string) => ({ role, markdown, truncated: false });

describe("transport", () => {
  it("opens one panel, streams its events and subscribes the bound thread", () => {
    expect(h.es().url).toMatch(/\/api\/events\?panel=p-0123456789abcdef/);
    const sub = h.lastRpc("subscribe");
    expect(sub?.panel).toBe("p-0123456789abcdef0123456789abcdef");
    const m = sub?.msg as { thread_id?: string; target?: { thread_id?: string } };
    expect(m?.thread_id ?? m?.target?.thread_id).toBe(BOUND);
  });
});

describe("entries (R6.2)", () => {
  it("a snapshot renders the thread's entries", async () => {
    await h.emit(
      snapshot(BOUND, [entry("user", "make it blue"), entry("assistant", "Done, it is blue")]),
    );
    expect(text()).toContain("make it blue");
    expect(text()).toContain("Done, it is blue");
  });

  it("hostile: entry_updated at 1 replaces 1 only; entries_removed [1,2) removes exactly it", async () => {
    await h.emit(
      snapshot(BOUND, [
        entry("user", "ZERO"),
        entry("assistant", "ONE-old"),
        entry("assistant", "TWO"),
      ]),
    );
    await h.emit({ v: 2, kind: "entry_updated", index: 1, entry: entry("assistant", "ONE-new") });
    expect(text()).toContain("ZERO");
    expect(text()).toContain("ONE-new");
    expect(text()).not.toContain("ONE-old");
    expect(text()).toContain("TWO");
    expect(text().indexOf("ZERO")).toBeLessThan(text().indexOf("ONE-new"));
    expect(text().indexOf("ONE-new")).toBeLessThan(text().indexOf("TWO"));
    await h.emit({ v: 2, kind: "entries_removed", start: 1, end: 2 });
    expect(text()).not.toContain("ONE-new");
    expect(text()).toContain("ZERO");
    expect(text()).toContain("TWO");
  });

  it("entry_added appends after the last entry", async () => {
    await h.emit(snapshot(BOUND, [entry("user", "FIRST")]));
    await h.emit({ v: 2, kind: "entry_added", index: 1, entry: entry("assistant", "SECOND") });
    expect(text().indexOf("FIRST")).toBeLessThan(text().indexOf("SECOND"));
  });
});

describe("send and stop (R6.3, R6.4)", () => {
  it("Send delivers the composer text to the bound thread through rpc `send`", async () => {
    await h.emit(snapshot(BOUND, []));
    const area = composer();
    expect(area, "a composer for the bound thread").toBeDefined();
    await type(area!, "make the header sticky");
    await submit(area!);
    const sent = h.lastRpc("send");
    expect(sent?.msg).toMatchObject({ kind: "send", text: "make the header sticky" });
  });

  it("Stop cancels the bound thread's turn while it works", async () => {
    await h.emit(snapshot(BOUND, [entry("user", "go")]));
    await h.emit({ v: 2, kind: "status", status: { state: "working", message: null } });
    const stop = button(/^stop$/i);
    expect(stop, "a Stop control while working").toBeDefined();
    stop!.click();
    await h.settle();
    expect(h.lastRpc("cancel")?.msg.kind).toBe("cancel");
  });
});

describe("permissions (R6.5)", () => {
  const permission = (request_id: string, title: string) => ({
    v: 2,
    kind: "permission_requested",
    permission: {
      request_id,
      entry_index: 0,
      title,
      options: [
        { option_id: `${request_id}-allow`, label: "Allow once", kind: "allow_once" },
        { option_id: `${request_id}-reject`, label: "Reject", kind: "reject_once" },
      ],
    },
  });

  it("hostile: resolving ANOTHER request leaves the card; its own resolution removes it", async () => {
    await h.emit(snapshot(BOUND, [entry("tool", "ls")]));
    await h.emit(permission("q1", "Run ls in the project?"));
    expect(text()).toContain("Run ls in the project?");
    await h.emit({ v: 2, kind: "permission_resolved", request_id: "q-other" });
    expect(text()).toContain("Run ls in the project?");
    await h.emit({ v: 2, kind: "permission_resolved", request_id: "q1" });
    expect(text()).not.toContain("Run ls in the project?");
  });

  it("the operator's answer is delivered with the request and option ids", async () => {
    await h.emit(snapshot(BOUND, [entry("tool", "ls")]));
    await h.emit(permission("q2", "Run ls?"));
    button(/allow once/i)!.click();
    await h.settle();
    expect(h.lastRpc("authorize")?.msg).toMatchObject({
      kind: "authorize",
      request_id: "q2",
      option_id: "q2-allow",
    });
  });
});

describe("model output is rendered safely (R6.6)", () => {
  const hostile = [
    "Before <script>window.__pwned = 1</script> after",
    '<img src="http://evil.example/x.png" onerror="window.__pwned = 2">',
    "![tracking pixel](http://evil.example/pixel.png)",
    "[docs](https://example.com/docs) and **bold**",
  ].join("\n\n");

  it("hostile: raw HTML is inert text and no element carries an event handler", async () => {
    await h.emit(snapshot(BOUND, [entry("assistant", hostile)]));
    expect(h.root.querySelector("script")).toBeNull();
    expect(text()).toContain("<script>");
    for (const el of h.root.querySelectorAll("*")) {
      for (const attr of el.getAttributeNames()) {
        expect(attr.startsWith("on"), `${el.tagName} ${attr}`).toBe(false);
      }
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("hostile: no image is loaded — an image becomes a link", async () => {
    await h.emit(snapshot(BOUND, [entry("assistant", hostile)]));
    expect(h.root.querySelector("img")).toBeNull();
    const hrefs = [...h.root.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toContain("http://evil.example/pixel.png");
  });

  it("links open with noopener noreferrer, and ordinary Markdown still renders", async () => {
    await h.emit(snapshot(BOUND, [entry("assistant", hostile)]));
    const links = [...h.root.querySelectorAll("a[href]")];
    expect(links.length).toBeGreaterThan(0);
    for (const a of links) {
      const rel = (a.getAttribute("rel") ?? "").split(/\s+/);
      expect(rel, a.getAttribute("href") ?? "").toEqual(
        expect.arrayContaining(["noopener", "noreferrer"]),
      );
    }
    expect(h.root.querySelector("strong")?.textContent).toBe("bold");
  });
});

describe("what the panel never has (R5.7, D6)", () => {
  it("hostile: no control offers to follow the active thread", async () => {
    await h.emit(snapshot(BOUND, []));
    for (const b of buttons()) {
      expect(b.textContent ?? "").not.toMatch(/follow/i);
    }
    for (const o of document.querySelectorAll("option")) {
      expect(o.textContent ?? "").not.toMatch(/follow/i);
    }
    expect(text()).not.toMatch(/follow (the )?active/i);
  });

  it("no chrome.* or browser.* extension API in src/panel/", () => {
    const dir = join(process.cwd(), "src/panel");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (/\.(ts|js|html)$/.test(name)) {
          files.push(p);
        }
      }
    };
    walk(dir);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\bchrome\.(runtime|storage|tabs|sidePanel|scripting)\b/);
      expect(src, f).not.toMatch(/\bbrowser\.(runtime|storage|tabs)\b/);
    }
  });
});
