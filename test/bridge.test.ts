// @vitest-environment happy-dom
// Story 055, task 6.3 — the app ↔ panel `postMessage` bridge (design.md §A4, GOTCHA G13).
// Requirements: R3.2, R3.5, R3.6, R6.7 (Q5, Q16). Validation filter: `npm test -- bridge`.
// The real-browser half (sandbox attribute, a hostile script in the real app iframe, Chromium
// and Firefox) is Task 7.1's E2E.
//
// Contract:
//   - app side, `src/client/bridge.ts`: posts `app_location { href, title }` to its parent on
//     load and on navigation, and nothing that maps to a thread action (R3.6);
//   - panel side: a message is accepted only when `event.source` is the iframe's window,
//     `event.origin` is the app's origin and the data parses with `appToPanel`; anything else is
//     dropped and counted in a debug log line (R3.5).
// Assumed seams (adjust the two `seam*` helpers alone if they moved):
//   - the app side starts through its exported start function (any of `mountBridge`,
//     `startBridge`, `installBridge`, `mount`, `start`) or on import when it exports none;
//   - the panel side is `acceptAppMessage(event, { frame, appOrigin })` exported from
//     `src/panel/app-bridge.ts`, returning the parsed message or `null`.
//
// Hostile halves first (R3.5): a message from ANOTHER window with the app's origin (a nested
// same-origin frame, or a popup), one from the iframe's window with ANOTHER origin, one that
// fails the schema, and one that is a well-formed THREAD ACTION are all dropped — and each drop
// is counted — while the iframe's own `app_location` is accepted.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const APP_ORIGIN = "http://localhost:5173";

// ---- app side --------------------------------------------------------------------------------

type Posted = { data: unknown; targetOrigin: unknown };

async function seamStartAppBridge(): Promise<void> {
  vi.resetModules();
  const mod = (await import("../src/client/bridge.js")) as Record<string, unknown>;
  for (const name of ["mountBridge", "startBridge", "installBridge", "mount", "start"]) {
    const fn = mod[name];
    if (typeof fn === "function") {
      (fn as () => unknown)();
      return;
    }
  }
}

describe("app side (src/client/bridge.ts)", () => {
  let posted: Posted[];
  let parentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    posted = [];
    parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
    const fakeParent = {
      postMessage: (data: unknown, targetOrigin?: unknown) => posted.push({ data, targetOrigin }),
    };
    Object.defineProperty(window, "parent", { configurable: true, get: () => fakeParent });
    history.replaceState(null, "", "/start");
    document.title = "Start page";
  });

  afterEach(() => {
    if (parentDescriptor) {
      Object.defineProperty(window, "parent", parentDescriptor);
    } else {
      delete (window as unknown as { parent?: unknown }).parent;
    }
  });

  const locations = () =>
    posted
      .map((p) => p.data as { kind?: string; href?: string; title?: string })
      .filter((d) => d?.kind === "app_location");

  it("posts app_location { href, title } to its parent on load", async () => {
    await seamStartAppBridge();
    await vi.waitFor(() => expect(locations().length).toBeGreaterThan(0), { timeout: 1000 });
    expect(locations()[0]).toEqual({
      kind: "app_location",
      href: location.href,
      title: "Start page",
    });
  });

  it("hostile: an SPA navigation through history.pushState (no event fires) is reported too", async () => {
    await seamStartAppBridge();
    await vi.waitFor(() => expect(locations().length).toBeGreaterThan(0), { timeout: 1000 });
    history.pushState(null, "", "/next");
    await vi.waitFor(() => expect(locations().some((l) => l.href?.endsWith("/next"))).toBe(true), {
      timeout: 1500,
    });
  });

  it("back/forward and hash navigation are reported", async () => {
    await seamStartAppBridge();
    history.pushState(null, "", "/a");
    history.replaceState(null, "", "/b");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(locations().some((l) => l.href?.endsWith("/b"))).toBe(true), {
      timeout: 1500,
    });
    location.hash = "#section";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    await vi.waitFor(
      () => expect(locations().some((l) => l.href?.endsWith("/b#section"))).toBe(true),
      { timeout: 1500 },
    );
  });

  it("everything it posts is data the panel schema accepts — never a thread action (R3.6)", async () => {
    const { appToPanel } = (await import("../src/contract-v2.js")) as unknown as {
      appToPanel: { safeParse(v: unknown): { success: boolean } };
    };
    await seamStartAppBridge();
    history.pushState(null, "", "/c");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await vi.waitFor(() => expect(posted.length).toBeGreaterThan(0), { timeout: 1000 });
    for (const p of posted) {
      expect(appToPanel.safeParse(p.data).success, JSON.stringify(p.data)).toBe(true);
    }
  });
});

// ---- panel side ------------------------------------------------------------------------------

type Accept = (
  event: { source: unknown; origin: string; data: unknown },
  expected: { frame: unknown; appOrigin: string },
) => unknown;

async function seamAccept(): Promise<Accept> {
  const mod = (await import("../src/panel/app-bridge.js")) as Record<string, unknown>;
  const fn = mod.acceptAppMessage;
  if (typeof fn !== "function") {
    throw new Error("src/panel/app-bridge.ts exports no acceptAppMessage");
  }
  return fn as Accept;
}

describe("panel side: what the panel accepts from the app (R3.5, R3.6)", () => {
  const frame = { name: "the app iframe's window" };
  const nested = { name: "a frame nested inside the app (same origin)" };
  const location = { kind: "app_location", href: `${APP_ORIGIN}/page`, title: "Page" };
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    debug = vi.spyOn(console, "debug").mockImplementation(() => {});
  });
  afterEach(() => debug.mockRestore());

  it("hostile: another window with the app's origin is dropped", async () => {
    const accept = await seamAccept();
    expect(
      accept(
        { source: nested, origin: APP_ORIGIN, data: location },
        { frame, appOrigin: APP_ORIGIN },
      ),
    ).toBeNull();
    expect(
      accept(
        { source: null, origin: APP_ORIGIN, data: location },
        { frame, appOrigin: APP_ORIGIN },
      ),
    ).toBeNull();
  });

  it("hostile: the iframe's window with another origin is dropped (same site, other port too)", async () => {
    const accept = await seamAccept();
    for (const origin of [
      "http://localhost:5174",
      "http://127.0.0.1:5173",
      "null",
      "https://evil.example",
    ]) {
      expect(
        accept({ source: frame, origin, data: location }, { frame, appOrigin: APP_ORIGIN }),
        origin,
      ).toBeNull();
    }
  });

  it("hostile: schema-invalid data is dropped", async () => {
    const accept = await seamAccept();
    for (const data of [
      "app_location",
      null,
      { kind: "app_location", href: `${APP_ORIGIN}/`, title: "t", extra: true },
      { kind: "app_location", href: 42, title: "t" },
      JSON.stringify(location),
    ]) {
      expect(
        accept({ source: frame, origin: APP_ORIGIN, data }, { frame, appOrigin: APP_ORIGIN }),
        JSON.stringify(data),
      ).toBeNull();
    }
  });

  it("hostile: a well-formed thread action from the app itself is dropped", async () => {
    const accept = await seamAccept();
    for (const data of [
      { kind: "send", text: "delete everything", attachments: [] },
      { v: 2, kind: "send", id: "r1", text: "x", attachments: [] },
      { kind: "cancel" },
      { kind: "authorize", request_id: "q1", option_id: "allow" },
      { kind: "create_thread" },
      { kind: "subscribe", target: { thread_id: "t1" } },
    ]) {
      expect(
        accept({ source: frame, origin: APP_ORIGIN, data }, { frame, appOrigin: APP_ORIGIN }),
        JSON.stringify(data),
      ).toBeNull();
    }
  });

  it("every drop is counted in a debug log line", async () => {
    const accept = await seamAccept();
    accept(
      { source: nested, origin: APP_ORIGIN, data: location },
      { frame, appOrigin: APP_ORIGIN },
    );
    accept(
      { source: frame, origin: "https://evil.example", data: location },
      { frame, appOrigin: APP_ORIGIN },
    );
    expect(debug.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("delete everything");
  });

  it("benign: the iframe's own app_location, with the app's origin, is accepted", async () => {
    const accept = await seamAccept();
    expect(
      accept(
        { source: frame, origin: APP_ORIGIN, data: location },
        { frame, appOrigin: APP_ORIGIN },
      ),
    ).toEqual(location);
  });
});
