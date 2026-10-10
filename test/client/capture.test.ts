// Story 033, task 4.3 — screenshot crop math and tab-capture start (design.md Behaviour
// rule 4, Gotchas on getDisplayMedia and the crop scale). Requirements: R5.1, R5.2, R5.5,
// R5.6. Pure `cropRect` plus the reason mapping with a stubbed `navigator.mediaDevices`;
// the frame grab itself (R5.4, the downsizing of R5.5) is proved by the E2E in Task 9.2.
// Contract: `cropRect(rects, viewport, frame)` (rects in CSS px `{x,y,w,h}`, viewport
// `{w,h}` = innerWidth/innerHeight, frame `{w,h}` = video size) → crop in frame px;
// `TabCapture` with `start()`, `grab(rect, hideOverlay)`, `stop()`, `isLive`.
// `start()` resolves a typed reason on failure (`refused | unsupported | not_this_tab`);
// `reasonOf` accepts the reason as a bare string or as `{ reason }` — adjust only it.
//
// Hostile halves:
//   - the scale is videoWidth / innerWidth, NOT devicePixelRatio: with dpr 3 and a frame at
//     2× the viewport the crop must be 2× (wrongly 3×);
//   - `start()` must call getDisplayMedia synchronously, before any await (user activation);
//   - a stream whose surface is a window/monitor is refused as `not_this_tab` and stopped,
//     while a `browser` surface goes live.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TabCapture, cropRect } from "../../src/client/capture.js";

const reasonOf = (r: unknown): string | undefined =>
  typeof r === "string" ? r : (r as { reason?: string } | null | undefined)?.reason;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cropRect (R5.5)", () => {
  it("is the rect itself at scale 1", () => {
    expect(
      cropRect([{ x: 10, y: 20, w: 100, h: 50 }], { w: 1000, h: 800 }, { w: 1000, h: 800 }),
    ).toEqual({
      x: 10,
      y: 20,
      w: 100,
      h: 50,
    });
  });

  it("hostile: scales by frame/viewport, never by devicePixelRatio", () => {
    vi.stubGlobal("devicePixelRatio", 3);
    expect(
      cropRect([{ x: 10, y: 20, w: 100, h: 50 }], { w: 1000, h: 800 }, { w: 2000, h: 1600 }),
    ).toEqual({
      x: 20,
      y: 40,
      w: 200,
      h: 100,
    });
  });

  it("takes the union of several element rects", () => {
    const rects = [
      { x: 10, y: 10, w: 50, h: 50 },
      { x: 200, y: 100, w: 40, h: 20 },
    ];
    expect(cropRect(rects, { w: 1000, h: 800 }, { w: 1000, h: 800 })).toEqual({
      x: 10,
      y: 10,
      w: 230,
      h: 110,
    });
  });

  it("clamps to the frame when an element sticks out of the viewport", () => {
    expect(
      cropRect([{ x: -30, y: 700, w: 100, h: 300 }], { w: 1000, h: 800 }, { w: 1000, h: 800 }),
    ).toEqual({
      x: 0,
      y: 700,
      w: 70,
      h: 100,
    });
  });
});

type Track = {
  getSettings: () => { displaySurface?: string };
  stop: ReturnType<typeof vi.fn>;
  addEventListener: (type: string, fn: () => void) => void;
  fire: (type: string) => void;
};

function track(displaySurface: string | undefined): Track {
  const listeners = new Map<string, Array<() => void>>();
  return {
    getSettings: () => (displaySurface === undefined ? {} : { displaySurface }),
    stop: vi.fn(),
    addEventListener: (type, fn) => listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    fire: (type) => (listeners.get(type) ?? []).forEach((fn) => fn()),
  };
}

function stubDisplayMedia(impl: (opts: unknown) => Promise<unknown>) {
  const getDisplayMedia = vi.fn(impl);
  vi.stubGlobal("navigator", { mediaDevices: { getDisplayMedia } });
  return getDisplayMedia;
}

const streamOf = (t: Track) => ({
  getVideoTracks: () => [t],
  getTracks: () => [t],
});

describe("TabCapture.start (R5.1, R5.6)", () => {
  it("asks for the current tab synchronously, before any await", () => {
    const t = track("browser");
    const gdm = stubDisplayMedia(() => Promise.resolve(streamOf(t)));
    const cap = new TabCapture();
    void cap.start();
    expect(gdm).toHaveBeenCalledTimes(1); // no microtask has run yet
    const opts = gdm.mock.calls[0]![0] as {
      video?: { displaySurface?: string };
      preferCurrentTab?: boolean;
      selfBrowserSurface?: string;
    };
    expect(opts.preferCurrentTab).toBe(true);
    expect(opts.selfBrowserSurface).toBe("include");
    expect(opts.video).toMatchObject({ displaySurface: "browser" });
  });

  it("goes live on a browser-tab surface (R5.2 keeps it live across sends)", async () => {
    const t = track("browser");
    stubDisplayMedia(() => Promise.resolve(streamOf(t)));
    const cap = new TabCapture();
    const result = await cap.start();
    expect(reasonOf(result)).toBeUndefined();
    expect(cap.isLive).toBe(true);
    expect(t.stop).not.toHaveBeenCalled();
  });

  it("hostile: a window or screen surface is not_this_tab, and its track is stopped", async () => {
    for (const surface of ["window", "monitor"]) {
      const t = track(surface);
      stubDisplayMedia(() => Promise.resolve(streamOf(t)));
      const cap = new TabCapture();
      expect(reasonOf(await cap.start())).toBe("not_this_tab");
      expect(cap.isLive).toBe(false);
      expect(t.stop).toHaveBeenCalled();
    }
  });

  it("a refusal resolves `refused` and never throws", async () => {
    stubDisplayMedia(() =>
      Promise.reject(Object.assign(new Error("denied"), { name: "NotAllowedError" })),
    );
    const cap = new TabCapture();
    await expect(cap.start()).resolves.toBeDefined();
    expect(reasonOf(await new TabCapture().start())).toBe("refused");
    expect(cap.isLive).toBe(false);
  });

  it("hostile: NotSupportedError resolves `unsupported`, not `refused`, and is not asked again", async () => {
    const gdm = stubDisplayMedia(() =>
      Promise.reject(Object.assign(new Error("Not supported"), { name: "NotSupportedError" })),
    );
    const cap = new TabCapture();
    expect(reasonOf(await cap.start())).toBe("unsupported");
    expect(reasonOf(await cap.start())).toBe("unsupported");
    expect(gdm).toHaveBeenCalledTimes(1);
    expect(cap.isLive).toBe(false);
  });

  it("a browser that cannot report displaySurface is never asked (Firefox)", async () => {
    const getDisplayMedia = vi.fn(() => Promise.resolve(streamOf(track(undefined))));
    vi.stubGlobal("navigator", {
      mediaDevices: { getDisplayMedia, getSupportedConstraints: () => ({ width: true }) },
    });
    const cap = new TabCapture();
    expect(reasonOf(await cap.start())).toBe("unsupported");
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it("a browser without getDisplayMedia resolves `unsupported` and never throws", async () => {
    vi.stubGlobal("navigator", { mediaDevices: undefined });
    const cap = new TabCapture();
    expect(reasonOf(await cap.start())).toBe("unsupported");
    vi.stubGlobal("navigator", { mediaDevices: {} });
    expect(reasonOf(await new TabCapture().start())).toBe("unsupported");
    expect(cap.isLive).toBe(false);
  });
});

describe("TabCapture liveness (R5.2, R5.3)", () => {
  it("stops being live when the user ends sharing from the browser's own bar", async () => {
    const t = track("browser");
    stubDisplayMedia(() => Promise.resolve(streamOf(t)));
    const cap = new TabCapture();
    await cap.start();
    expect(cap.isLive).toBe(true);
    t.fire("ended");
    expect(cap.isLive).toBe(false);
  });

  it("stop() ends the track and is no longer live", async () => {
    const t = track("browser");
    stubDisplayMedia(() => Promise.resolve(streamOf(t)));
    const cap = new TabCapture();
    await cap.start();
    cap.stop();
    expect(t.stop).toHaveBeenCalled();
    expect(cap.isLive).toBe(false);
  });
});
