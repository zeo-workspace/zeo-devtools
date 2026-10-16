// The app side of the panel's postMessage bridge (story 055, design.md §A4). Injected into the
// app with the picker (src/index.ts, the `/@zeo-devtools/client` module) when the devtools panel
// runs, it tells the panel where the app is: `app_location { href, title }` on load and on every
// navigation — `pushState` / `replaceState` included, which fire no event — so the panel can show
// it. That is all it ever posts: no message it sends maps to a thread action (R3.6), and each one
// is checked against the panel's own schema (`appToPanel`) before it goes.
//
// - Only when framed: an app opened on its own has no panel to tell.
// - Only to the panel: messages go to `panelOrigin`, which the plugin passes in. Without one (a
//   direct call) the target is `"/"`, postMessage's "same origin as this page" — and the panel
//   is never the app's origin (GOTCHA G13 refuses to frame it then), so such a call delivers
//   nothing. Never `*`: a site that frames the app must not learn where it is.
// - `href` over MAX_APP_HREF_BYTES, or not http(s), is not posted; `title` is cut to
//   MAX_APP_TITLE_CHARS code points (lone surrogates replaced), so every post passes the schema.
// - Navigation is noticed from `load`, `pageshow`, `popstate` and `hashchange`, and by a light
//   poll of `location.href` and `document.title` that catches History API calls and titles set
//   after a route change without wrapping the app's `history`. Only a change is posted.
// - It runs inside the app's page: it never throws into it and never logs the page's data.
import {
  appToPanel,
  MAX_APP_HREF_BYTES,
  MAX_APP_TITLE_CHARS,
  type AppToPanel,
} from "../contract-v2.js";

export interface BridgeOptions {
  /** The panel page's origin, `http://<host>:<panelPort>`; the only target of every post. */
  panelOrigin?: string;
}

/** How often the location and title are compared, in ms. */
export const BRIDGE_POLL_MS = 400;

const BRIDGE_KEY = Symbol.for("zeo-devtools.bridge");

interface Bridge {
  /** Posts the current location; with `force`, even when it did not change. */
  report(force: boolean): void;
  stop(): void;
}

type BridgeHost = typeof globalThis & { [BRIDGE_KEY]?: Bridge };

const encoder = new TextEncoder();

/** The current location as the panel accepts it, or `null` when it cannot be sent. */
export function currentLocation(): AppToPanel | null {
  const href = location.href;
  if (!/^https?:\/\//i.test(href) || encoder.encode(href).length > MAX_APP_HREF_BYTES) {
    return null;
  }
  const title = [...document.title.toWellFormed()].slice(0, MAX_APP_TITLE_CHARS).join("");
  const message: AppToPanel = { kind: "app_location", href, title };
  return appToPanel.safeParse(message).success ? message : null;
}

/** Whether this page runs inside a frame (the panel's iframe, when the bridge is wanted). */
function framed(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return false;
  }
}

/**
 * Starts reporting the app's location to the panel and answers how to stop. Starting twice
 * reports again and keeps the first bridge, so a re-run module never doubles the posts.
 */
export function startBridge(options: BridgeOptions = {}): () => void {
  try {
    const host = globalThis as BridgeHost;
    const existing = host[BRIDGE_KEY];
    if (existing !== undefined) {
      existing.report(true);
      return existing.stop;
    }
    if (!framed()) {
      return () => {};
    }
    // "/" targets the app's own origin, which the panel never has (G13): nothing is delivered.
    const target = options.panelOrigin ?? "/";
    let last = "";
    const report = (force: boolean) => {
      try {
        const message = currentLocation();
        if (message === null) {
          return;
        }
        const key = `${message.href}\n${message.title}`;
        if (!force && key === last) {
          return;
        }
        last = key;
        window.parent.postMessage(message, target);
      } catch {
        // The panel went away, or the target is not a valid origin: nothing to tell, nothing to
        // throw into the app.
      }
    };
    const onEvent = () => report(false);
    const events = ["load", "pageshow", "popstate", "hashchange"] as const;
    for (const name of events) {
      window.addEventListener(name, onEvent);
    }
    const poll = setInterval(onEvent, BRIDGE_POLL_MS);
    const stop = () => {
      clearInterval(poll);
      for (const name of events) {
        window.removeEventListener(name, onEvent);
      }
      if (host[BRIDGE_KEY] === bridge) {
        delete host[BRIDGE_KEY];
      }
    };
    const bridge: Bridge = { report, stop };
    host[BRIDGE_KEY] = bridge;
    report(true);
    return stop;
  } catch {
    return () => {};
  }
}
