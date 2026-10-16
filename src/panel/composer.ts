// The panel composer (story 055, design.md §A3): textarea, Send, Stop and a notice line. Moved from
// zeo-browser/src/sidebar/composer.ts (D6) without the page tools and attachment chips, which the
// selection stories bring back (054, 056, 057).
//
// - Send is disabled while the text is empty, while a send is in flight and while the composer is
//   disabled (no bound thread yet, or a project closed — task 6.2).
// - The text is cleared only when the view says the message went out (`sent`); on any failure it
//   stays, with the reason in the notice line (R6.8).
// - Stop is enabled only while the thread has a turn to stop (R6.4).
// - Enter sends, Shift+Enter adds a line, an IME composition is never cut short.
import type { Status } from "./wire.js";
import { TEXT } from "./text.js";

export type Tone = "info" | "error";

export interface ComposerHandlers {
  /** The operator asked to send `text`. */
  send(text: string): void;
  /** The operator pressed Stop. */
  stop(): void;
}

/** A `type="button"` button with its visible label, so no click ever submits a form. */
export function button(doc: Document, label: string, className: string): HTMLButtonElement {
  const b = doc.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = label;
  return b;
}

let composerCount = 0;

export class Composer {
  readonly element: HTMLElement;
  private readonly doc: Document;
  private readonly textarea: HTMLTextAreaElement;
  private readonly noticeEl: HTMLElement;
  private readonly sendButton: HTMLButtonElement;
  private readonly stopButton: HTMLButtonElement;
  private sending = false;
  private stopping = false;
  private turnRunning = false;
  private enabled = false;

  constructor(doc: Document, handlers: ComposerHandlers) {
    this.doc = doc;
    const id = `zeo-message-${++composerCount}`;

    this.element = doc.createElement("section");
    this.element.className = "composer";
    this.element.setAttribute("aria-label", "Message composer");

    const label = doc.createElement("label");
    label.htmlFor = id;
    label.className = "visually-hidden";
    label.textContent = TEXT.messageLabel;
    this.textarea = doc.createElement("textarea");
    this.textarea.id = id;
    this.textarea.rows = 3;
    this.textarea.placeholder = TEXT.messagePlaceholder;
    this.textarea.addEventListener("input", () => this.refresh());
    this.textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.trySend(handlers);
      }
    });

    this.noticeEl = doc.createElement("div");
    this.noticeEl.className = "notice";
    this.noticeEl.setAttribute("role", "status");
    this.noticeEl.setAttribute("aria-live", "polite");

    const bar = doc.createElement("div");
    bar.className = "composer-bar";
    this.stopButton = button(doc, "Stop", "btn btn-quiet");
    this.stopButton.addEventListener("click", () => {
      if (!this.stopButton.disabled) {
        handlers.stop();
      }
    });
    this.sendButton = button(doc, "Send", "btn btn-primary");
    this.sendButton.addEventListener("click", () => this.trySend(handlers));
    bar.append(this.stopButton, this.sendButton);

    this.element.append(label, this.textarea, this.noticeEl, bar);
    this.refresh();
  }

  /** The text as typed. */
  text(): string {
    return this.textarea.value;
  }

  /** Clears the text after a message went out. */
  clear(): void {
    this.textarea.value = "";
    this.refresh();
  }

  /** Whether the composer may send at all (a bound, open thread). */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.refresh();
  }

  /** A send is in flight: the text is read-only and Send waits. */
  setSending(on: boolean): void {
    this.sending = on;
    this.refresh();
  }

  /** A cancel is in flight: Stop waits. */
  setStopping(on: boolean): void {
    this.stopping = on;
    this.refresh();
  }

  /** The thread's status, which decides whether Stop has a turn to stop. */
  setStatus(state: Status["state"]): void {
    this.turnRunning = state === "working" || state === "awaiting_permission";
    this.refresh();
  }

  /** Shows `lines` in the notice line, or clears it with `null`. */
  notify(lines: string | readonly string[] | null, tone: Tone = "info"): void {
    const list = lines === null ? [] : typeof lines === "string" ? [lines] : lines;
    this.noticeEl.replaceChildren(
      ...list.map((line) => {
        const p = this.doc.createElement("p");
        p.textContent = line;
        return p;
      }),
    );
    this.noticeEl.dataset.tone = tone;
  }

  private trySend(handlers: ComposerHandlers): void {
    if (this.sendButton.disabled) {
      return;
    }
    handlers.send(this.textarea.value);
  }

  private refresh(): void {
    this.sendButton.disabled = !this.enabled || this.sending || this.textarea.value.length === 0;
    this.stopButton.disabled = !this.enabled || this.stopping || !this.turnRunning;
    this.textarea.readOnly = this.sending || !this.enabled;
    this.textarea.setAttribute("aria-disabled", String(!this.enabled));
  }
}
