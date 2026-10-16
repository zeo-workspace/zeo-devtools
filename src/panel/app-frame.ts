// The app pane (story 055, design.md §A3 "Iframe", §A4, R3.2, GOTCHA G13): the app in a sandboxed
// iframe beside the thread, and a strip above it saying where the app is.
//
// - The app's URL comes from `GET /api/config` (`app_url`), checked with the same raw-string rule
//   Zeo applies (`isLocalHttpUrl`); until it answers, the pane says it is waiting, and a failed
//   read is retried on the link's backoff schedule.
// - G13: the iframe carries `allow-scripts` and `allow-same-origin`, which let a same-origin
//   frame lift its own sandbox. That is safe only because the app's origin is not the panel's
//   (D2), so the two are compared first; if they are equal the pane shows an error and no iframe
//   is created.
// - Sandbox (R3.2): scripts, same-origin, forms, popups, modals and downloads; never
//   `allow-top-navigation`, so the app cannot navigate the panel away.
// - The app tells the panel its location through `app_location` (src/client/bridge.ts); each
//   message passes `acceptAppMessage` (app-bridge.ts) or is dropped. Nothing the app sends
//   reaches the thread (R3.6). Reloading the app is the dev server's HMR, never the panel (R6.7).
// zod builds the schema below at import time: jitless first (zod-jitless.ts).
import "./zod-jitless.js";
import { z } from "zod";
import { isLocalHttpUrl } from "../contract-v2.js";
import { acceptAppMessage } from "./app-bridge.js";
import { retryDelay } from "./link.js";
import { TEXT } from "./text.js";
import { errorName, type Logger } from "./transport.js";

/** The iframe's sandbox tokens (R3.2): no `allow-top-navigation` of any kind. */
export const APP_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

const configAnswer = z.object({
  app_url: z.string().refine(isLocalHttpUrl, { message: "app_url is not a local http URL" }),
  root: z.string(),
});

/** The app's URL from the panel server, or `null` when it cannot be read now. */
async function readAppUrl(log: Logger): Promise<string | null> {
  try {
    const res = await globalThis.fetch("/api/config");
    if (!res.ok) {
      log.warn({ event: "panel_config_failed", status: res.status });
      return null;
    }
    const parsed = configAnswer.safeParse(await res.json());
    if (!parsed.success) {
      log.warn({ event: "panel_config_failed", reason: "bad_answer" });
      return null;
    }
    return parsed.data.app_url;
  } catch (err) {
    log.warn({ event: "panel_config_failed", error: errorName(err) });
    return null;
  }
}

export interface AppFrame {
  /** The iframe, once created; `null` while waiting or when G13 refused it. */
  frame(): HTMLIFrameElement | null;
}

/**
 * Fills `pane` with the app: a location strip and the sandboxed iframe, once `/api/config`
 * answers and the app's origin is not `pageOrigin`.
 */
export function mountAppFrame(
  pane: HTMLElement,
  deps: { log: Logger; pageOrigin: string },
): AppFrame {
  const doc = pane.ownerDocument;
  const win = doc.defaultView;
  const { log, pageOrigin } = deps;

  const bar = doc.createElement("div");
  bar.className = "app-bar";
  const titleEl = doc.createElement("span");
  titleEl.className = "app-title";
  const hrefEl = doc.createElement("span");
  hrefEl.className = "app-href";
  bar.append(titleEl, hrefEl);
  bar.hidden = true;

  const notice = doc.createElement("p");
  notice.className = "app-placeholder";
  notice.textContent = TEXT.appWaiting;
  pane.replaceChildren(bar, notice);

  let frame: HTMLIFrameElement | null = null;
  let appOrigin = "";

  const showLocation = (href: string, title: string) => {
    bar.hidden = false;
    titleEl.textContent = title;
    hrefEl.textContent = href;
  };

  // Before the iframe exists no message can be the app's: `frame: null` drops (and counts) it.
  win?.addEventListener("message", (event) => {
    const message = acceptAppMessage(event, { frame: frame?.contentWindow, appOrigin }, log);
    if (message !== null) {
      showLocation(message.href, message.title);
    }
  });

  const create = (appUrl: string) => {
    appOrigin = new URL(appUrl).origin;
    if (appOrigin === pageOrigin) {
      // G13: same origin, and allow-same-origin + allow-scripts would let the app lift the
      // sandbox and reach the panel. No iframe.
      log.warn({ event: "panel_app_refused", reason: "same_origin" });
      notice.textContent = TEXT.appSameOrigin;
      notice.dataset.tone = "error";
      return;
    }
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("sandbox", APP_SANDBOX);
    iframe.title = TEXT.appFrameTitle;
    iframe.src = appUrl;
    frame = iframe;
    showLocation(appUrl, "");
    notice.remove();
    pane.append(iframe);
  };

  let tries = 0;
  const load = async () => {
    const appUrl = await readAppUrl(log);
    if (appUrl !== null) {
      create(appUrl);
      return;
    }
    notice.textContent = TEXT.appUnavailable;
    tries += 1;
    setTimeout(() => void load(), retryDelay(tries));
  };
  void load();

  return { frame: () => frame };
}
