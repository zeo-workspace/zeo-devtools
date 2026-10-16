// The panel page's entry (story 055, design.md §A3): bundled by scripts/build-panel.mjs into
// dist/panel/assets/main.js and loaded by dist/panel/index.html as an external module script —
// the page's CSP allows no inline script, no inline style and no eval.
//
// It mounts on import into `#app`: the workbench (thread panel left, app right, a divider between
// them), the app's sandboxed iframe, the thread view, and one panel on the panel server, whose
// event stream drives the view.
// The first import turns zod's JIT off before any schema exists (see zod-jitless.ts).
import "./zod-jitless.js";
import { mountAppFrame } from "./app-frame.js";
import { takeBinding } from "./binding.js";
import { mountWorkbench } from "./layout.js";
import { PanelLink } from "./link.js";
import { TEXT } from "./text.js";
import { errorName, type Logger } from "./transport.js";
import { PanelView } from "./view.js";

const log: Logger = console;

function mount(root: HTMLElement): void {
  const { panel, app } = mountWorkbench(root);
  mountAppFrame(app, { log, pageOrigin: window.location.origin });

  const storage = window.sessionStorage;
  const boundThread = takeBinding(window, storage);
  let view: PanelView | null = null;
  const link = new PanelLink(
    {
      onEvent: (event) => view?.onEvent(event),
      onReady: () => view?.onReady(),
      onDown: (reason) => view?.onDown(reason),
    },
    log,
  );
  view = new PanelView(panel, boundThread, {
    rpc: (msg) => link.rpc(msg),
    reconnect: () => link.lost("thread_end"),
    connectionOpen: () => link.connectionOpen(),
    storage,
    log,
  });

  // The page going away closes its stream, and with it the panel's Zeo session (GOTCHA G4); a
  // page restored from the back/forward cache opens a fresh panel.
  window.addEventListener("pagehide", () => link.close());
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      link.resume();
    }
  });
  link.start();
}

/**
 * Whether another page opened this one (`window.open`). Zeo opens the panel with no opener
 * (Chromium `--app=<url>`, or the desktop's URL handler), while the framed app can open a popup
 * (`allow-popups`) — which would mount a second panel, take a live-panel slot, hold its own Zeo
 * session, and stay steerable by its opener. Such a page refuses to mount. Not COOP: that would
 * also cut the app's own popups (an OAuth sign-in, say).
 */
function openedByAnotherPage(): boolean {
  try {
    return window.opener !== null && window.opener !== undefined;
  } catch {
    // An opener that cannot even be read is still an opener.
    return true;
  }
}

const root = document.getElementById("app");
if (root === null) {
  log.warn({ event: "panel_root_missing" });
} else if (openedByAnotherPage()) {
  log.warn({ event: "panel_refused", reason: "opener" });
  const notice = document.createElement("p");
  notice.className = "refused";
  notice.setAttribute("role", "alert");
  notice.textContent = TEXT.openedByPage;
  root.replaceChildren(notice);
} else {
  try {
    mount(root);
  } catch (err) {
    log.warn({ event: "panel_mount_failed", error: errorName(err) });
  }
}
