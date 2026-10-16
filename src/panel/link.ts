// The panel page's link to the panel server, kept alive across a dev-server restart (story 055,
// design.md §A3 "Recovery", R6.9). It owns the transport and re-creates the panel whenever it is
// lost:
//   - the event stream failed (EventSource's own error — a plain Event; a relayed Zeo `error` is a
//     MessageEvent and never gets here, see transport.ts). A panel's id dies with its stream, since
//     the server closes the panel when the stream closes, and EventSource never retries a non-200;
//   - `POST /api/rpc` answered 404: the server no longer knows the panel;
//   - the view asks for it (a bound thread's stream ended twice, design.md §B3 Retention).
//
// Attempts are spaced 1, 2, 4, 8, 16 s, then every 30 s, from the second attempt of a run; the
// page's very first attempt is immediate. The count resets only once a panel has held an open Zeo
// session for `STABLE_MS`, so a panel that opens and is ended at once (a fatal error, a thread
// that keeps closing) backs off instead of looping. A refusal of `POST /api/panels` names its
// reason: `too_many_panels` (the server's cap of live panels) is not "Zeo is unreachable".
//
// A lost stream may mean the panel server itself is gone (design.md §A3 "Own server gone (v3)",
// R3.8, R3.9): Zeo stops a dev server it started with a signal, and a killed process sends
// nothing. So a lost stream probes the page's own origin (`GET /api/config`, uncached, 2 s): no
// answer — a network error or the timeout — is `server_stopped`; any answer, an error status
// included, keeps `unreachable`. Re-creation keeps its backoff either way, and while the server is
// known stopped a re-creation that cannot reach it keeps saying so.
import {
  errorName,
  type Logger,
  type PanelRequest,
  PanelTransport,
  type RpcOutcome,
} from "./transport.js";
import type { TaggedEvent } from "./wire.js";

/** Delay before each re-creation after the first, in order; the last one repeats (R6.9). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
/** How long a panel's Zeo session must stay open before the backoff starts over. */
export const STABLE_MS = 10_000;
/** How long the origin probe of a lost stream waits for an answer before calling it stopped. */
export const PROBE_TIMEOUT_MS = 2000;

/** Why there is no usable panel right now. */
export type LinkDown = "unreachable" | "too_many_panels" | "server_stopped";

export interface LinkHandlers {
  onEvent(event: TaggedEvent): void;
  /** A panel exists and its stream is open: (re-)bind or list from here. */
  onReady(): void;
  /** There is no usable panel; the link is re-creating one. */
  onDown(reason: LinkDown): void;
}

/** The delay before attempt number `tries` (0-based) of a run. */
export const retryDelay = (tries: number): number =>
  tries === 0 ? 0 : RETRY_DELAYS_MS[Math.min(tries - 1, RETRY_DELAYS_MS.length - 1)]!;

export class PanelLink {
  private readonly handlers: LinkHandlers;
  private readonly log: Logger;
  private readonly transport: PanelTransport;
  /** Attempts since the last stable panel. */
  private tries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private attempting = false;
  private closed = false;
  /** The down state last reported, or `null` while a panel's stream is open. */
  private down: LinkDown | null = null;
  /** The origin probe in flight, if any. */
  private probe: { controller: AbortController; timer: ReturnType<typeof setTimeout> } | null =
    null;

  constructor(handlers: LinkHandlers, log: Logger) {
    this.handlers = handlers;
    this.log = log;
    this.transport = new PanelTransport(
      {
        onEvent: (event) => handlers.onEvent(event),
        onStreamOpen: () => {
          // A panel is up: whatever an in-flight probe answers no longer matters.
          this.cancelProbe();
          this.down = null;
          handlers.onReady();
        },
        onStreamError: () => this.lost("stream"),
      },
      log,
    );
  }

  /** Opens the first panel now. */
  start(): void {
    void this.attempt();
  }

  /** Posts one request on the current panel; a 404 means the panel is gone, and is recovered. */
  async rpc(msg: PanelRequest): Promise<RpcOutcome> {
    const panel = this.transport.panel;
    const outcome = await this.transport.rpc(msg);
    // Only for the panel the request went to: during a recovery there is none, and a late 404
    // from an old panel must not tear down the new one.
    if (outcome === "unknown_panel" && panel !== null && this.transport.panel === panel) {
      this.lost("unknown_panel");
    }
    return outcome;
  }

  /**
   * Drops the current panel and re-creates it on the backoff schedule. Several losses in a row
   * cost one attempt: a pending or running attempt absorbs the rest.
   */
  lost(cause: "stream" | "unknown_panel" | "thread_end"): void {
    if (this.closed) {
      return;
    }
    this.log.info({ event: "panel_lost", cause, tries: this.tries });
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.cancelProbe();
    this.transport.close();
    this.setDown("unreachable");
    if (cause === "stream") {
      this.probeOrigin();
    }
    this.schedule();
  }

  /** Zeo's session of the current panel is open; after `STABLE_MS` of that, backoff resets. */
  connectionOpen(): void {
    clearTimeout(this.stableTimer);
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.tries = 0;
    }, STABLE_MS);
  }

  /**
   * Opens a fresh panel after `close`: the page came back from the back/forward cache, and its
   * old panel died with the stream `close` ended.
   */
  resume(): void {
    if (!this.closed) {
      return;
    }
    this.closed = false;
    this.tries = 0;
    this.setDown("unreachable");
    void this.attempt();
  }

  /** Ends the link: no stream, no further attempt and no probe, until `resume`. */
  close(): void {
    this.closed = true;
    this.cancelProbe();
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.stableTimer);
    this.stableTimer = undefined;
    this.transport.close();
  }

  private schedule(): void {
    if (this.closed || this.attempting || this.timer !== undefined) {
      return;
    }
    const delay = retryDelay(this.tries);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.attempt();
    }, delay);
  }

  private async attempt(): Promise<void> {
    if (this.closed || this.attempting) {
      return;
    }
    this.attempting = true;
    this.tries += 1;
    let opened: Awaited<ReturnType<PanelTransport["open"]>>;
    try {
      opened = await this.transport.open();
    } catch (err) {
      // `open` answers its failures; this is a defect, and still only a failed attempt.
      this.log.warn({ event: "panel_open_failed", reason: "internal", error: errorName(err) });
      opened = { ok: false, status: 0, error: "internal" };
    } finally {
      this.attempting = false;
    }
    if (this.closed) {
      this.transport.close();
      return;
    }
    if (!opened.ok) {
      this.setDown(downAfterFailedOpen(opened.error, this.down));
      this.schedule();
    }
    // On success the stream's own `open` calls `onReady`, and its failure calls `lost`.
  }

  private setDown(reason: LinkDown): void {
    this.down = reason;
    this.handlers.onDown(reason);
  }

  /**
   * Asks the page's own origin whether it still answers, once per lost stream. Only a probe that
   * is still current when it settles applies: `close`, a newer loss and an opened stream all
   * cancel it, so a page in the back/forward cache never probes and a late answer never
   * overrides a panel that came back.
   */
  private probeOrigin(): void {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const probe = { controller, timer };
    this.probe = probe;
    void originAnswers(controller.signal).then((answered) => {
      if (this.probe !== probe) {
        return;
      }
      this.probe = null;
      clearTimeout(timer);
      this.log.info({ event: "panel_origin_probe", answered });
      if (!answered) {
        this.setDown("server_stopped");
      }
    });
  }

  private cancelProbe(): void {
    const probe = this.probe;
    this.probe = null;
    if (probe !== null) {
      clearTimeout(probe.timer);
      probe.controller.abort();
    }
  }
}

/**
 * The down state after `POST /api/panels` failed. A network failure while the server is already
 * known stopped is more of the same; anything else is today's `unreachable`, except the cap.
 */
function downAfterFailedOpen(error: string, current: LinkDown | null): LinkDown {
  if (error === "too_many_panels") {
    return "too_many_panels";
  }
  return error === "network" && current === "server_stopped" ? "server_stopped" : "unreachable";
}

/**
 * Whether the panel server answers `GET /api/config` at all. Any HTTP status is an answer — a 503
 * still means the server is up (R3.9); only a network error or an abort (the timeout) is not.
 */
async function originAnswers(signal: AbortSignal): Promise<boolean> {
  let res: Response;
  try {
    res = await globalThis.fetch("/api/config", { cache: "no-store", signal });
  } catch {
    return false;
  }
  // Nothing in the body is needed; release the connection.
  void res.body?.cancel().catch(() => undefined);
  return true;
}
