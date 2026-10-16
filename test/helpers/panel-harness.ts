// Story 055 — mounts the panel page in happy-dom against a fake panel server, through the
// transport design.md §A1 fixes: `fetch("POST /api/panels")` → `{ panel }`,
// `new EventSource("/api/events?panel=<id>")` streaming named events (`event: <kind>`), and
// `fetch("POST /api/rpc", { panel, msg })` → 204, and `GET /api/config` → `{ app_url, root }`.
// The test can make `/api/panels` and `/api/rpc` fail (503, 404) and make the EventSource error,
// to drive the recovery of design.md §A3 (R6.8, R6.9). Fake responses resolve through microtasks
// only (no happy-dom `Response` timers), so fake timers can drive the backoff. Test support only.
//
// Assumed seam (adjust `mountPanel` alone if it moves): the page's entry is
// `src/panel/main.ts`, which mounts on import into `#app` (the element `src/panel/index.html`
// provides, as zeo-browser's sidebar entry does). Controls are found the way an operator finds
// them — by visible text or accessible name — never by class or id.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";

export type Rpc = { panel: string; msg: Record<string, unknown> & { kind: string } };

export class FakeEventSource extends EventTarget {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readyState = 0;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onopen: ((e: Event) => void) | null = null;
  closed = false;
  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeEventSource.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      const e = new Event("open");
      this.onopen?.(e);
      this.dispatchEvent(e);
    });
  }
  /** Delivers one server message as the panel server would: `event: <kind>`, `data: <json>`. */
  emit(kind: string, data: object) {
    const e = new MessageEvent(kind, { data: JSON.stringify(data) });
    this.dispatchEvent(e);
    if (kind === "message") {
      this.onmessage?.(e);
    }
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  /** What a browser does when the stream's server goes away and the retry gets a non-200. */
  fail() {
    this.readyState = 2;
    const e = new Event("error");
    this.onerror?.(e);
    this.dispatchEvent(e);
  }
}

export interface Harness {
  root: HTMLElement;
  rpcs: Rpc[];
  /** Status `/api/panels` answers (200 with a fresh id, or a failure status). */
  panelsStatus: number;
  /** Status `/api/rpc` answers: 204, 503 (`zeo_unreachable`) or 404 (unknown panel). */
  rpcStatus: number;
  /** `Date.now()` at each `POST /api/panels`, successful or not. */
  panelPosts: number[];
  /** Every panel id handed out, in order. */
  panelIds: string[];
  es(): FakeEventSource;
  /** Emits a v2 server message on the panel's stream and lets the page react. */
  emit(msg: Record<string, unknown> & { kind: string }): Promise<void>;
  lastRpc(kind: string): Rpc | undefined;
  settle(): Promise<void>;
}

const PANEL_ID = "p-0123456789abcdef0123456789abcdef";
export const APP_URL = "http://localhost:5173/";
export const ROOT = "/home/dev/app";

/** A minimal Response: status, ok and json(), resolved through microtasks only. */
const reply = (status: number, body?: unknown) =>
  ({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers({ "Content-Type": "application/json" }),
    json: async () => body,
    text: async () => (body === undefined ? "" : JSON.stringify(body)),
  }) as unknown as Response;

export const tick = async (n = 5) => {
  for (let i = 0; i < n; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

/** Puts the panel page's body (without its scripts) into the document, or a bare `#app`. */
function loadPageBody() {
  // From the package root (vitest's cwd): under happy-dom `import.meta.url` is not a file URL.
  const html = join(process.cwd(), "src/panel/index.html");
  const source = existsSync(html) ? readFileSync(html, "utf8") : '<div id="app"></div>';
  const parsed = new DOMParser().parseFromString(source, "text/html");
  for (const script of [...parsed.querySelectorAll("script")]) {
    script.remove();
  }
  document.body.replaceChildren(...[...parsed.body.childNodes].map((n) => document.adoptNode(n)));
  if (document.getElementById("app") === null) {
    const app = document.createElement("div");
    app.id = "app";
    document.body.append(app);
  }
}

export async function mountPanel(): Promise<Harness> {
  FakeEventSource.instances = [];
  const rpcs: Rpc[] = [];
  const state = {
    panelsStatus: 200,
    rpcStatus: 204,
    panelPosts: [] as number[],
    panelIds: [] as string[],
  };
  const fetchFake = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), location.href);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    const body = init?.body !== undefined ? JSON.parse(String(init.body)) : undefined;
    if (method === "GET" && url.pathname === "/api/config") {
      return reply(200, { app_url: APP_URL, root: ROOT });
    }
    if (method === "POST" && url.pathname === "/api/panels") {
      state.panelPosts.push(Date.now());
      if (state.panelsStatus !== 200) {
        return reply(state.panelsStatus, { error: "zeo_unreachable" });
      }
      const id =
        state.panelIds.length === 0 ? PANEL_ID : `p-${state.panelIds.length + 1}-fedcba9876543210`;
      state.panelIds.push(id);
      return reply(200, { panel: id });
    }
    if (method === "POST" && url.pathname === "/api/rpc") {
      rpcs.push(body as Rpc);
      if (state.rpcStatus === 503) {
        return reply(503, { error: "zeo_unreachable" });
      }
      if (state.rpcStatus === 404) {
        return reply(404, { error: "unknown panel" });
      }
      return reply(204);
    }
    return reply(404, { error: "not_found" });
  });
  vi.stubGlobal("fetch", fetchFake);
  vi.stubGlobal("EventSource", FakeEventSource);

  loadPageBody();
  vi.resetModules();
  await import("../../src/panel/main.js");
  const settle = () => tick(10);
  await settle();

  const harness: Harness = {
    root: document.getElementById("app") ?? document.body,
    rpcs,
    get panelsStatus() {
      return state.panelsStatus;
    },
    set panelsStatus(v: number) {
      state.panelsStatus = v;
    },
    get rpcStatus() {
      return state.rpcStatus;
    },
    set rpcStatus(v: number) {
      state.rpcStatus = v;
    },
    panelPosts: state.panelPosts,
    panelIds: state.panelIds,
    es() {
      // The newest stream: after a recovery the page opens a new one.
      const es = [...FakeEventSource.instances]
        .reverse()
        .find((e) => e.url.includes("/api/events"));
      if (!es) {
        throw new Error("the panel opened no EventSource on /api/events");
      }
      return es;
    },
    async emit(msg) {
      harness.es().emit(msg.kind, msg);
      await settle();
    },
    lastRpc(kind) {
      return [...rpcs].reverse().find((r) => r.msg.kind === kind);
    },
    settle,
  };
  return harness;
}

export function unmountPanel() {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  sessionStorage.clear();
  history.replaceState(null, "", "/");
}

// ---- operator-level queries ----------------------------------------------------------------

const visible = (el: Element): boolean => {
  for (let e: Element | null = el; e; e = e.parentElement) {
    if ((e as HTMLElement).hidden || (e as HTMLElement).style?.display === "none") {
      return false;
    }
  }
  return true;
};

const nameOf = (el: Element) =>
  (el.getAttribute("aria-label") ?? el.textContent ?? "").replace(/\s+/g, " ").trim();

export function buttons(root: ParentNode = document): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter(visible) as HTMLButtonElement[];
}

export function button(name: RegExp, root: ParentNode = document): HTMLButtonElement | undefined {
  return buttons(root).find((b) => name.test(nameOf(b)));
}

export function composer(root: ParentNode = document): HTMLTextAreaElement | undefined {
  return ([...root.querySelectorAll("textarea")] as HTMLTextAreaElement[]).find(visible);
}

export function text(root: ParentNode = document.body): string {
  return ((root as Element).textContent ?? "").replace(/\s+/g, " ");
}

/** The clickable element that shows `label` (a button, link, list option…). */
export function clickable(label: string, root: ParentNode = document): HTMLElement | undefined {
  const all = [
    ...root.querySelectorAll("button, a, li, [role=option], [role=button], [role=listitem]"),
  ];
  const hit = all.filter(visible).find((el) => nameOf(el).includes(label));
  return hit as HTMLElement | undefined;
}

export async function type(area: HTMLTextAreaElement, value: string) {
  area.value = value;
  area.dispatchEvent(new Event("input", { bubbles: true }));
  await tick();
}

/** Sends through the Send button when there is one, else Enter in the composer. */
export async function submit(area: HTMLTextAreaElement) {
  const send = button(/^send$/i);
  if (send) {
    send.click();
  } else {
    area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  }
  await tick();
}

export const thread = (thread_id: string, title = thread_id) => ({
  thread_id,
  title,
  project: "/home/dev/app",
  agent: "Claude Agent",
  status: "idle",
  followed: false,
});

export const snapshot = (
  thread_id: string,
  entries: Array<{ role: string; markdown: string }>,
) => ({
  v: 2,
  kind: "snapshot",
  thread: thread(thread_id),
  earlier: 0,
  entries: entries.map((e) => ({ ...e, truncated: false })),
  status: { state: "idle", message: null },
  permissions: [],
});
