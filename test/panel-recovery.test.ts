// @vitest-environment happy-dom
// Story 055, task 6.2 — supplementary cases for the recovery rules the deviation register and the
// reviews added to design.md §A3 (tasks 4.1, 4.2, 11.1), beside the frozen panel-state.test.ts:
//   - a relayed Zeo `error` is a MessageEvent with data and never re-creates the panel; only
//     EventSource's own error (a plain Event) does;
//   - `POST /api/panels` refused with 503 `too_many_panels` says so — never "Zeo is not running" —
//     and backs off on the R6.9 schedule like an unreachable Zeo;
//   - a fatal error the server held (`connection`, `error`, then the stream ends) shows its reason
//     through the recovery, until a new session opens;
//   - a subscribe refused with `agent_start_failed` (Zeo's reload budget is spent) is retried on
//     the backoff schedule, never in a tight loop;
//   - an `open` event carrying data (a server event named `open`) is not the stream opening.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeEventSource,
  mountPanel,
  snapshot,
  text,
  unmountPanel,
  type Harness,
  type Rpc,
} from "./helpers/panel-harness.js";

const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
const TOO_MANY = "Too many devtools panels are open — close one to continue";

afterEach(() => {
  vi.useRealTimers();
  unmountPanel();
});

const subscribes = (h: Harness, panel?: string) =>
  h.rpcs.filter(
    (r: Rpc) => r.msg.kind === "subscribe" && (panel === undefined || r.panel === panel),
  ).length;

/** Answers every later `POST /api/panels` with `status` and `{ error }`, recording when. */
function refusePanels(status: number, error: string): number[] {
  const inner = globalThis.fetch;
  const posts: number[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), location.href);
    if (url.pathname === "/api/panels" && (init?.method ?? "GET").toUpperCase() === "POST") {
      posts.push(Date.now());
      return {
        status,
        ok: false,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: async () => ({ error }),
      } as unknown as Response;
    }
    return inner(input, init);
  });
  return posts;
}

describe("stream errors", () => {
  it("hostile: a relayed Zeo error (a MessageEvent) is not a transport failure", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    const posts = h.panelPosts.length;
    await h.emit({ v: 2, kind: "error", error: "bad_request", message: "m", fatal: false });
    await new Promise((r) => setTimeout(r, 1300));
    await h.settle();
    expect(h.panelPosts.length, "no panel re-created").toBe(posts);
    expect(h.es().closed).toBe(false);
  });

  it("hostile: an `open` event with data does not count as the stream opening", async () => {
    const h = await mountPanel();
    const lists = () => h.rpcs.filter((r) => r.msg.kind === "list_threads").length;
    expect(lists()).toBe(1);
    const es = h.es() as FakeEventSource;
    const spoof = new MessageEvent("open", { data: "{}" });
    es.onopen?.(spoof);
    es.dispatchEvent(spoof);
    await h.settle();
    expect(lists(), "no second list_threads").toBe(1);
  });
});

describe("too many panels (503 too_many_panels)", () => {
  it("hostile: says so, never 'Zeo is not running', and backs off 1, 2, 4, 8, 16, 30 s", async () => {
    const h = await mountPanel();
    const posts = refusePanels(503, "too_many_panels");
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const start = Date.now();
    h.es().fail();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 30000 + 30000 + 500);
    expect(text()).toContain(TOO_MANY);
    expect(text()).not.toContain(UNREACHABLE);
    const times = posts.map((t) => t - start);
    expect(times[0]).toBe(1000);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps).toEqual([2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("a fatal error held by the server", () => {
  it("shows Zeo's reason through the recovery, until a new session opens", async () => {
    const h = await mountPanel();
    const first = h.es();
    first.emit("connection", { state: "connecting" });
    first.emit("error", {
      v: 2,
      kind: "error",
      error: "not_approved",
      message: "This panel was refused by Zeo",
      fatal: true,
    });
    await h.settle();
    expect(text()).toContain("This panel was refused by Zeo");
    first.fail();
    await vi.waitFor(() => expect(h.es()).not.toBe(first), { timeout: 3000 });
    expect(text()).toContain("This panel was refused by Zeo");
    h.es().emit("connection", { state: "open" });
    await h.settle();
    expect(text()).not.toContain("This panel was refused by Zeo");
  });
});

describe("subscribe refused while Zeo's reload budget is spent (agent_start_failed)", () => {
  it("hostile: retries on the backoff schedule, never in a tight loop", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    await h.emit({ v: 2, kind: "thread_closed" });
    const panel = h.panelIds[0]!;
    const refuse = () => {
      const id = h.lastRpc("subscribe")?.msg.id;
      h.es().emit("error", {
        v: 2,
        kind: "error",
        id,
        error: "agent_start_failed",
        message: "The agent could not be started",
        fatal: false,
      });
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const before = subscribes(h, panel);
    refuse();
    await vi.advanceTimersByTimeAsync(0);
    expect(text()).toContain("The agent could not be started");
    await vi.advanceTimersByTimeAsync(999);
    expect(subscribes(h, panel), "nothing before 1 s").toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribes(h, panel)).toBe(before + 1);
    refuse();
    await vi.advanceTimersByTimeAsync(1999);
    expect(subscribes(h, panel), "nothing before 2 s").toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(subscribes(h, panel)).toBe(before + 2);
    expect(sessionStorage.getItem("boundThread"), "the binding stays").toBe("t-b");
    expect(h.panelPosts.length, "no panel re-created").toBe(1);
  });
});
