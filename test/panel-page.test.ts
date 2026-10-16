// @vitest-environment happy-dom
// Story 055, task 7.1 — the app's URL written into the panel page (src/panel-server.ts
// `withAppUrl`) and read back by the app pane (src/panel/app-frame.ts) while the page's module
// runs, so the iframe exists before the document's `load` (R6.7: the E2E counts the iframe's first
// load as a navigation when it comes after the page is up). Supplementary to e2e/panel.spec.ts.
//   - the slot is filled, escaped for an attribute value; a page without the slot is unchanged;
//   - with the meta, the iframe is created at once and `/api/config` is never fetched;
//   - hostile: G13 still holds on that path, and a meta that is not a local http URL is ignored
//     for the API's answer.
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withAppUrl } from "../src/panel-server.js";
import { mountAppFrame } from "../src/panel/app-frame.js";

const APP_URL = "http://localhost:5173/";
const SLOT = '<meta name="zeo-app-url" content="" />';
const quiet = { debug: () => {}, info: () => {}, warn: () => {} };

const page = (head: string) =>
  Buffer.from(`<!doctype html><html><head>${head}</head><body></body></html>`, "utf8");

function metaContent(html: Buffer): string | null {
  const doc = new DOMParser().parseFromString(html.toString("utf8"), "text/html");
  return doc.querySelector('meta[name="zeo-app-url"]')?.getAttribute("content") ?? null;
}

function withMeta(content: string) {
  const meta = document.createElement("meta");
  meta.name = "zeo-app-url";
  meta.content = content;
  document.head.replaceChildren(meta);
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("withAppUrl (panel server)", () => {
  it("writes the app URL into the page's slot", () => {
    expect(metaContent(withAppUrl(page(SLOT), APP_URL))).toBe(APP_URL);
  });

  it("hostile: quotes and angle brackets cannot leave the attribute", () => {
    const hostile = `http://localhost:5173/a"><script>x()</script>&'`;
    const out = withAppUrl(page(SLOT), hostile);
    expect(metaContent(out)).toBe(hostile);
    expect(out.toString("utf8")).not.toContain("<script>");
  });

  it("serves a page without the slot unchanged", () => {
    const plain = page("<title>panel</title>");
    expect(withAppUrl(plain, APP_URL)).toBe(plain);
  });
});

describe("the app pane reads the page's app URL", () => {
  it("creates the iframe at once, without asking /api/config", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    withMeta(APP_URL);
    const pane = document.createElement("section");
    document.body.append(pane);
    const app = mountAppFrame(pane, { log: quiet, pageOrigin: "http://localhost:4000" });
    expect(app.frame()?.getAttribute("src")).toBe(APP_URL);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("hostile: a page URL on the panel's own origin still gets no iframe (G13)", () => {
    vi.stubGlobal("fetch", vi.fn());
    withMeta("http://localhost:4000/");
    const pane = document.createElement("section");
    document.body.append(pane);
    const app = mountAppFrame(pane, { log: quiet, pageOrigin: "http://localhost:4000" });
    expect(app.frame()).toBeNull();
    expect(pane.querySelector("iframe")).toBeNull();
  });

  it("hostile: a meta that is not a local http URL is ignored for the API's answer", async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ app_url: APP_URL, root: "/home/dev/app" }),
    }));
    vi.stubGlobal("fetch", fetch);
    withMeta("https://evil.example/");
    const pane = document.createElement("section");
    document.body.append(pane);
    const app = mountAppFrame(pane, { log: quiet, pageOrigin: "http://localhost:4000" });
    expect(app.frame()).toBeNull();
    await vi.waitFor(() => expect(app.frame()?.getAttribute("src")).toBe(APP_URL));
    expect(fetch).toHaveBeenCalledWith("/api/config");
  });
});
