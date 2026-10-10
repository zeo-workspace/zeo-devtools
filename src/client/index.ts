/// <reference types="vite/client" />
// The in-page element picker (story 033, design.md §A2). Served by the relay plugin and
// started with the plugin's options. Everything it draws lives in one closed shadow root, so
// the page's CSS cannot reach it and its CSS cannot reach the page (R2.7).
import type { DevtoolsResult, SelectionFromPage } from "../contract.js";
import { TabCapture, type CaptureFailure, type Rect } from "./capture.js";
import { createSelection } from "./selection.js";
import { summarize } from "./summary.js";

export interface ClientOptions {
  shortcut?: string;
  screenshot?: boolean;
}

const SRC_ATTR = "data-zeo-src";
const COMPONENT_ATTR = "data-zeo-c";
const TOAST_MS = 4000;
/** Longer than the relay's 10 s deadline: past it, the next queued send goes anyway. */
const RESULT_WAIT_MS = 12_000;
const PAGE_URL_MAX = 2048;
const DRAG_THRESHOLD_PX = 5;

const NO_SOURCE = "This element has no source in this project";
const LIMIT = "Selection limit reached: 20 elements";
const CAPTURE_REASONS: Record<CaptureFailure | "grab_failed", string> = {
  refused: "screen sharing was refused",
  unsupported: "this browser cannot capture the page",
  not_this_tab: "share this tab, not a window or screen, to include one",
  grab_failed: "the frame could not be captured",
};

type Corner = `${"top" | "bottom"}-${"left" | "right"}`;

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  font: 12px/1.4 system-ui, sans-serif; color: #f5f5f5; }
.button, .send, .stop { pointer-events: auto; border: 0; border-radius: 6px; cursor: pointer;
  font: inherit; padding: 6px 10px; background: #1f2937; color: #f5f5f5;
  box-shadow: 0 2px 8px rgba(0,0,0,.35); }
.button { position: fixed; touch-action: none; user-select: none; }
.button[aria-pressed="true"] { background: #2563eb; }
.bar { position: fixed; display: flex; gap: 6px; pointer-events: none; }
.send { background: #2563eb; }
.stop { background: #b91c1c; }
.highlight { position: fixed; border: 2px solid #2563eb; background: rgba(37,99,235,.12);
  border-radius: 2px; display: none; }
.picked { position: fixed; border: 2px dashed #f59e0b; border-radius: 2px; }
.tip { position: fixed; display: none; background: #111827; padding: 3px 6px; border-radius: 4px;
  white-space: nowrap; }
.toast { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); display: none;
  background: #111827; padding: 8px 12px; border-radius: 6px; max-width: 80vw; }
[hidden] { display: none !important; }
`;

function parseShortcut(spec: string) {
  const parts = spec.split("+").map((p) => p.trim().toLowerCase());
  const key = parts.pop() ?? "z";
  return {
    alt: parts.includes("alt"),
    shift: parts.includes("shift"),
    ctrl: parts.includes("ctrl") || parts.includes("control"),
    meta: parts.includes("meta") || parts.includes("cmd"),
    key,
  };
}

const SOURCE_PATTERN = /^(.*):(\d+):(\d+)-(\d+)$/;

/** `src/App.tsx:12:7-14` → the page form of an item's `src`. */
function parseSource(value: string): SelectionFromPage["items"][number]["src"] | undefined {
  const match = value.match(SOURCE_PATTERN);
  if (match === null) {
    return undefined;
  }
  const src = {
    file: match[1]!,
    line: Number(match[2]),
    column: Number(match[3]),
    end_line: Number(match[4]),
  };
  // A hand-written attribute is not re-tagged: refuse what the contract would refuse, so one
  // bad element cannot fail a whole multi-element send.
  const valid =
    src.file !== "" &&
    !src.file.startsWith("/") &&
    src.line >= 1 &&
    src.column >= 1 &&
    src.end_line >= 1;
  return valid ? src : undefined;
}

const tagged = (event: Event): Element | undefined =>
  event
    .composedPath()
    .find((node): node is Element => node instanceof Element && node.hasAttribute(SRC_ATTR));

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: Node,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent.appendChild(node);
  return node;
}

function place(node: HTMLElement, rect: DOMRect) {
  node.style.left = `${rect.left}px`;
  node.style.top = `${rect.top}px`;
  node.style.width = `${rect.width}px`;
  node.style.height = `${rect.height}px`;
}

/** The page URL without its query and fragment, cut to the contract's 2048 characters. */
const pageUrl = () => [...`${location.origin}${location.pathname}`].slice(0, PAGE_URL_MAX).join("");

export function mount(options: ClientOptions = {}): void {
  const hot = import.meta.hot;
  if (hot === undefined || document.documentElement.hasAttribute("data-zeo-devtools")) {
    return;
  }
  document.documentElement.setAttribute("data-zeo-devtools", "");
  // Every listener below is removed with this signal when Vite replaces the module.
  const lifetime = new AbortController();
  const { signal } = lifetime;
  const shortcut = parseShortcut(options.shortcut ?? "Alt+Shift+Z");
  const screenshots = options.screenshot !== false;
  const selection = createSelection();
  const capture = new TabCapture();

  const host = document.createElement("div");
  const root = host.attachShadow({ mode: "closed" });
  el("style", "", root).textContent = STYLE;
  const layer = el("div", "layer", root);
  const highlight = el("div", "highlight", layer);
  const marks = el("div", "", layer);
  const tip = el("div", "tip", layer);
  const toast = el("div", "toast", layer);
  toast.setAttribute("role", "status");
  const button = el("button", "button", layer);
  button.type = "button";
  button.textContent = "Zeo";
  button.setAttribute("aria-label", "Zeo picker");
  button.setAttribute("aria-pressed", "false");
  const bar = el("div", "bar", layer);
  const send = el("button", "send", bar);
  send.type = "button";
  send.hidden = true;
  const stop = el("button", "stop", bar);
  stop.type = "button";
  stop.textContent = "Stop sharing";
  stop.hidden = true;
  document.documentElement.appendChild(host);

  let corner: Corner = "bottom-right";
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  // Sends go one at a time, so each answer is paired with the send it answers.
  let queue: Promise<void> = Promise.resolve();
  let awaitingResult: ((result: DevtoolsResult | undefined) => void) | undefined;
  // Answers still owed to sends that timed out: discarded on arrival, never paired with the
  // next send.
  let lateAnswers = 0;
  capture.onEnded = () => render();

  const dock = () => {
    const [v, h] = corner.split("-") as ["top" | "bottom", "left" | "right"];
    for (const node of [button, bar]) {
      node.style.top = node.style.bottom = node.style.left = node.style.right = "";
      node.style[h] = "16px";
    }
    button.style[v] = "16px";
    bar.style[v] = "56px";
  };

  const say = (message: string) => {
    toast.textContent = message;
    toast.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.style.display = "none"), TOAST_MS);
  };

  const render = () => {
    const state = selection.state;
    button.setAttribute("aria-pressed", String(state.mode === "picking"));
    const pending = state.mode === "picking" ? state.pending : [];
    send.hidden = pending.length === 0;
    // The count is its own token, "(2)", so it reads as a number next to any other control.
    send.textContent = `Send (${pending.length})`;
    stop.hidden = !capture.isLive;
    marks.replaceChildren();
    for (const node of pending) {
      place(el("div", "picked", marks), node.getBoundingClientRect());
    }
    if (state.mode === "off") {
      highlight.style.display = "none";
      tip.style.display = "none";
    }
  };

  const hideOverlay = (hidden: boolean) => {
    host.style.visibility = hidden ? "hidden" : "";
  };

  /** Starts the share prompt now, inside the gesture, when a screenshot is wanted and absent. */
  const prepareCapture = () =>
    screenshots && !capture.isLive ? capture.start() : Promise.resolve({ ok: true as const });

  /** Shows Zeo's answer to one send; `missing` says why that send had no image. */
  const announce = (result: DevtoolsResult | undefined, missing: string | undefined) => {
    if (result === undefined) {
      say("Zeo did not answer this selection");
    } else if (!result.ok) {
      say(result.message);
    } else if (missing !== undefined) {
      say(`Sent to Zeo without an image: ${missing}`);
    } else if (result.image === "skipped_unsupported") {
      say("Sent without image: this agent does not accept images");
    } else if (result.image === "pending") {
      say("Sent; the image depends on the new thread's agent");
    } else {
      say("Sent to Zeo");
    }
  };

  const deliver = async (elements: Element[], started: ReturnType<typeof prepareCapture>) => {
    const items: SelectionFromPage["items"] = [];
    for (const node of elements) {
      const src = parseSource(node.getAttribute(SRC_ATTR) ?? "");
      if (src !== undefined) {
        items.push({
          src,
          component: node.getAttribute(COMPONENT_ATTR),
          dom: summarize(node, window),
        });
      }
    }
    if (items.length === 0) {
      say(NO_SOURCE);
      return;
    }
    let screenshot: SelectionFromPage["screenshot"] = null;
    let missing: string | undefined;
    if (screenshots) {
      const start = await started;
      render();
      if (!start.ok) {
        missing = CAPTURE_REASONS[start.reason];
      } else {
        const picked = elements.filter((node) => node.isConnected);
        const rects = (): Rect[] =>
          picked.map((node) => {
            const r = node.getBoundingClientRect();
            return { x: r.x, y: r.y, w: r.width, h: r.height };
          });
        const grabbed = await capture.grab(rects, hideOverlay);
        if (grabbed.ok) {
          const data_b64 = await toBase64(grabbed.png);
          screenshot = { mime: "image/png", data_b64, w: grabbed.w, h: grabbed.h };
        } else {
          missing = CAPTURE_REASONS.grab_failed;
        }
      }
    }
    const payload: SelectionFromPage = { v: 1, page_url: pageUrl(), items, screenshot };
    const answered = new Promise<DevtoolsResult | undefined>((resolve) => {
      const timer = setTimeout(() => {
        lateAnswers += 1;
        resolve(undefined);
      }, RESULT_WAIT_MS);
      awaitingResult = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
    });
    hot.send("zeo:select", payload);
    const result = await answered;
    awaitingResult = undefined;
    announce(result, missing);
  };

  /** Queues a send behind the previous one; the capture prompt has already been started. */
  const enqueue = (elements: Element[], started: ReturnType<typeof prepareCapture>) => {
    queue = queue
      .then(() => deliver(elements, started))
      .catch((error: unknown) => {
        say(`Could not send the selection: ${error instanceof Error ? error.message : "error"}`);
      });
  };

  const onResult = (result: DevtoolsResult) => {
    if (lateAnswers > 0) {
      lateAnswers -= 1;
      return;
    }
    awaitingResult?.(result);
  };
  hot.on("zeo:result", onResult);

  const ours = (event: Event) => event.composedPath().includes(host);

  // Picking clicks never reach the page's own handlers (R3.7): capture phase on window.
  const swallow = (event: Event) => {
    if (selection.state.mode === "picking" && !ours(event)) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    }
  };
  for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "dblclick"]) {
    window.addEventListener(type, swallow, { capture: true, signal });
  }

  window.addEventListener(
    "click",
    (event) => {
      if (selection.state.mode !== "picking" || ours(event)) {
        return;
      }
      swallow(event);
      if (event.detail === 0) {
        // Enter or Space on a focused page control: not a pick.
        return;
      }
      const target = tagged(event);
      if (target === undefined) {
        say(NO_SOURCE);
        return;
      }
      const result = selection.click(target, event.shiftKey);
      if ("refused" in result) {
        say(LIMIT);
      } else if ("send" in result) {
        // Synchronously inside the click: getDisplayMedia needs the user gesture.
        enqueue(result.send, prepareCapture());
      }
      render();
    },
    { capture: true, signal },
  );

  window.addEventListener(
    "pointermove",
    (event) => {
      if (selection.state.mode !== "picking" || ours(event)) {
        return;
      }
      const target = tagged(event);
      if (target === undefined) {
        highlight.style.display = "none";
        tip.style.display = "none";
        return;
      }
      const rect = target.getBoundingClientRect();
      place(highlight, rect);
      highlight.style.display = "block";
      const src = target.getAttribute(SRC_ATTR) ?? "";
      const component = target.getAttribute(COMPONENT_ATTR);
      const where = src.replace(/:(\d+):\d+-\d+$/, ":$1");
      tip.textContent = component ? `${component} · ${where}` : where;
      tip.style.left = `${Math.max(4, rect.left)}px`;
      tip.style.top = `${rect.top > 28 ? rect.top - 24 : rect.bottom + 4}px`;
      tip.style.display = "block";
    },
    { capture: true, signal },
  );

  window.addEventListener(
    "keydown",
    (event) => {
      if (event.isComposing) {
        return;
      }
      if (event.key === "Escape" && selection.state.mode === "picking") {
        // Esc belongs to the picker while it is on: a modal under inspection stays open.
        event.preventDefault();
        event.stopImmediatePropagation();
        selection.escape();
        render();
        return;
      }
      const key = event.code.startsWith("Key")
        ? event.code.slice(3).toLowerCase()
        : event.key.toLowerCase();
      if (
        key === shortcut.key &&
        event.altKey === shortcut.alt &&
        event.shiftKey === shortcut.shift &&
        event.ctrlKey === shortcut.ctrl &&
        event.metaKey === shortcut.meta
      ) {
        event.preventDefault();
        selection.toggle();
        render();
      }
    },
    { capture: true, signal },
  );

  // The button toggles on a click and docks to the nearest corner after a drag (R2.2).
  let drag: { x: number; y: number; moved: boolean } | undefined;
  let suppressClick = false;
  button.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, y: event.clientY, moved: false };
    button.setPointerCapture(event.pointerId);
  });
  button.addEventListener("pointermove", (event) => {
    if (drag === undefined) {
      return;
    }
    if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > DRAG_THRESHOLD_PX) {
      drag.moved = true;
    }
    if (drag.moved) {
      button.style.bottom = button.style.right = "";
      button.style.top = `${event.clientY - 14}px`;
      button.style.left = `${event.clientX - 20}px`;
    }
  });
  button.addEventListener("pointerup", (event) => {
    const moved = drag?.moved ?? false;
    drag = undefined;
    if (moved) {
      suppressClick = true;
      const v = event.clientY < innerHeight / 2 ? "top" : "bottom";
      const h = event.clientX < innerWidth / 2 ? "left" : "right";
      corner = `${v}-${h}`;
      dock();
    }
  });
  button.addEventListener("pointercancel", () => {
    // A cancelled touch drag gets no click: nothing to suppress.
    drag = undefined;
    suppressClick = false;
  });
  button.addEventListener("click", () => {
    if (suppressClick) {
      // The click that ends a drag docks the button; it does not toggle the picker.
      suppressClick = false;
      return;
    }
    selection.toggle();
    render();
  });

  send.addEventListener("click", () => {
    const elements = selection.take();
    if (elements.length > 0) {
      enqueue(elements, prepareCapture());
    }
    render();
  });

  stop.addEventListener("click", () => {
    capture.stop();
    render();
  });

  addEventListener("scroll", () => render(), { passive: true, capture: true, signal });
  // When Vite replaces this module, the next copy starts clean.
  hot.dispose(() => {
    lifetime.abort();
    hot.off("zeo:result", onResult);
    capture.stop();
    host.remove();
    document.documentElement.removeAttribute("data-zeo-devtools");
  });
  dock();
  render();
}
