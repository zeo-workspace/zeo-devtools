// @vitest-environment happy-dom
// Story 055, task 6.2 — the thread picker, New thread and the project-closed state (design.md §A3,
// §B6 URL fragment, §A3 Recovery). Requirements: R2.7, R5.4, R5.8, R6.1, R6.8, R6.9, R6.10,
// R7.2, R7.3, R7.5 (Q5).
// Validation filter: `npm test -- panel-state`.
//
// Seam: test/helpers/panel-harness.ts (`src/panel/main.ts` mounts on import; design.md §A1
// transport). A panel opened by Zeo carries `#thread=<id>` (design.md §B6), read and then removed
// from the address; `sessionStorage.boundThread` keeps the binding across a reload (§A3).
//
// Hostile halves first:
//   - closed state: while `project_closed` holds, clicking New thread and a listed thread sends
//     NOTHING (a disabled-looking control that still posts would pass a visual check), and the
//     chat of a bound thread is disabled too; `project_open` re-enables all of it on the SAME page
//     (no reload: no second EventSource, no second panel);
//   - binding identity: the thread `created` names is the one subscribed — never the previously
//     listed one — and a listed thread is bound by its own id;
//   - R7.5: no control and no rpc opens, raises or focuses Zeo;
//   - notices follow `event: connection`: `zeo_too_old` shows the too-old sentence and NOT the
//     unreachable one (wrongly collapsed into "disconnected"), `open` clears both;
//   - `error project_closed` closes the panel exactly like the `project_closed` event;
//   - R5.8: `not_found` for the bound thread drops the binding, while a `bad_request` keeps it;
//   - R6.8: a 503 keeps the composer text (a cleared composer loses the operator's message);
//   - R6.9: an EventSource error re-creates the panel on the SAME page with 1, 2, 4, 8, 16, 30 s
//     between failed attempts, then re-subscribes the bound thread on the NEW panel id; a 404 from
//     `/api/rpc` (the server forgot the panel) recovers the same way;
//   - R6.10: a failed create shows its reason and leaves New thread enabled and nothing bound.
//
// Refine v2 (2026-10-15), design.md §B3 Retention / §B4 Eviction / §A3 — Zeo may evict an idle
// bound thread and reload it; if the panel's stream still ends (`thread_closed`, 045's stream end,
// relayed by the panel server) WITHOUT a `not_found`, the panel re-sends `subscribe` for
// `boundThread` once, on the same panel, before falling back to the R6.9 recovery. Hostile halves
// first: the stream end is not R5.8 (the binding stays, no "no longer available"), and not R6.9
// either (no panel re-created on the first end); the re-send happens ONCE — a second end with no
// snapshot in between falls back to recovery instead of re-sending forever; and a `not_found`
// answering the re-send still drops the binding as R5.8 says, with no recovery loop.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FakeEventSource,
  button,
  buttons,
  clickable,
  composer,
  submit,
  type,
  mountPanel,
  snapshot,
  text,
  thread,
  unmountPanel,
  type Harness,
  type Rpc,
} from "./helpers/panel-harness.js";

const CLOSED = "Open this project in Zeo to continue";
const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
const TOO_OLD = "This Zeo does not support the devtools panel";
const GONE = "This thread is no longer available";

afterEach(() => {
  vi.useRealTimers();
  unmountPanel();
});

const subscribed = (r: Rpc | undefined) => {
  const m = r?.msg as { thread_id?: string; target?: { thread_id?: string } } | undefined;
  return m?.thread_id ?? m?.target?.thread_id;
};

const threads = (...ids: string[]) => ({
  v: 2,
  kind: "threads",
  id: "r1",
  items: ids.map((id) => thread(id, `Title ${id}`)),
});

const disabled = (el: Element | undefined) =>
  el === undefined ||
  (el as HTMLButtonElement).disabled === true ||
  el.getAttribute("aria-disabled") === "true" ||
  el.closest("[inert], fieldset[disabled]") !== null;

describe("no binding (R6.1, R5.4)", () => {
  it("shows New thread and the project's devtools threads, and no chat", async () => {
    const h = await mountPanel();
    await h.emit(threads("t1", "t2"));
    expect(button(/^new thread$/i)).toBeDefined();
    expect(text()).toContain("Title t1");
    expect(text()).toContain("Title t2");
    expect(composer(), "no composer without a bound thread").toBeUndefined();
    expect(button(/^stop$/i)).toBeUndefined();
    expect(h.lastRpc("subscribe")).toBeUndefined();
  });

  it("asks for the thread list itself", async () => {
    const h = await mountPanel();
    expect(h.lastRpc("list_threads")?.msg.kind).toBe("list_threads");
  });
});

describe("binding (R6.1, R5.4)", () => {
  it("hostile: New thread binds the thread `created` names, not a listed one", async () => {
    const h = await mountPanel();
    await h.emit(threads("t1"));
    button(/^new thread$/i)!.click();
    await h.settle();
    expect(h.lastRpc("create_thread")?.msg.kind).toBe("create_thread");
    await h.emit({ v: 2, kind: "created", id: "c1", thread: thread("t-new", "New thread") });
    expect(subscribed(h.lastRpc("subscribe"))).toBe("t-new");
    expect(sessionStorage.getItem("boundThread")).toBe("t-new");
    await h.emit(snapshot("t-new", []));
    expect(composer()).toBeDefined();
  });

  it("choosing a listed thread binds that thread by its id", async () => {
    const h = await mountPanel();
    await h.emit(threads("t1", "t2"));
    clickable("Title t2")!.click();
    await h.settle();
    expect(subscribed(h.lastRpc("subscribe"))).toBe("t2");
  });

  it("a panel opened with #thread=<id> binds it and removes the fragment", async () => {
    history.replaceState(null, "", "/#thread=t-from-zeo");
    const h = await mountPanel();
    expect(subscribed(h.lastRpc("subscribe"))).toBe("t-from-zeo");
    expect(location.hash).toBe("");
    expect(sessionStorage.getItem("boundThread")).toBe("t-from-zeo");
  });
});

describe("project closed and reopened (R7.2, R7.3)", () => {
  it("hostile: while closed, New thread and the list send nothing, and the message shows", async () => {
    const h = await mountPanel();
    await h.emit(threads("t1"));
    await h.emit({ v: 2, kind: "project_closed" });
    expect(text()).toContain(CLOSED);
    const before = h.rpcs.length;
    const newThread = button(/^new thread$/i);
    expect(disabled(newThread)).toBe(true);
    newThread?.click();
    clickable("Title t1")?.click();
    await h.settle();
    expect(h.rpcs.slice(before).map((r) => r.msg.kind)).toEqual([]);
  });

  it("hostile: a bound thread's chat is disabled while closed", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    await h.emit({ v: 2, kind: "project_closed" });
    const area = composer();
    expect(area === undefined || area.disabled || area.readOnly).toBe(true);
    const send = button(/^send$/i);
    expect(send === undefined || disabled(send)).toBe(true);
  });

  it("project_open re-enables everything on the same page, without a reload", async () => {
    const h = await mountPanel();
    const app = h.root;
    await h.emit(threads("t1"));
    await h.emit({ v: 2, kind: "project_closed" });
    await h.emit({ v: 2, kind: "project_open" });
    expect(text()).not.toContain(CLOSED);
    expect(FakeEventSource.instances.filter((e) => e.url.includes("/api/events"))).toHaveLength(1);
    expect(document.getElementById("app")).toBe(app);
    const newThread = button(/^new thread$/i);
    expect(disabled(newThread)).toBe(false);
    newThread!.click();
    await h.settle();
    expect(h.lastRpc("create_thread")).toBeDefined();
  });
});

describe("the panel never raises Zeo (R7.5)", () => {
  it("hostile: no control opens, raises or focuses Zeo, and no such rpc is ever sent", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(threads("t-b"));
    await h.emit(snapshot("t-b", [{ role: "assistant", markdown: "hi" }]));
    for (const b of buttons()) {
      const name = `${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`;
      expect(name).not.toMatch(/open in zeo|show in zeo|focus zeo|raise zeo/i);
    }
    expect(h.rpcs.map((r) => r.msg.kind)).not.toContain("open_in_zeo");
  });
});

/** The error a panel server relays for one rpc, echoing its id when the panel sent one. */
const errorFor = (r: Rpc | undefined, error: string, message = "m") => ({
  v: 2,
  kind: "error",
  ...(typeof r?.msg.id === "string" ? { id: r.msg.id } : {}),
  error,
  message,
  fatal: false,
});

/** `event: connection` carries `{ state }` only (design.md §A1). */
async function connection(h: Harness, state: string) {
  h.es().emit("connection", { state });
  await h.settle();
}

describe("connection notices (A3, R2.7)", () => {
  it("hostile: zeo_too_old says Zeo is too old, not that it is unreachable; open clears both", async () => {
    const h = await mountPanel();
    await connection(h, "connecting");
    expect(text()).toContain(UNREACHABLE);
    await connection(h, "zeo_too_old");
    expect(text()).toContain(TOO_OLD);
    expect(text()).not.toContain(UNREACHABLE);
    await connection(h, "open");
    expect(text()).not.toContain(TOO_OLD);
    expect(text()).not.toContain(UNREACHABLE);
  });
});

describe("error project_closed (A3)", () => {
  it("closes the panel like the project_closed event", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    await h.emit(errorFor(h.lastRpc("subscribe"), "project_closed"));
    expect(text()).toContain(CLOSED);
    expect(disabled(button(/^new thread$/i))).toBe(true);
  });
});

describe("the bound thread disappears (R5.8)", () => {
  it("hostile: not_found drops the binding and shows the list; bad_request keeps it", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(threads("t-other"));
    await h.emit(snapshot("t-b", []));
    await h.emit(errorFor(h.lastRpc("subscribe"), "bad_request"));
    expect(sessionStorage.getItem("boundThread"), "bad_request is not not_found").toBe("t-b");
    expect(composer()).toBeDefined();

    await h.emit(errorFor(h.lastRpc("subscribe"), "not_found"));
    expect(sessionStorage.getItem("boundThread")).toBeNull();
    expect(text()).toContain(GONE);
    expect(button(/^new thread$/i)).toBeDefined();
    expect(text()).toContain("Title t-other");
    expect(composer(), "no chat without a binding").toBeUndefined();
  });
});

describe("Zeo unreachable on send (R6.8)", () => {
  it("hostile: a 503 keeps the composer text and shows the unreachable notice", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    h.rpcStatus = 503;
    const found = composer();
    expect(found, "a composer for the bound thread").toBeDefined();
    const area = found!;
    await type(area, "keep me");
    await submit(area);
    await h.settle();
    expect(h.lastRpc("send")?.msg).toMatchObject({ text: "keep me" });
    expect(composer()!.value).toBe("keep me");
    expect(text()).toContain(UNREACHABLE);
    expect(sessionStorage.getItem("boundThread")).toBe("t-b");
  });
});

describe("dev server restart (R6.9)", () => {
  const resubscribedOn = (h: Harness, panel: string) =>
    h.rpcs.some((r) => r.panel === panel && r.msg.kind === "subscribe" && subscribed(r) === "t-b");

  it("an EventSource error re-creates the panel and re-binds the thread without a reload", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    const app = h.root;
    const first = h.es();
    first.fail();
    await vi.waitFor(() => expect(h.panelIds.length).toBe(2), { timeout: 3000 });
    const second = h.panelIds[1]!;
    await vi.waitFor(() => expect(h.es()).not.toBe(first), { timeout: 3000 });
    expect(h.es().url).toContain(encodeURIComponent(second));
    await vi.waitFor(() => expect(resubscribedOn(h, second)).toBe(true), { timeout: 3000 });
    expect(document.getElementById("app"), "same page").toBe(app);
  });

  it("a 404 from /api/rpc (the server forgot the panel) recovers the same way", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    h.rpcStatus = 404;
    const found = composer();
    expect(found, "a composer for the bound thread").toBeDefined();
    const area = found!;
    await type(area, "after restart");
    await submit(area);
    h.rpcStatus = 204;
    await vi.waitFor(() => expect(h.panelIds.length).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(resubscribedOn(h, h.panelIds[1]!)).toBe(true), { timeout: 3000 });
  });

  it("hostile: failed re-creations back off 1, 2, 4, 8, 16, then 30 s", async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    h.panelsStatus = 503;
    const before = h.panelPosts.length;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const start = Date.now();
    h.es().fail();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 8000 + 16000 + 30000 + 30000 + 500);
    const times = h.panelPosts.slice(before).map((t) => t - start);
    expect(times.length, `attempts at ${times.join(", ")} ms`).toBeGreaterThanOrEqual(6);
    // The first re-creation may be immediate or at 1 s; the gaps after it follow the schedule.
    const schedule = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
    const expected = times[0]! < 1000 ? schedule : schedule.slice(1);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps).toEqual(expected.slice(0, gaps.length));
    expect(times[0]!).toBeLessThanOrEqual(1000);

    // Zeo and the dev server are back: the next attempt succeeds and re-binds.
    h.panelsStatus = 200;
    await vi.advanceTimersByTimeAsync(30_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(h.panelIds.length).toBe(2), { timeout: 3000 });
    await vi.waitFor(() => expect(resubscribedOn(h, h.panelIds[1]!)).toBe(true), { timeout: 3000 });
  });
});

describe("thread creation fails (R6.10)", () => {
  it("hostile: shows the reason, binds nothing, and New thread still works", async () => {
    const h = await mountPanel();
    await h.emit(threads("t1"));
    button(/^new thread$/i)!.click();
    await h.settle();
    const create = h.lastRpc("create_thread");
    expect(create).toBeDefined();
    await h.emit(errorFor(create, "agent_start_failed", "The agent failed to start"));
    expect(text()).toContain("The agent failed to start");
    expect(h.lastRpc("subscribe")).toBeUndefined();
    expect(sessionStorage.getItem("boundThread")).toBeNull();
    const newThread = button(/^new thread$/i);
    expect(disabled(newThread)).toBe(false);
    const count = h.rpcs.filter((r) => r.msg.kind === "create_thread").length;
    newThread!.click();
    await h.settle();
    expect(h.rpcs.filter((r) => r.msg.kind === "create_thread")).toHaveLength(count + 1);
  });
});

// ---- Refine v2 (2026-10-15): a bound stream ending without not_found (B3/B4 eviction, A3) -----

describe("the bound thread's stream ends without not_found (eviction)", () => {
  const STREAM_END = { v: 2, kind: "thread_closed" };
  const resubscribes = (h: Harness, panel: string) =>
    h.rpcs.filter((r) => r.panel === panel && r.msg.kind === "subscribe" && subscribed(r) === "t-b")
      .length;
  const bound = async () => {
    sessionStorage.setItem("boundThread", "t-b");
    const h = await mountPanel();
    await h.emit(snapshot("t-b", []));
    return { h, first: h.panelIds[0]! };
  };

  it("hostile: it re-subscribes the same thread once, on the same panel, and keeps the binding", async () => {
    const { h, first } = await bound();
    const before = resubscribes(h, first);
    const posts = h.panelPosts.length;
    await h.emit(STREAM_END);
    await vi.waitFor(() => expect(resubscribes(h, first)).toBe(before + 1), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 200));
    await h.settle();
    expect(resubscribes(h, first), "exactly one re-send").toBe(before + 1);
    expect(sessionStorage.getItem("boundThread"), "not R5.8: the binding stays").toBe("t-b");
    expect(text()).not.toContain(GONE);
    expect(h.panelPosts.length, "not R6.9: no panel re-created on the first end").toBe(posts);

    // Zeo reloaded the thread: the fresh snapshot brings the chat back on the same page.
    await h.emit(snapshot("t-b", [{ role: "assistant", markdown: "back again" }]));
    expect(text()).toContain("back again");
    expect(composer()).toBeDefined();
  });

  it("hostile: a second end with no snapshot in between falls back to recovery, not another re-send", async () => {
    const { h, first } = await bound();
    const before = resubscribes(h, first);
    await h.emit(STREAM_END);
    await vi.waitFor(() => expect(resubscribes(h, first)).toBe(before + 1), { timeout: 3000 });
    await h.emit(STREAM_END);
    await vi.waitFor(() => expect(h.panelIds.length).toBe(2), { timeout: 3000 });
    const second = h.panelIds[1]!;
    await vi.waitFor(() => expect(resubscribes(h, second)).toBeGreaterThanOrEqual(1), {
      timeout: 3000,
    });
    expect(resubscribes(h, first), "only the one re-send on the old panel").toBe(before + 1);
    expect(sessionStorage.getItem("boundThread")).toBe("t-b");
  });

  it("converse: a not_found answering the re-send drops the binding (R5.8), with no recovery loop", async () => {
    const { h, first } = await bound();
    const before = resubscribes(h, first);
    const posts = h.panelPosts.length;
    await h.emit(STREAM_END);
    await vi.waitFor(() => expect(resubscribes(h, first)).toBe(before + 1), { timeout: 3000 });
    await h.emit(errorFor(h.lastRpc("subscribe"), "not_found"));
    expect(sessionStorage.getItem("boundThread")).toBeNull();
    expect(text()).toContain(GONE);
    await new Promise((r) => setTimeout(r, 200));
    await h.settle();
    expect(resubscribes(h, first), "no further re-send").toBe(before + 1);
    expect(h.panelPosts.length, "and no panel re-created").toBe(posts);
  });
});
