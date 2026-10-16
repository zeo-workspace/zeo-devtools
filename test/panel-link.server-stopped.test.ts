// @vitest-environment happy-dom
// Story 055, task 17.1 (refine v3) — the panel tells its own server stopping apart from Zeo being
// unreachable (design.md §A3 "Own server gone (v3)"). Requirements: R3.8, R3.9 (Q4, Q13).
// Validation filter: `npm test -- panel-link`.
//
// Contract (design.md §A3): when the event stream is lost, the page probes its own origin with
// `GET /api/config` (`cache: "no-store"`, 2 s timeout) before choosing the down state:
//   - a network error, or no answer within 2 s → R3.8: "The dev server stopped. Start devtools
//     from Zeo to continue.", the chat and New thread disabled, the typed draft kept, and the
//     re-creation attempts keep their backoff;
//   - any HTTP answer → R3.9: today's "Zeo is not running, or its devtools bridge is off";
//   - a later successful re-creation restores the panel.
// Why a probe: Zeo stops the dev server with a signal, and a killed process sends nothing.
//
// Seam: test/helpers/panel-harness.ts (the page mounts on import, fetch and EventSource are
// stubbed). This file wraps the harness's fetch so the panel server can "go away" — every request
// then fails the way a browser's fetch does when nothing listens (a TypeError) — or hang. Real
// timers: the probe's 2 s timeout and the 1 s backoff run on the clock, so waits carry their own
// budget.
//
// Hostile halves first (R3.8 vs R3.9 is a "same or different" rule):
//   - wrongly collapsed: an origin that does not answer is NOT "Zeo is not running" — and an origin
//     that answers with an error status (503) is NOT "the dev server stopped": any answer means
//     the server is up (an `res.ok` check would collapse the two);
//   - wrongly split: a probe that never answers is the same as one that fails at once — stopped;
//   - the draft survives: disabled is not cleared;
//   - only then the benign return of the server.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  button,
  composer,
  mountPanel,
  snapshot,
  text,
  thread,
  type,
  unmountPanel,
  type Harness,
} from "./helpers/panel-harness.js";

vi.setConfig({ testTimeout: 20_000 });

const STOPPED = "The dev server stopped. Start devtools from Zeo to continue.";
const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
const DRAFT = "half-typed message the operator must not lose";

afterEach(() => {
  vi.useRealTimers();
  // The page going away ends its link (main.ts), so no re-creation of this test's panel fires
  // into the next test's stubs.
  window.dispatchEvent(new Event("pagehide"));
  unmountPanel();
});

type Mode =
  /** The panel server answers, through the harness. */
  | "up"
  /** Nothing listens: every request fails as a browser's fetch does. */
  | "down"
  /** `/api/config` never answers (until aborted); every other request fails. */
  | "hang"
  /** `/api/config` answers 503; everything else goes to the harness. */
  | "config_503";

interface Probe {
  at: number;
  cache: RequestCache | undefined;
}

interface Origin {
  mode: Mode;
  /** Every `GET /api/config` made after the switch was installed. */
  probes: Probe[];
  /** Every `POST /api/panels` attempted, answered or not. */
  panelAttempts: number[];
}

const status503 = () =>
  ({
    status: 503,
    ok: false,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => ({ error: "unavailable" }),
    text: async () => '{"error":"unavailable"}',
  }) as unknown as Response;

/** Wraps the harness's fetch so the test decides whether the panel server is still there. */
function originSwitch(): Origin {
  const inner = globalThis.fetch;
  const origin: Origin = { mode: "up", probes: [], panelAttempts: [] };
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const isProbe = method === "GET" && url.pathname === "/api/config";
    if (isProbe) {
      origin.probes.push({ at: Date.now(), cache: init?.cache });
    }
    if (method === "POST" && url.pathname === "/api/panels") {
      origin.panelAttempts.push(Date.now());
    }
    switch (origin.mode) {
      case "down":
        return Promise.reject(new TypeError("Failed to fetch"));
      case "hang":
        if (!isProbe) {
          return Promise.reject(new TypeError("Failed to fetch"));
        }
        return new Promise<Response>((_, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () =>
            reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError")),
          );
        });
      case "config_503":
        return isProbe ? Promise.resolve(status503()) : inner(input, init);
      default:
        return inner(input, init);
    }
  });
  return origin;
}

const disabled = (el: Element | undefined) =>
  el === undefined ||
  (el as HTMLButtonElement).disabled === true ||
  (el as HTMLTextAreaElement).readOnly === true ||
  el.getAttribute("aria-disabled") === "true" ||
  el.closest("[inert], fieldset[disabled]") !== null;

/** A panel bound to `t-b`, with its snapshot shown and `DRAFT` typed but not sent. */
async function boundWithDraft(): Promise<{ h: Harness; origin: Origin }> {
  sessionStorage.setItem("boundThread", "t-b");
  const h = await mountPanel();
  await h.emit(snapshot("t-b", [{ role: "assistant", markdown: "earlier reply" }]));
  const area = composer();
  expect(area, "a composer for the bound thread").toBeDefined();
  await type(area!, DRAFT);
  expect(disabled(button(/^send$/i)), "Send is enabled before the loss").toBe(false);
  const origin = originSwitch();
  return { h, origin };
}

function expectChatDisabledDraftKept() {
  const area = composer();
  expect(area, "the textarea is still on the page").toBeDefined();
  expect(area!.value, "the typed draft is kept").toBe(DRAFT);
  expect(disabled(area), "the chat is disabled").toBe(true);
  expect(disabled(button(/^send$/i)), "Send is disabled").toBe(true);
}

// ---- hostile: an origin that does not answer is not "Zeo is not running" -----------------------

describe("the panel's own server stops (R3.8)", () => {
  it("hostile: a network error on the probe shows R3.8, not the unreachable notice; chat disabled, draft kept", async () => {
    const { h, origin } = await boundWithDraft();
    origin.mode = "down";
    h.es().fail();

    await vi.waitFor(() => expect(text()).toContain(STOPPED), { timeout: 3000 });
    expect(text(), "not R3.9's notice: the origin did not answer").not.toContain(UNREACHABLE);
    expectChatDisabledDraftKept();

    // The page asked its own origin, uncached, before choosing.
    expect(origin.probes.length, "a GET /api/config probe after the loss").toBeGreaterThanOrEqual(
      1,
    );
    expect(origin.probes[0]!.cache).toBe("no-store");
  });

  it("hostile: a probe that never answers counts as stopped after its timeout", async () => {
    const { h, origin } = await boundWithDraft();
    origin.mode = "hang";
    h.es().fail();

    await vi.waitFor(() => expect(origin.probes.length).toBeGreaterThanOrEqual(1), {
      timeout: 2000,
    });
    // Within ~2 s of the probe, plus scheduling slack: a hung origin is a stopped one.
    await vi.waitFor(() => expect(text()).toContain(STOPPED), { timeout: 4500 });
    expect(text()).not.toContain(UNREACHABLE);
    expectChatDisabledDraftKept();
  });

  it("hostile: with no thread bound, New thread is disabled and sends nothing while stopped", async () => {
    const h = await mountPanel();
    await h.emit({ v: 2, kind: "threads", id: "r1", items: [thread("t1", "Title t1")] });
    expect(disabled(button(/^new thread$/i)), "New thread works before the loss").toBe(false);
    const origin = originSwitch();
    origin.mode = "down";
    h.es().fail();

    await vi.waitFor(() => expect(text()).toContain(STOPPED), { timeout: 3000 });
    const newThread = button(/^new thread$/i);
    expect(disabled(newThread), "New thread is disabled").toBe(true);
    const before = h.rpcs.length;
    newThread?.click();
    await h.settle();
    expect(h.rpcs.slice(before).map((r) => r.msg.kind)).toEqual([]);
  });

  it("re-creation keeps its backoff while stopped, and the notice stays through failed attempts", async () => {
    const { h, origin } = await boundWithDraft();
    origin.mode = "down";
    const lostAt = Date.now();
    h.es().fail();
    await vi.waitFor(() => expect(text()).toContain(STOPPED), { timeout: 3000 });

    // The first scheduled re-creation (1 s on the schedule) runs and fails: still stopped.
    await vi.waitFor(() => expect(origin.panelAttempts.length).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    expect(origin.panelAttempts[0]! - lostAt, "not a tight loop").toBeGreaterThanOrEqual(900);
    expect(text(), "a failed attempt does not flip R3.8 into R3.9").toContain(STOPPED);
    expect(text()).not.toContain(UNREACHABLE);
    expectChatDisabledDraftKept();
  });
});

// ---- converse: an origin that answers keeps today's notice (R3.9) ------------------------------

describe("the panel's own server still answers (R3.9)", () => {
  it("hostile: a 200 from the probe keeps the unreachable notice, not R3.8", async () => {
    const { h, origin } = await boundWithDraft();
    // The panel server is up; Zeo is not (its panels cannot open).
    h.panelsStatus = 503;
    h.es().fail();

    await vi.waitFor(() => expect(origin.probes.length).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect(text()).toContain(UNREACHABLE), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    expect(text(), "the origin answered: not R3.8").not.toContain(STOPPED);
    expect(composer()!.value, "the draft is kept here too").toBe(DRAFT);
  });

  it("hostile: an error status from the probe is still an answer — unreachable, not stopped", async () => {
    const { h, origin } = await boundWithDraft();
    origin.mode = "config_503";
    h.panelsStatus = 503;
    h.es().fail();

    await vi.waitFor(() => expect(origin.probes.length).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    await vi.waitFor(() => expect(text()).toContain(UNREACHABLE), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 300));
    await h.settle();
    expect(text()).not.toContain(STOPPED);
  });
});

// ---- benign: the server comes back ---------------------------------------------------------------

describe("the server comes back", () => {
  it("a successful re-creation after R3.8 restores the panel, the chat and the draft", async () => {
    const { h, origin } = await boundWithDraft();
    origin.mode = "down";
    h.es().fail();
    await vi.waitFor(() => expect(text()).toContain(STOPPED), { timeout: 3000 });

    origin.mode = "up";
    h.panelsStatus = 200;
    await vi.waitFor(() => expect(h.panelIds.length).toBe(2), { timeout: 8000 });
    await vi.waitFor(
      () =>
        expect(h.rpcs.some((r) => r.panel === h.panelIds[1] && r.msg.kind === "subscribe")).toBe(
          true,
        ),
      { timeout: 3000 },
    );
    await h.emit(snapshot("t-b", [{ role: "assistant", markdown: "back again" }]));

    expect(text()).not.toContain(STOPPED);
    expect(text()).not.toContain(UNREACHABLE);
    const area = composer();
    expect(area!.value, "the draft survived the whole outage").toBe(DRAFT);
    expect(disabled(area), "the chat is enabled again").toBe(false);
    expect(disabled(button(/^send$/i))).toBe(false);
  });
});
