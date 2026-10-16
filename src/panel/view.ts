// The panel's thread view (story 055, design.md §A3): header, banner, the thread picker or the
// transcript, status line, permission cards and the composer, driven by the panel server's event
// stream. Moved from zeo-browser/src/sidebar/view.ts (D6) onto the SSE / `rpc` transport, and
// without what a panel must not have: no follow target (R5.7), no control or request that opens,
// raises or focuses Zeo (R7.5), no page tools, no `chrome.*` / `browser.*` API.
//
// - Binding: at most one thread, `boundThread` (from `#thread=<id>` or `sessionStorage`, see
//   binding.ts). Unbound, the picker shows New thread and the project's devtools threads (R6.1);
//   `created` binds the thread it names, a listed thread binds by its id. Bound, the thread is
//   subscribed whenever a panel's stream opens — so a re-created panel re-binds it (R6.9) — and
//   when Zeo's session opens if the first attempt found it closed (503). Thread events apply only
//   after a snapshot of that thread (`bound`).
// - The bound thread's answers: `not_found` drops the binding and shows the list with "This
//   thread is no longer available" (R5.8); `agent_start_failed`, `busy` and `overloaded` (Zeo's
//   reload budget is spent, or it is loaded) are shown and retried on the backoff schedule, never
//   in a tight loop; anything else is shown and the binding kept.
// - A bound thread's stream that ends (`thread_closed`: Zeo evicted it, or closed it) is
//   re-subscribed once on the same panel; ending again before a snapshot falls back to re-creating
//   the panel, on the link's backoff (design.md §B3 Retention, refine v2).
// - Project closed (`project_closed`, or an `error project_closed`): the chat, New thread and the
//   list are disabled and nothing is sent until `project_open`, which re-enables them on the same
//   page (R7.2, R7.3).
// - Notices: Zeo too old (R2.7), unreachable while Zeo's session is not open or the panel is being
//   re-created, too many panels (the server's cap), the reason of a fatal error, the closed
//   project, and the bound thread's own line.
// - Transcript and requests: entries keyed by index — replaced on update, spliced on removal
//   (R6.2); `send` (R6.3), `cancel` (R6.4) and `authorize` (R6.5) carry a page id and Zeo's
//   `sent` / `ok` / `error` for that id arrives on the stream.
//
// Model output reaches the page only through `markdownFragment` (markdown.ts); every other string
// goes in as text.
import { writeBinding } from "./binding.js";
import { Composer, button } from "./composer.js";
import { type LinkDown, retryDelay } from "./link.js";
import { markdownFragment } from "./markdown.js";
import { ThreadPicker } from "./picker.js";
import { endedText, errorText, TEXT } from "./text.js";
import type { Logger, PanelRequest, RpcOutcome } from "./transport.js";
import type { Entry, PanelEvent, Permission, Status, TaggedEvent, ThreadInfo } from "./wire.js";

/** How long a request waits for Zeo's answer on the stream before saying none came. */
export const ANSWER_TIMEOUT_MS = 30_000;
/** A create waits longer: Zeo answers once the thread's agent is connected (GOTCHA G7, 30 s). */
export const CREATE_TIMEOUT_MS = 45_000;

/** Subscribe refusals that may pass by themselves, retried on the backoff schedule. */
const TRANSIENT_SUBSCRIBE_ERRORS: ReadonlySet<string> = new Set([
  "agent_start_failed",
  "busy",
  "overloaded",
]);

export interface ViewDeps {
  rpc(msg: PanelRequest): Promise<RpcOutcome>;
  /** Drops the current panel and re-creates it (link.ts). */
  reconnect(): void;
  /** Zeo's session of the current panel is open (link.ts backoff reset). */
  connectionOpen(): void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  log: Logger;
}

type ConnState = PanelEvent<"connection">["state"] | "unknown";
type Answer = PanelEvent<"sent"> | PanelEvent<"ok"> | PanelEvent<"error"> | { kind: "timeout" };
/** How a request ended: Zeo's answer, no answer in time, or never delivered. */
type Reply = Answer | { kind: "undelivered"; outcome: Exclude<RpcOutcome, "ok"> };
/** A request whose delivery may have to wait for Zeo's session to open. */
type Pending = "none" | "sending" | "sent" | "waiting_open";

const STATUS_WORDS: Record<Status["state"], string> = {
  idle: "Idle",
  working: "Working…",
  awaiting_permission: "Waiting for permission",
  error: "Error",
};

const TOOL_STATUS_WORDS: Record<NonNullable<Entry["tool"]>["status"], string> = {
  pending: "Pending",
  in_progress: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  awaiting_permission: "Waiting for permission",
};

/** The words for a request the panel server did not deliver. */
export function rpcFailureText(outcome: Exclude<RpcOutcome, "ok">): string {
  return outcome === "refused" ? TEXT.refused : TEXT.unreachable;
}

/** Why a request did not succeed, in the operator's words, or `null` when it did. */
function failureText(reply: Reply): string | null {
  switch (reply.kind) {
    case "undelivered":
      return rpcFailureText(reply.outcome);
    case "error":
      return errorText(reply);
    case "timeout":
      return TEXT.noAnswer;
    default:
      return null;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

export class PanelView {
  readonly composer: Composer;
  private readonly doc: Document;
  private readonly deps: ViewDeps;
  private readonly log: Logger;

  // Header
  private readonly titleEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  // Body
  private readonly banner: HTMLElement;
  private readonly body: HTMLElement;
  private readonly picker: ThreadPicker;
  private readonly transcript: HTMLElement;
  private readonly earlierEl: HTMLElement;
  private readonly entryList: HTMLOListElement;
  private readonly chat: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly permsEl: HTMLElement;

  // Link and project
  private conn: ConnState = "unknown";
  private linkDown: LinkDown | null = null;
  /** Why Zeo ended this panel's session; kept until a new session opens. */
  private fatalReason: string | null = null;
  private projectClosed = false;

  // Binding
  private boundThread: string | null;
  /** Whether thread events apply: a snapshot of `boundThread` has arrived. */
  private bound = false;
  private thread: ThreadInfo | null = null;
  private threads: ThreadInfo[] = [];
  /** A line about the binding itself (gone, a refused subscribe or create). */
  private threadNotice: string | null = null;
  private subscribeState: Pending = "none";
  private subscribeId: string | null = null;
  /** Transient subscribe refusals in a row, for the backoff; reset by a snapshot. */
  private subscribeRetries = 0;
  private subscribeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The bound thread's stream ended and was re-subscribed once; reset by a snapshot. */
  private endResent = false;
  private listState: Pending = "none";
  private creating: { id: string; timer: ReturnType<typeof setTimeout> } | null = null;

  // Transcript and requests
  /** A resync subscribe is in flight; index events wait for its snapshot. */
  private resyncing = false;
  /** Thread index of the first entry shown (the snapshot's `earlier`). */
  private base = 0;
  private entries: HTMLLIElement[] = [];
  private permissions = new Map<string, HTMLElement>();
  private answers = new Map<string, (answer: Answer) => void>();
  private seq = 0;

  constructor(panel: HTMLElement, boundThread: string | null, deps: ViewDeps) {
    this.doc = panel.ownerDocument;
    this.deps = deps;
    this.log = deps.log;
    this.boundThread = boundThread;
    const doc = this.doc;

    const header = el(doc, "header", "hdr");
    this.titleEl = el(doc, "h1", "hdr-title");
    this.metaEl = el(doc, "p", "hdr-meta");
    header.append(this.titleEl, this.metaEl);

    this.banner = el(doc, "div", "banner");
    this.banner.setAttribute("role", "status");
    this.banner.setAttribute("aria-live", "polite");

    this.body = el(doc, "div", "body");
    this.picker = new ThreadPicker(doc, {
      create: () => void this.createThread(),
      choose: (t) => this.choose(t),
    });
    this.transcript = el(doc, "section", "transcript");
    this.transcript.setAttribute("aria-label", "Thread transcript");
    this.earlierEl = el(doc, "p", "earlier");
    this.entryList = el(doc, "ol", "entries");
    this.transcript.append(this.earlierEl, this.entryList);
    this.body.append(this.picker.element, this.transcript);

    this.chat = el(doc, "div", "chat");
    this.statusEl = el(doc, "p", "status");
    this.statusEl.setAttribute("role", "status");
    this.permsEl = el(doc, "section", "perms");
    this.permsEl.setAttribute("aria-label", "Permission requests");
    this.composer = new Composer(doc, {
      send: (text) => void this.send(text),
      stop: () => void this.stop(),
    });
    this.chat.append(this.statusEl, this.permsEl, this.composer.element);

    panel.replaceChildren(header, this.banner, this.body, this.chat);
    this.renderHeader();
    this.renderStatus(null);
    this.render();
  }

  // ---------------------------------------------------------------------------------------------
  // Link

  /** A panel's stream is open: bind the thread again, or list the threads. */
  onReady(): void {
    this.linkDown = null;
    this.conn = "unknown";
    this.subscribeState = "none";
    this.listState = "none";
    if (this.boundThread !== null) {
      this.subscribe();
    } else {
      this.listThreads();
    }
    this.render();
  }

  /** There is no usable panel; the link is re-creating one. */
  onDown(reason: LinkDown): void {
    this.linkDown = reason;
    this.conn = "unknown";
    this.subscribeState = "none";
    this.subscribeId = null;
    this.listState = "none";
    this.resyncing = false;
    this.cancelSubscribeRetry();
    this.cancelCreate();
    // Answers of the lost panel can no longer arrive.
    for (const waiter of [...this.answers.values()]) {
      waiter({ kind: "timeout" });
    }
    this.render();
  }

  onEvent(e: TaggedEvent): void {
    switch (e.kind) {
      case "connection":
        this.onConnection(e.data.state);
        return;
      case "welcome":
        this.log.info({ event: "panel_welcome", protocol: e.data.protocol });
        return;
      case "project_open":
        this.setProjectClosed(false);
        return;
      case "project_closed":
        this.setProjectClosed(true);
        return;
      case "threads":
        this.threads = e.data.items;
        this.listState = "sent";
        this.render();
        return;
      case "created":
        this.onCreated(e.data);
        return;
      case "snapshot":
        this.onSnapshot(e.data);
        return;
      case "sent":
      case "ok":
        this.answer(e.data.id, e.data);
        return;
      case "error":
        this.onError(e.data);
        return;
      case "thread_closed":
        this.onThreadEnd();
        return;
      default:
        break;
    }
    if (!this.bound) {
      // An event of a thread the view does not show (yet).
      return;
    }
    switch (e.kind) {
      case "title":
        if (this.thread) {
          this.thread = { ...this.thread, title: e.data.title };
          this.renderHeader();
        }
        break;
      case "entry_added":
        this.insertEntry(e.data.index, e.data.entry);
        break;
      case "entry_updated":
        this.updateEntry(e.data.index, e.data.entry);
        break;
      case "entries_removed":
        this.removeEntries(e.data.start, e.data.end);
        break;
      case "status":
        this.renderStatus(e.data.status);
        break;
      case "permission_requested":
        this.addPermission(e.data.permission);
        break;
      case "permission_resolved":
        this.removePermission(e.data.request_id);
        break;
    }
  }

  private onConnection(state: PanelEvent<"connection">["state"]): void {
    this.conn = state;
    if (state === "open") {
      this.fatalReason = null;
      this.deps.connectionOpen();
      if (this.subscribeState === "waiting_open") {
        this.subscribe();
      }
      if (this.listState === "waiting_open") {
        this.listThreads();
      }
    }
    this.renderBanner();
  }

  private setProjectClosed(closed: boolean): void {
    this.projectClosed = closed;
    if (closed) {
      // A create in flight is answered `project_closed` by Zeo; nothing else may go out.
      this.cancelSubscribeRetry();
    } else if (this.boundThread === null) {
      this.listThreads();
    } else if (!this.bound && this.subscribeState !== "sending") {
      this.subscribe();
    }
    this.render();
  }

  private onError(err: PanelEvent<"error">): void {
    const id = err.id;
    this.log.info({ event: "panel_zeo_error", code: err.error, fatal: err.fatal });
    if (err.fatal) {
      // The server ends the stream next; the link re-creates the panel, and this stays shown.
      this.fatalReason = endedText(err);
    }
    if (err.error === "project_closed") {
      this.projectClosed = true;
    }
    if (id !== undefined && this.answers.has(id)) {
      this.answer(id, err);
    } else if (id !== undefined && this.creating?.id === id) {
      this.cancelCreate();
      // R6.10: the reason, nothing bound, New thread enabled again.
      this.threadNotice = errorText(err);
    } else if (id !== undefined && id === this.subscribeId) {
      this.onSubscribeError(err);
    }
    this.render();
  }

  // ---------------------------------------------------------------------------------------------
  // Binding

  private bind(thread: ThreadInfo | string): void {
    const threadId = typeof thread === "string" ? thread : thread.thread_id;
    this.boundThread = threadId;
    writeBinding(this.deps.storage, threadId);
    this.thread = typeof thread === "string" ? null : thread;
    this.bound = false;
    this.endResent = false;
    this.subscribeRetries = 0;
    this.threadNotice = null;
    this.resetTranscript(0);
    this.clearPermissions();
    this.renderStatus(null);
    this.renderHeader();
    this.subscribe();
    this.render();
  }

  /** R5.8: the bound thread is gone; back to the list. */
  private dropBinding(notice: string): void {
    this.boundThread = null;
    writeBinding(this.deps.storage, null);
    this.bound = false;
    this.thread = null;
    this.subscribeId = null;
    this.subscribeState = "none";
    this.endResent = false;
    this.cancelSubscribeRetry();
    this.threadNotice = notice;
    this.resetTranscript(0);
    this.clearPermissions();
    this.renderStatus(null);
    this.renderHeader();
    this.listThreads();
    this.render();
  }

  private choose(thread: ThreadInfo): void {
    if (this.projectClosed) {
      return;
    }
    this.bind(thread);
  }

  private async createThread(): Promise<void> {
    if (this.projectClosed || this.creating !== null) {
      return;
    }
    const id = this.nextId("n");
    const timer = setTimeout(() => {
      if (this.creating?.id === id) {
        this.creating = null;
        this.threadNotice = TEXT.noAnswer;
        this.render();
      }
    }, CREATE_TIMEOUT_MS);
    this.creating = { id, timer };
    this.threadNotice = null;
    this.render();
    const outcome = await this.deps.rpc({ kind: "create_thread", id });
    if (outcome !== "ok" && this.creating?.id === id) {
      this.cancelCreate();
      this.threadNotice = rpcFailureText(outcome);
      this.render();
    }
  }

  /** Forgets a scheduled subscribe retry (a transient refusal's backoff). */
  private cancelSubscribeRetry(): void {
    clearTimeout(this.subscribeTimer);
    this.subscribeTimer = undefined;
  }

  private cancelCreate(): void {
    if (this.creating !== null) {
      clearTimeout(this.creating.timer);
      this.creating = null;
    }
  }

  /**
   * Zeo answers `created` only to the session that asked, so a `created` while a create is in
   * flight is that create's, whatever id it echoes; one with no create in flight is ignored.
   */
  private onCreated(c: PanelEvent<"created">): void {
    if (this.creating === null) {
      this.log.debug({ event: "panel_created_unexpected" });
      return;
    }
    if (c.id !== this.creating.id) {
      this.log.debug({ event: "panel_created_id_mismatch" });
    }
    this.cancelCreate();
    if (!this.threads.some((t) => t.thread_id === c.thread.thread_id)) {
      this.threads = [c.thread, ...this.threads];
    }
    this.bind(c.thread);
  }

  /** Subscribes the bound thread on the current panel. */
  private subscribe(): void {
    this.cancelSubscribeRetry();
    const threadId = this.boundThread;
    if (threadId === null || this.projectClosed || this.linkDown !== null) {
      // Re-sent on `project_open`, or by `onReady` once a panel exists again.
      this.subscribeState = "none";
      return;
    }
    const id = this.nextId("s");
    this.subscribeId = id;
    this.subscribeState = "sending";
    void this.deps.rpc({ kind: "subscribe", id, thread_id: threadId }).then((outcome) => {
      if (this.subscribeId !== id) {
        return;
      }
      this.settlePending("subscribe", outcome, () => this.subscribe());
    });
  }

  private listThreads(): void {
    if (this.projectClosed || this.linkDown !== null || this.listState === "sending") {
      return;
    }
    const id = this.nextId("l");
    this.listState = "sending";
    void this.deps.rpc({ kind: "list_threads", id }).then((outcome) => {
      this.settlePending("list", outcome, () => this.listThreads());
    });
  }

  /**
   * Where a subscribe or list POST leaves its request: delivered, waiting for Zeo's session to
   * open (503), or failed. A 503 while the session was already reported open is retried once at
   * once: that `connection` event overtook the POST's answer.
   */
  private settlePending(which: "subscribe" | "list", outcome: RpcOutcome, retry: () => void) {
    const set = (s: Pending) => {
      if (which === "subscribe") {
        this.subscribeState = s;
      } else {
        this.listState = s;
      }
    };
    if (outcome === "ok") {
      set("sent");
      return;
    }
    if (which === "subscribe") {
      this.resyncing = false;
    }
    if (outcome === "unreachable") {
      const retryNow = this.conn === "open";
      set("waiting_open");
      if (retryNow) {
        set("none");
        retry();
      }
      return;
    }
    set("none");
    if (outcome === "refused") {
      this.threadNotice = TEXT.refused;
      this.render();
    }
    // `unknown_panel` and `network`: the link is re-creating the panel, and `onReady` re-sends.
  }

  private onSubscribeError(err: PanelEvent<"error">): void {
    this.subscribeState = "none";
    this.resyncing = false;
    if (err.error === "not_found") {
      this.dropBinding(TEXT.gone);
      return;
    }
    if (err.error === "project_closed") {
      // Re-subscribed on `project_open`.
      return;
    }
    this.threadNotice = errorText(err);
    if (TRANSIENT_SUBSCRIBE_ERRORS.has(err.error)) {
      // Zeo's reload budget for this thread is spent, or it is busy: try again later, backing off.
      const delay = retryDelay(this.subscribeRetries + 1);
      this.subscribeRetries += 1;
      this.subscribeTimer = setTimeout(() => {
        this.subscribeTimer = undefined;
        if (this.boundThread !== null && !this.bound) {
          this.subscribe();
        }
      }, delay);
    }
  }

  /**
   * The bound thread's stream ended without `not_found` (Zeo evicted the idle thread, or closed
   * it): re-subscribe once on this panel; ending again before a snapshot re-creates the panel.
   */
  private onThreadEnd(): void {
    if (this.boundThread === null || (!this.bound && !this.endResent)) {
      this.log.debug({ event: "panel_thread_end_ignored" });
      return;
    }
    this.bound = false;
    this.clearPermissions();
    this.render();
    if (!this.endResent) {
      this.endResent = true;
      this.log.info({ event: "panel_thread_end", action: "resubscribe" });
      this.subscribe();
      return;
    }
    this.log.info({ event: "panel_thread_end", action: "reconnect" });
    this.deps.reconnect();
  }

  // ---------------------------------------------------------------------------------------------
  // Requests

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}${this.seq}`;
  }

  /**
   * Posts one request under a fresh page id and waits for Zeo's answer to it on the stream. The
   * waiter is registered before the POST goes, because the answer can arrive on the stream before
   * the POST's own response.
   */
  private async request(prefix: string, msg: PanelRequest): Promise<Reply> {
    const id = this.nextId(prefix);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = new Promise<Answer>((resolve) => {
      timer = setTimeout(() => {
        this.answers.delete(id);
        resolve({ kind: "timeout" });
      }, ANSWER_TIMEOUT_MS);
      this.answers.set(id, (a) => {
        clearTimeout(timer);
        this.answers.delete(id);
        resolve(a);
      });
    });
    const outcome = await this.deps.rpc({ ...msg, id });
    if (outcome !== "ok") {
      clearTimeout(timer);
      this.answers.delete(id);
      return { kind: "undelivered", outcome };
    }
    return answer;
  }

  private answer(id: string, a: Answer): void {
    const waiter = this.answers.get(id);
    if (waiter) {
      waiter(a);
    } else {
      this.log.debug({ event: "panel_answer_unmatched", kind: a.kind });
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.bound || this.projectClosed) {
      return;
    }
    this.composer.setSending(true);
    this.composer.notify(null);
    const reply = await this.request("m", { kind: "send", text, attachments: [] });
    if (reply.kind === "sent") {
      this.composer.clear();
      this.composer.notify(reply.queued ? TEXT.queued : null);
    } else {
      // The text stays: nothing went out, or Zeo refused it (R6.8).
      this.composer.notify(failureText(reply), "error");
    }
    this.composer.setSending(false);
  }

  private async stop(): Promise<void> {
    if (this.projectClosed) {
      return;
    }
    this.composer.setStopping(true);
    const failed = failureText(await this.request("c", { kind: "cancel" }));
    if (failed !== null) {
      this.composer.notify(failed, "error");
    }
    this.composer.setStopping(false);
  }

  private async authorize(
    requestId: string,
    optionId: string,
    buttons: HTMLButtonElement[],
    error: HTMLElement,
  ): Promise<void> {
    if (this.projectClosed) {
      return;
    }
    for (const b of buttons) {
      b.disabled = true;
    }
    error.textContent = "";
    const reply = await this.request("a", {
      kind: "authorize",
      request_id: requestId,
      option_id: optionId,
    });
    if (reply.kind === "error" && reply.error === "stale_permission") {
      // Already answered elsewhere: the card has nothing left to ask.
      this.removePermission(requestId);
      return;
    }
    // The card goes on `permission_resolved` for its own request, not on `ok` (R6.5).
    const failed = failureText(reply);
    if (failed !== null) {
      error.textContent = failed;
      for (const b of buttons) {
        b.disabled = false;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Rendering: header, banner, picker or chat

  private render(): void {
    this.renderBanner();
    const hasThread = this.boundThread !== null;
    this.picker.render(!hasThread, {
      threads: this.threads,
      disabled: this.projectClosed,
      creating: this.creating !== null,
    });
    this.transcript.hidden = !hasThread;
    this.chat.hidden = !hasThread;
    this.composer.setEnabled(this.bound && !this.projectClosed);
    // Permission answers are chat too: unreachable while the project is closed (R7.2).
    this.permsEl.inert = this.projectClosed;
  }

  private renderHeader(): void {
    this.titleEl.textContent =
      this.thread?.title || (this.boundThread === null ? "Zeo devtools" : TEXT.untitled);
    this.metaEl.textContent = this.thread ? `${this.thread.project} · ${this.thread.agent}` : "";
  }

  /** The banner's lines, most important first, and its tone. */
  private bannerLines(): { tone: "warn" | "error"; lines: string[] } {
    const lines: string[] = [];
    let tone: "warn" | "error" = "warn";
    if (this.conn === "zeo_too_old") {
      lines.push(TEXT.tooOld);
      tone = "error";
    } else if (this.linkDown === "too_many_panels") {
      lines.push(TEXT.tooManyPanels);
    } else if (this.linkDown === "unreachable" || this.conn === "connecting") {
      lines.push(TEXT.unreachable);
    }
    if (this.fatalReason !== null) {
      lines.push(this.fatalReason);
      tone = "error";
    }
    if (this.projectClosed) {
      lines.push(TEXT.projectClosed);
    }
    if (this.threadNotice !== null) {
      lines.push(this.threadNotice);
    }
    return { tone, lines };
  }

  private renderBanner(): void {
    const { tone, lines } = this.bannerLines();
    if (lines.length === 0) {
      this.banner.replaceChildren();
      this.banner.hidden = true;
      return;
    }
    this.banner.dataset.tone = tone;
    this.banner.hidden = false;
    this.banner.replaceChildren(...lines.map((line) => el(this.doc, "p", undefined, line)));
  }

  // ---------------------------------------------------------------------------------------------
  // Transcript

  private onSnapshot(s: PanelEvent<"snapshot">): void {
    if (this.boundThread === null || s.thread?.thread_id !== this.boundThread) {
      this.log.debug({ event: "panel_snapshot_ignored" });
      return;
    }
    this.thread = s.thread;
    this.bound = true;
    this.resyncing = false;
    this.endResent = false;
    this.subscribeRetries = 0;
    this.subscribeState = "sent";
    this.threadNotice = null;
    this.resetTranscript(s.earlier);
    for (const entry of s.entries) {
      const node = this.renderEntry(entry);
      this.entries.push(node);
      this.entryList.append(node);
    }
    this.renderStatus(s.status);
    this.clearPermissions();
    for (const p of s.permissions) {
      this.addPermission(p);
    }
    this.renderHeader();
    this.render();
    this.scrollToEnd();
  }

  /** Re-subscribes the bound thread after a missed event (an index out of range). */
  private resync(event: string, index: number): void {
    this.log.warn({ event: "panel_transcript_resync", kind: event, index });
    if (this.resyncing) {
      return;
    }
    this.resyncing = true;
    this.subscribe();
  }

  private resetTranscript(earlier: number): void {
    this.base = earlier;
    this.entries = [];
    this.entryList.replaceChildren();
    this.renderEarlier();
  }

  private renderEarlier(): void {
    if (this.base <= 0) {
      this.earlierEl.textContent = "";
      this.earlierEl.hidden = true;
      return;
    }
    this.earlierEl.hidden = false;
    this.earlierEl.textContent =
      this.base === 1 ? "1 earlier entry, not shown" : `${this.base} earlier entries, not shown`;
  }

  private insertEntry(index: number, entry: Entry): void {
    if (this.resyncing) {
      return;
    }
    if (index < this.base) {
      // Before the shown window: only the count moves.
      this.base++;
      this.renderEarlier();
      return;
    }
    const at = index - this.base;
    if (at > this.entries.length) {
      this.resync("entry_added", index);
      return;
    }
    const node = this.renderEntry(entry);
    this.entryList.insertBefore(node, this.entries[at] ?? null);
    this.entries.splice(at, 0, node);
    this.scrollToEnd();
  }

  private updateEntry(index: number, entry: Entry): void {
    if (this.resyncing || index < this.base) {
      // Before the shown window: nothing on screen changes.
      return;
    }
    const at = index - this.base;
    const old = this.entries[at];
    if (!old) {
      this.resync("entry_updated", index);
      return;
    }
    const node = this.renderEntry(entry);
    old.replaceWith(node);
    this.entries[at] = node;
  }

  private removeEntries(start: number, end: number): void {
    if (this.resyncing || end <= start) {
      return;
    }
    if (end - this.base > this.entries.length) {
      this.resync("entries_removed", end);
      return;
    }
    // The part before the shown window only lowers the count.
    const hidden = Math.max(0, Math.min(end, this.base) - start);
    const from = Math.max(start - this.base, 0);
    const to = Math.max(end - this.base, 0);
    for (const node of this.entries.splice(from, to - from)) {
      node.remove();
    }
    if (hidden > 0) {
      this.base -= hidden;
      this.renderEarlier();
    }
  }

  private renderEntry(entry: Entry): HTMLLIElement {
    const doc = this.doc;
    const li = el(doc, "li", `entry entry-${entry.role}`);
    switch (entry.role) {
      case "question":
        li.append(el(doc, "p", "entry-note", TEXT.question));
        return li;
      case "compaction":
        li.append(el(doc, "p", "entry-note", TEXT.compaction));
        return li;
      case "tool": {
        const tool = entry.tool;
        const head = el(doc, "span", "tool-head");
        head.append(el(doc, "span", "tool-title", tool?.title || "Tool call"));
        if (tool) {
          const pill = el(doc, "span", "tool-status", TOOL_STATUS_WORDS[tool.status]);
          pill.dataset.status = tool.status;
          head.append(pill);
        }
        if (entry.markdown.length === 0 && !entry.truncated) {
          li.append(head);
          return li;
        }
        const details = el(doc, "details", "tool");
        const summary = el(doc, "summary");
        summary.append(head);
        details.append(summary, this.entryBody(entry));
        li.append(details);
        return li;
      }
      case "user":
      case "assistant":
        li.append(el(doc, "span", "visually-hidden", entry.role === "user" ? "You:" : "Agent:"));
        li.append(this.entryBody(entry));
        return li;
    }
  }

  /** An entry's text: its Markdown, then the truncation note when Zeo cut it. */
  private entryBody(entry: Entry): HTMLElement {
    const body = el(this.doc, "div", "md");
    body.append(markdownFragment(entry.markdown, this.doc));
    if (entry.truncated && !entry.markdown.trimEnd().endsWith(TEXT.truncated)) {
      body.append(el(this.doc, "p", "truncated", TEXT.truncated));
    }
    return body;
  }

  private renderStatus(status: Status | null): void {
    const state = status?.state ?? "idle";
    const words = STATUS_WORDS[state];
    this.statusEl.dataset.state = state;
    this.statusEl.textContent =
      state === "error" && status?.message ? `${words}: ${status.message}` : words;
    this.composer.setStatus(state);
  }

  private scrollToEnd(): void {
    this.body.scrollTop = this.body.scrollHeight;
  }

  // ---------------------------------------------------------------------------------------------
  // Permissions

  private addPermission(p: Permission): void {
    this.removePermission(p.request_id);
    const doc = this.doc;
    const card = el(doc, "article", "perm");
    card.setAttribute("aria-label", `Permission request: ${p.title}`);
    card.append(el(doc, "p", "perm-title", p.title));
    const error = el(doc, "p", "perm-error");
    error.setAttribute("role", "alert");
    const row = el(doc, "div", "perm-options");
    const buttons: HTMLButtonElement[] = p.options.map((o) => {
      const kind = o.kind.startsWith("allow") ? "btn-allow" : "btn-reject";
      const b = button(doc, o.label, `btn ${kind}`);
      b.addEventListener(
        "click",
        () => void this.authorize(p.request_id, o.option_id, buttons, error),
      );
      return b;
    });
    row.append(...buttons);
    card.append(row, error);
    this.permissions.set(p.request_id, card);
    this.permsEl.append(card);
  }

  private removePermission(requestId: string): void {
    this.permissions.get(requestId)?.remove();
    this.permissions.delete(requestId);
  }

  private clearPermissions(): void {
    for (const card of this.permissions.values()) {
      card.remove();
    }
    this.permissions.clear();
  }
}
