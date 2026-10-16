// The page's two panes and the divider between them (story 055, design.md §A3): the thread panel
// on the left, the app on the right. The divider is a focusable `role="separator"` with a value,
// moved by pointer drag or by the keyboard (arrows by 2 %, Page keys by 10 %, Home and End to the
// limits), as the WAI-ARIA window-splitter pattern describes. It sits inside the thread's `main`
// landmark, beside the thread itself, so no content of the page lies outside a landmark.
//
// The width is the CSS custom property `--panel-size` on the workbench, set through the CSSOM
// (`style.setProperty`). The page's CSP has no 'unsafe-inline' for styles, which refuses a `style`
// attribute in markup or through `setAttribute`, but not the CSSOM. Nothing is stored: the page
// keeps no state beyond `sessionStorage.boundThread` (design.md §A3).

/** The panel's share of the workbench, in percent. */
export const PANEL_MIN = 22;
export const PANEL_MAX = 70;
export const PANEL_DEFAULT = 36;
const STEP = 2;
const PAGE_STEP = 10;

export interface Workbench {
  /** Where the thread view mounts, inside the left pane (the divider is that pane's too). */
  panel: HTMLElement;
  /** The right pane, where the app's iframe goes (task 6.3). */
  app: HTMLElement;
  divider: HTMLElement;
}

const clamp = (v: number) => Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(v)));

/** Builds the workbench inside `root` (the page's `#app`) and wires its divider. */
export function mountWorkbench(root: HTMLElement): Workbench {
  const doc = root.ownerDocument;
  root.classList.add("workbench");

  // The thread is the page's main content; the app is a labelled region beside it. The view
  // replaces the children of `panel`, so the divider lives beside it, not in it.
  const pane = doc.createElement("main");
  pane.className = "pane pane-thread";
  pane.id = "zeo-thread-pane";
  pane.setAttribute("aria-label", "Agent thread");
  const panel = doc.createElement("div");
  panel.className = "thread";

  const divider = doc.createElement("div");
  divider.className = "divider";
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-controls", pane.id);
  divider.setAttribute("aria-label", "Resize the thread panel");
  divider.setAttribute("aria-valuemin", String(PANEL_MIN));
  divider.setAttribute("aria-valuemax", String(PANEL_MAX));
  const grip = doc.createElement("span");
  grip.className = "divider-grip";
  grip.setAttribute("aria-hidden", "true");
  divider.append(grip);

  const app = doc.createElement("section");
  app.className = "pane pane-app";
  app.setAttribute("aria-label", "App");

  pane.append(panel, divider);
  root.replaceChildren(pane, app);

  let size = PANEL_DEFAULT;
  const apply = (next: number) => {
    size = clamp(next);
    root.style.setProperty("--panel-size", `${size}%`);
    divider.setAttribute("aria-valuenow", String(size));
    divider.setAttribute("aria-valuetext", `Thread panel ${size}% wide`);
  };
  apply(PANEL_DEFAULT);

  divider.addEventListener("keydown", (e) => {
    const moves: Record<string, number> = {
      ArrowLeft: size - STEP,
      ArrowRight: size + STEP,
      PageDown: size - PAGE_STEP,
      PageUp: size + PAGE_STEP,
      Home: PANEL_MIN,
      End: PANEL_MAX,
    };
    const next = moves[e.key];
    if (next !== undefined) {
      e.preventDefault();
      apply(next);
    }
  });

  // Dragging: the pointer is captured by the divider, and the iframe stops taking pointer events
  // while `is-resizing` is set, so a fast drag over the app is not lost to it.
  const toPercent = (clientX: number) => {
    const box = root.getBoundingClientRect();
    return box.width > 0 ? ((clientX - box.left) / box.width) * 100 : size;
  };
  divider.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) {
      return;
    }
    e.preventDefault();
    divider.setPointerCapture?.(e.pointerId);
    root.classList.add("is-resizing");
    divider.focus();
  });
  divider.addEventListener("pointermove", (e) => {
    if (root.classList.contains("is-resizing")) {
      apply(toPercent(e.clientX));
    }
  });
  const stop = (e: PointerEvent) => {
    root.classList.remove("is-resizing");
    if (divider.hasPointerCapture?.(e.pointerId)) {
      divider.releasePointerCapture(e.pointerId);
    }
  };
  divider.addEventListener("pointerup", stop);
  divider.addEventListener("pointercancel", stop);

  return { panel, app, divider };
}
