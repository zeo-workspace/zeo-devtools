// The panel side of the app's postMessage bridge (story 055, design.md §A4, R3.5, R3.6).
//
// A message from the app is accepted only when all three hold:
//   1. `event.source` is the app iframe's own window — not a frame nested inside the app, not a
//      popup it opened, not the panel itself — even when those share the app's origin;
//   2. `event.origin` is exactly the app's origin — another port on the same host is another app;
//   3. `event.data` is an object `appToPanel` accepts as it is. A JSON string is not decoded:
//      the app bridge never posts one.
// `appToPanel` holds `app_location` alone, so no app message can map to `send`, `cancel`,
// `authorize`, `subscribe` or `create_thread` (R3.6): those kinds fail the schema like any
// other. Each drop is counted, and logged at debug with its reason and the count — never the
// message, whose content is the app's. The lines are bounded by a token bucket: a burst of
// `DROP_LOG_BURST`, then one line per `DROP_LOG_REFILL_MS`, so an app posting junk in a loop
// costs a handful of lines, not one per post. Nothing is lost silently: the counter counts every
// drop, and the first line after a quiet stretch carries `suppressed`, the drops not logged since
// the line before it.
// zod builds the schema below at import time: jitless first (zod-jitless.ts).
import "./zod-jitless.js";
import { appToPanel, type AppToPanel } from "../contract-v2.js";
import type { Logger } from "./transport.js";

export interface AppMessage {
  source: unknown;
  origin: string;
  data: unknown;
}

export interface ExpectedApp {
  /** The app iframe's window (`iframe.contentWindow`). */
  frame: unknown;
  /** The app's origin, as `MessageEvent.origin` writes it. */
  appOrigin: string;
}

type DropReason = "source" | "origin" | "schema";

let dropped = 0;

/** Messages dropped so far on this page. */
export const droppedAppMessages = (): number => dropped;

/** Drop lines that may be logged at once before the bucket runs dry. */
export const DROP_LOG_BURST = 32;
/** One more drop line is allowed every this many ms, up to the burst. */
export const DROP_LOG_REFILL_MS = 10_000;

let tokens = DROP_LOG_BURST;
/** When the bucket was last credited, or `null` before the first drop. */
let creditedAt: number | null = null;
/** Drops not logged since the last line. */
let suppressed = 0;

/** Credits the tokens earned since the last credit, up to the burst. */
function refill(now: number): void {
  if (creditedAt === null || now < creditedAt) {
    // First drop, or the clock went back: start counting from now.
    creditedAt = now;
    return;
  }
  const earned = Math.floor((now - creditedAt) / DROP_LOG_REFILL_MS);
  if (earned > 0) {
    tokens = Math.min(DROP_LOG_BURST, tokens + earned);
    creditedAt += earned * DROP_LOG_REFILL_MS;
  }
}

function drop(reason: DropReason, log: Pick<Logger, "debug">): null {
  dropped += 1;
  refill(Date.now());
  if (tokens === 0) {
    suppressed += 1;
    return null;
  }
  tokens -= 1;
  log.debug({
    event: "panel_app_message_dropped",
    reason,
    dropped,
    ...(suppressed > 0 ? { suppressed } : {}),
  });
  suppressed = 0;
  return null;
}

/** The app's message when it passes all three checks, else `null` (counted and logged). */
export function acceptAppMessage(
  event: AppMessage,
  expected: ExpectedApp,
  log: Pick<Logger, "debug"> = console,
): AppToPanel | null {
  if (expected.frame === null || expected.frame === undefined || event.source !== expected.frame) {
    return drop("source", log);
  }
  if (event.origin !== expected.appOrigin) {
    return drop("origin", log);
  }
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return drop("schema", log);
  }
  try {
    const parsed = appToPanel.safeParse(data);
    return parsed.success ? parsed.data : drop("schema", log);
  } catch {
    // A structured-clone value zod cannot walk is still only a bad message.
    return drop("schema", log);
  }
}
