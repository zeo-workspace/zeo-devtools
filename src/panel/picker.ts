// The thread picker (story 055, design.md §A3, R6.1, R5.4): "New thread" and the project's
// devtools threads, shown while the panel is bound to none. Only threads Zeo lists for this
// panel's root appear here, and there is no follow entry (R5.7).
//
// One click handler sits on the list, so a click on a row or on its button is the same choice,
// and the same guard applies to both: while the picker is disabled (the project is closed, R7.2,
// or the panel server stopped, R3.8) nothing is chosen, whatever element was clicked. The rows
// are rebuilt only while shown, so no hidden title lingers in the page's text.
import { button } from "./composer.js";
import { TEXT } from "./text.js";
import type { ThreadInfo } from "./wire.js";

export interface PickerHandlers {
  /** "New thread" was pressed. */
  create(): void;
  /** A listed thread was chosen. */
  choose(thread: ThreadInfo): void;
}

export interface PickerState {
  threads: readonly ThreadInfo[];
  /** Everything is disabled (the project is closed, or the panel server stopped). */
  disabled: boolean;
  /** A create is in flight: New thread waits for it. */
  creating: boolean;
}

export class ThreadPicker {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly newThread: HTMLButtonElement;
  private readonly list: HTMLUListElement;
  private readonly emptyEl: HTMLElement;
  private shown: ThreadInfo[] = [];
  private disabled = false;

  constructor(doc: Document, handlers: PickerHandlers) {
    this.doc = doc;
    this.element = doc.createElement("section");
    this.element.className = "picker";
    this.element.setAttribute("aria-labelledby", "zeo-picker-heading");

    const head = doc.createElement("div");
    head.className = "picker-head";
    const heading = doc.createElement("h2");
    heading.id = "zeo-picker-heading";
    heading.className = "picker-heading";
    heading.textContent = TEXT.pickerHeading;
    this.newThread = button(doc, TEXT.newThread, "btn btn-primary");
    this.newThread.addEventListener("click", () => {
      if (!this.newThread.disabled) {
        handlers.create();
      }
    });
    head.append(heading, this.newThread);

    this.list = doc.createElement("ul");
    this.list.className = "thread-list";
    this.list.setAttribute("aria-labelledby", "zeo-picker-heading");
    this.list.addEventListener("click", (e) => {
      const row = (e.target as Element | null)?.closest?.("[data-index]");
      if (this.disabled || row === null || row === undefined || !this.list.contains(row)) {
        return;
      }
      const thread = this.shown[Number((row as HTMLElement).dataset.index)];
      if (thread !== undefined) {
        handlers.choose(thread);
      }
    });
    this.emptyEl = doc.createElement("p");
    this.emptyEl.className = "picker-empty";

    this.element.append(head, this.list, this.emptyEl);
  }

  /** Shows the picker with `state`, or hides it and drops its rows. */
  render(visible: boolean, state: PickerState): void {
    this.element.hidden = !visible;
    this.disabled = state.disabled;
    this.newThread.disabled = state.disabled || state.creating;
    this.shown = visible ? [...state.threads] : [];
    this.list.replaceChildren(...this.shown.map((t, i) => this.row(t, i)));
    this.emptyEl.textContent = visible && this.shown.length === 0 ? TEXT.noThreads : "";
    this.emptyEl.hidden = !visible || this.shown.length > 0;
  }

  private row(t: ThreadInfo, index: number): HTMLLIElement {
    const doc = this.doc;
    const li = doc.createElement("li");
    li.className = "thread-row";
    li.dataset.index = String(index);
    const choose = button(doc, "", "thread-choose");
    choose.disabled = this.disabled;
    const title = doc.createElement("span");
    title.className = "thread-title";
    title.textContent = t.title || TEXT.untitled;
    const meta = doc.createElement("span");
    meta.className = "thread-meta";
    meta.textContent = `${t.agent} · ${STATUS_LABEL[t.status]}`;
    choose.append(title, meta);
    li.append(choose);
    return li;
  }
}

const STATUS_LABEL: Record<ThreadInfo["status"], string> = {
  idle: "idle",
  working: "working",
  awaiting_permission: "waiting for permission",
  error: "error",
};
