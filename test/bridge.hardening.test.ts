// @vitest-environment happy-dom
// Story 055, task 6.3 fix cycle 1 — hardening of the app ↔ panel bridge found by the tech review
// (real Chromium and Firefox probes with a hostile app). Supplementary to the frozen
// bridge.test.ts.
//   - L3 (fix cycle 2, operator's option b): an app posting junk in a loop costs at most a burst
//     of debug lines; the counter still counts every drop; after the refill interval the next
//     drop logs again, carrying how many drops went unlogged (`suppressed`).
//   - L1: a bridge started without the panel's origin posts with targetOrigin "/" (the app's own
//     origin, which the panel never has — G13), never "*";
//   - L2: a panel page opened by another page (`window.open` from the framed app, which
//     `allow-popups` permits) refuses to mount: no `POST /api/panels`, no event stream, no app
//     frame, and a sentence saying why; without an opener it mounts as usual;
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeEventSource, mountPanel, text, unmountPanel } from "./helpers/panel-harness.js";

describe("L1: the app bridge's target without a panel origin", () => {
  let posted: Array<{ data: unknown; targetOrigin: unknown }>;
  let parentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    posted = [];
    parentDescriptor = Object.getOwnPropertyDescriptor(window, "parent");
    const fakeParent = {
      postMessage: (data: unknown, targetOrigin?: unknown) => posted.push({ data, targetOrigin }),
    };
    Object.defineProperty(window, "parent", { configurable: true, get: () => fakeParent });
  });

  afterEach(() => {
    if (parentDescriptor) {
      Object.defineProperty(window, "parent", parentDescriptor);
    }
  });

  it("hostile: startBridge() posts to '/', never '*'; with an origin, to that origin", async () => {
    vi.resetModules();
    const { startBridge } = await import("../src/client/bridge.js");
    const stop = startBridge();
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.map((p) => p.targetOrigin)).toEqual(posted.map(() => "/"));
    stop();

    posted.length = 0;
    const stopAgain = startBridge({ panelOrigin: "http://localhost:5199" });
    expect(posted.length).toBeGreaterThan(0);
    expect(posted.every((p) => p.targetOrigin === "http://localhost:5199")).toBe(true);
    stopAgain();
  });
});

describe("L2: a panel page opened by another page", () => {
  const SENTENCE = "This devtools panel was opened by another page, so it does not connect.";
  let openerDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    openerDescriptor = Object.getOwnPropertyDescriptor(window, "opener");
  });

  afterEach(() => {
    unmountPanel();
    if (openerDescriptor) {
      Object.defineProperty(window, "opener", openerDescriptor);
    } else {
      delete (window as unknown as { opener?: unknown }).opener;
    }
  });

  it("hostile: with an opener it opens no panel, no stream and no app frame, and says why", async () => {
    Object.defineProperty(window, "opener", { configurable: true, get: () => ({ app: true }) });
    sessionStorage.setItem("boundThread", "t-copied-by-the-browser");
    const h = await mountPanel();
    expect(h.panelPosts, "no POST /api/panels").toHaveLength(0);
    expect(FakeEventSource.instances, "no event stream").toHaveLength(0);
    expect(h.rpcs, "no rpc").toHaveLength(0);
    expect(document.querySelector("iframe"), "no app frame").toBeNull();
    expect(text()).toContain(SENTENCE);
  });

  it("without an opener the panel mounts as usual", async () => {
    Object.defineProperty(window, "opener", { configurable: true, get: () => null });
    const h = await mountPanel();
    expect(h.panelPosts).toHaveLength(1);
    expect(text()).not.toContain(SENTENCE);
  });
});

describe("L3: dropped app messages are logged within a token bucket", () => {
  afterEach(() => vi.useRealTimers());

  it("hostile: 1000 junk messages are 1000 drops and at most a burst of lines; the refill logs the rest's count", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.resetModules();
    const { acceptAppMessage, droppedAppMessages, DROP_LOG_BURST, DROP_LOG_REFILL_MS } =
      await import("../src/panel/app-bridge.js");
    expect(DROP_LOG_BURST).toBe(32);
    const debug = vi.fn();
    const frame = { name: "the app iframe's window" };
    const junk = (i: number) =>
      acceptAppMessage(
        { source: frame, origin: "http://localhost:5173", data: { kind: "send", text: `x${i}` } },
        { frame, appOrigin: "http://localhost:5173" },
        { debug },
      );
    for (let i = 0; i < 1000; i++) {
      expect(junk(i)).toBeNull();
    }
    expect(droppedAppMessages()).toBe(1000);
    expect(debug.mock.calls.length).toBeLessThanOrEqual(32);
    expect(JSON.stringify(debug.mock.calls)).not.toContain("x999");

    const lines = debug.mock.calls.length;
    vi.advanceTimersByTime(DROP_LOG_REFILL_MS - 1);
    junk(1000);
    expect(debug.mock.calls.length, "no token before the interval").toBe(lines);
    vi.advanceTimersByTime(1);
    junk(1001);
    expect(debug.mock.calls.length).toBe(lines + 1);
    expect(debug.mock.calls.at(-1)![0]).toMatchObject({
      event: "panel_app_message_dropped",
      dropped: 1002,
      suppressed: 1001 - lines,
    });
    expect(droppedAppMessages()).toBe(1002);
  });
});
