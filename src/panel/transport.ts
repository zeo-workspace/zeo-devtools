// The panel page's end of the panel server's API (story 055, design.md §A1, §A3): it replaces the
// extension's native port of zeo-browser (D6). `POST /api/panels` opens a panel and answers its
// id; `GET /api/events?panel=<id>` streams named events (`event: <kind>`); `POST /api/rpc
// { panel, msg }` carries one request up and answers 204 — Zeo's answer arrives on the stream.
//
// Two kinds of `error` reach the stream's listeners and must never be confused:
//   - a relayed Zeo error is a MessageEvent named `error` with a `data` string — parsed and
//     handed to the view like any other event;
//   - the EventSource's own transport failure is a plain Event with no data — reported through
//     `onStreamError`, which is where recovery (task 6.2, design.md §A3) hooks in.
//
// `fetch` and `EventSource` are read from the global scope at call time, so a test can stub them.
// Nothing here throws: every failure is an outcome, and logs name the route and the status only —
// never a message's text, an id or a URL (R9.2).
import { z } from "zod";
import { EVENT_KINDS, type EventKind, parseEvent, type TaggedEvent } from "./wire.js";

export type Logger = Pick<Console, "debug" | "info" | "warn">;

/** What a `POST /api/rpc` came to: delivered, or why not. */
export type RpcOutcome =
  /** 204: the panel server wrote it to Zeo. */
  | "ok"
  /** 503: the panel's Zeo session is not open; nothing was queued (R6.8). */
  | "unreachable"
  /** 404: the panel server no longer knows this panel (a restart, R6.9). */
  | "unknown_panel"
  /** Any other status: the request itself was refused (400, 403, 413, 415). */
  | "refused"
  /** The request never got an answer: the dev server is gone. */
  | "network";

/** What `POST /api/panels` came to. */
export type OpenOutcome =
  { ok: true; panel: string } | { ok: false; status: number; error: string };

export interface TransportHandlers {
  /** One parsed event of the current stream. */
  onEvent(event: TaggedEvent): void;
  /** The current stream is open (the browser's `open`, not Zeo's state). */
  onStreamOpen(): void;
  /** The current stream failed; `closed` when the browser will not retry it by itself. */
  onStreamError(closed: boolean): void;
}

/** A panel request without the `v`/`id` envelope the server may add; see `panelClientMsg`. */
export type PanelRequest = Record<string, unknown> & { kind: string };

const panelsAnswer = z.object({ panel: z.string().min(1).max(64) });
const errorAnswer = z.object({ error: z.string().max(64) });

const JSON_HEADERS = { "Content-Type": "application/json" };

/** The browser's own EventSource `readyState` values, without assuming the global exists. */
const ES_OPEN = 1;
const ES_CLOSED = 2;

export class PanelTransport {
  private readonly handlers: TransportHandlers;
  private readonly log: Logger;
  private panelId: string | null = null;
  private es: EventSource | null = null;

  constructor(handlers: TransportHandlers, log: Logger) {
    this.handlers = handlers;
    this.log = log;
  }

  /** The current panel's id, or `null` before `open` succeeds. */
  get panel(): string | null {
    return this.panelId;
  }

  /**
   * Opens a fresh panel and its event stream, closing any previous stream first. The stream's
   * events go to the handlers from then on; a stale stream's never do.
   */
  async open(): Promise<OpenOutcome> {
    this.closeStream();
    this.panelId = null;
    let res: Response;
    try {
      res = await globalThis.fetch("/api/panels", {
        method: "POST",
        headers: JSON_HEADERS,
        body: "{}",
      });
    } catch (err) {
      this.log.warn({ event: "panel_open_failed", reason: "network", error: errorName(err) });
      return { ok: false, status: 0, error: "network" };
    }
    const body = await readJson(res);
    if (!res.ok) {
      const parsed = errorAnswer.safeParse(body);
      const error = parsed.success ? parsed.data.error : "unknown";
      this.log.warn({ event: "panel_open_failed", status: res.status, error });
      return { ok: false, status: res.status, error };
    }
    const parsed = panelsAnswer.safeParse(body);
    if (!parsed.success) {
      this.log.warn({ event: "panel_open_failed", status: res.status, error: "bad_answer" });
      return { ok: false, status: res.status, error: "bad_answer" };
    }
    this.panelId = parsed.data.panel;
    this.openStream(parsed.data.panel);
    return { ok: true, panel: parsed.data.panel };
  }

  /** Posts one request for the current panel; Zeo's answer, if any, arrives on the stream. */
  async rpc(msg: PanelRequest): Promise<RpcOutcome> {
    const panel = this.panelId;
    if (panel === null) {
      return "unknown_panel";
    }
    let res: Response;
    try {
      res = await globalThis.fetch("/api/rpc", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ panel, msg }),
      });
    } catch (err) {
      this.log.warn({ event: "panel_rpc_failed", kind: msg.kind, error: errorName(err) });
      return "network";
    }
    if (res.ok) {
      return "ok";
    }
    this.log.warn({ event: "panel_rpc_failed", kind: msg.kind, status: res.status });
    if (res.status === 503) {
      return "unreachable";
    }
    if (res.status === 404) {
      return "unknown_panel";
    }
    return "refused";
  }

  /** Closes the stream for good; the server then closes the panel's Zeo session. */
  close(): void {
    this.closeStream();
    this.panelId = null;
  }

  private closeStream(): void {
    const es = this.es;
    this.es = null;
    es?.close();
  }

  private openStream(panel: string): void {
    let es: EventSource;
    try {
      es = new globalThis.EventSource(`/api/events?panel=${encodeURIComponent(panel)}`);
    } catch (err) {
      this.log.warn({ event: "panel_stream_failed", error: errorName(err) });
      queueMicrotask(() => this.handlers.onStreamError(true));
      return;
    }
    this.es = es;
    const current = () => this.es === es;
    // The browser's own `open` only. A server event named `open` would be dispatched with the
    // same type — reaching `onopen` and any `open` listener while `readyState` is already OPEN —
    // so the signal is: no `data` (a server event always has it), the stream OPEN, and the first
    // time only (this page closes a stream on any error, so a real second open never happens).
    // The panel server never relays an `open`; this does not rely on it.
    let opened = false;
    es.onopen = (e) => {
      if (
        !current() ||
        opened ||
        es.readyState !== ES_OPEN ||
        typeof (e as Partial<MessageEvent>).data === "string"
      ) {
        return;
      }
      opened = true;
      this.handlers.onStreamOpen();
    };
    for (const kind of EVENT_KINDS) {
      if (kind === "error") {
        continue;
      }
      es.addEventListener(kind, (e) => {
        if (current()) {
          this.deliver(kind, e);
        }
      });
    }
    es.addEventListener("error", (e) => {
      if (!current()) {
        return;
      }
      // A relayed Zeo error carries data; the browser's own failure is a bare Event.
      if (typeof (e as Partial<MessageEvent>).data === "string") {
        this.deliver("error", e);
        return;
      }
      const closed = es.readyState === ES_CLOSED;
      this.log.warn({ event: "panel_stream_error", closed });
      this.handlers.onStreamError(closed);
    });
  }

  private deliver(kind: EventKind, e: Event): void {
    const data = (e as Partial<MessageEvent>).data;
    if (typeof data !== "string") {
      this.log.warn({ event: "panel_event_dropped", kind, reason: "no_data" });
      return;
    }
    const parsed = parseEvent(kind, data);
    if (!parsed.ok) {
      this.log.warn({ event: "panel_event_dropped", kind, reason: parsed.reason });
      return;
    }
    try {
      this.handlers.onEvent(parsed.event);
    } catch (err) {
      // A view bug must not stop the stream's other events.
      this.log.warn({ event: "panel_event_failed", kind, error: errorName(err) });
    }
  }
}

/** The JSON body of an answer, or `undefined` when it has none or it is not JSON. */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

/** An error's class name for a log line; never its message, which may quote content. */
export const errorName = (err: unknown): string => (err instanceof Error ? err.name : typeof err);
