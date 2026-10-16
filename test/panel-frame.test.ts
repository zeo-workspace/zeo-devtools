// @vitest-environment happy-dom
// Story 055, task 6.3 — the app pane (src/panel/app-frame.ts): the iframe and GOTCHA G13.
// Supplementary to the frozen bridge.test.ts (which drives acceptAppMessage alone); the real
// sandbox, in Chromium and Firefox, is Task 7.1's E2E.
//   - G13: when /api/config names an app on the panel's own origin, the pane shows an error and
//     creates NO iframe (allow-scripts + allow-same-origin would let it lift the sandbox);
//   - R3.2: otherwise the iframe carries exactly the design's sandbox — never allow-top-navigation
//     in any form — with the app URL as its src and an accessible title;
//   - R3.5: the strip above it follows the iframe's own app_location, and ignores the same
//     message from another window.
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_SANDBOX, mountAppFrame } from "../src/panel/app-frame.js";

const APP_URL = "http://localhost:5173/";

const quiet = { debug: () => {}, info: () => {}, warn: () => {} };

function serveConfig(appUrl: string) {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ app_url: appUrl, root: "/home/dev/app" }),
  }));
}

async function mount(pageOrigin: string) {
  const pane = document.createElement("section");
  document.body.replaceChildren(pane);
  const app = mountAppFrame(pane, { log: quiet, pageOrigin });
  await vi.waitFor(() => expect(pane.querySelector(".app-placeholder")?.textContent).toBeTruthy());
  await new Promise((r) => setTimeout(r, 0));
  return { pane, app };
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("the app iframe (R3.2, G13)", () => {
  it("hostile: an app on the panel's own origin gets no iframe, and the pane says why", async () => {
    serveConfig("http://localhost:4000/");
    const { pane, app } = await mount("http://localhost:4000");
    await vi.waitFor(() => expect(pane.textContent).toMatch(/not shown/));
    expect(pane.querySelector("iframe")).toBeNull();
    expect(app.frame()).toBeNull();
  });

  it("an app on another origin is framed with exactly the design's sandbox", async () => {
    serveConfig(APP_URL);
    const { pane } = await mount("http://localhost:4000");
    await vi.waitFor(() => expect(pane.querySelector("iframe")).not.toBeNull());
    const frame = pane.querySelector("iframe")!;
    const tokens = (frame.getAttribute("sandbox") ?? "").split(/\s+/).sort();
    expect(tokens).toEqual(
      [
        "allow-downloads",
        "allow-forms",
        "allow-modals",
        "allow-popups",
        "allow-same-origin",
        "allow-scripts",
      ].sort(),
    );
    expect(APP_SANDBOX).not.toMatch(/top-navigation/);
    expect(frame.getAttribute("src")).toBe(APP_URL);
    expect(frame.getAttribute("title")).toBeTruthy();
    expect(frame.hasAttribute("style")).toBe(false);
  });

  it("the location strip follows the iframe's own app_location, not another window's", async () => {
    serveConfig(APP_URL);
    const { pane, app } = await mount("http://localhost:4000");
    await vi.waitFor(() => expect(app.frame()).not.toBeNull());
    const location = { kind: "app_location", href: `${APP_URL}settings`, title: "Settings" };
    window.dispatchEvent(
      new MessageEvent("message", {
        data: location,
        origin: "http://localhost:5173",
        source: window,
      }),
    );
    expect(pane.textContent).not.toContain("Settings");
    window.dispatchEvent(
      new MessageEvent("message", {
        data: location,
        origin: "http://localhost:5173",
        source: app.frame()!.contentWindow,
      }),
    );
    expect(pane.textContent).toContain("Settings");
    expect(pane.textContent).toContain(`${APP_URL}settings`);
  });
});
