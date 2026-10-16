// @vitest-environment happy-dom
// Story 055, task 17.4 (refine v3) — the panel shows Zeo's other subscribe and send errors and
// disables the chat for that thread (design.md §A3 "Other thread errors (v3)"). Requirements:
// R5.10, R5.8 (Q4). Validation filter: `npm test -- panel-view.thread-errors`. Found by 16.2's GUI
// proof: the reopened project's bound thread was refused (`agent_start_failed`) and the panel
// showed no error.
//
// Contract (design.md §A3): a `subscribe` or `send` answered with an error other than `not_found`
// sets the binding's notice to that error's text — shown in the banner, not only in the
// composer's own line — and disables the composer for the bound thread; `not_found` keeps R5.8
// (drop the binding, show the list with "This thread is no longer available"). The texts are
// Zeo's own `message` (text.ts `errorText`).
//
// The codes: `agent_start_failed`, `busy`, `overloaded` — what Zeo answers a panel's subscribe or
// send with (browser_wire.rs). `load_failed` is not a wire code: it is Zeo's log event when a load
// fails, and reaches the panel as `agent_start_failed`; `send_failed` stands for "any other code"
// on a send.
//
// Seam: test/helpers/panel-harness.ts. "In the banner" = a status region outside the "Message
// composer" section (the composer has its own notice line); found by role and accessible name,
// never by class.
//
// Hostile halves first:
//   - wrongly collapsed: `not_found` (thread gone, R5.8) is not "another error" — on a send too, it
//     drops the binding, while every other code keeps it and disables the chat;
//   - wrongly split: the rule is the same on a subscribe answered after the thread was shown (a
//     resync) as on the first subscribe, and the same on a send — a disabled chat only before the
//     first snapshot, or a send error only in the composer's line, both fail;
//   - the typed text survives the refused send (R6.8);
//   - benign: once another thread is bound, the old thread's error and disabled state are gone.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  button,
  clickable,
  composer,
  mountPanel,
  snapshot,
  submit,
  text,
  thread,
  type,
  unmountPanel,
  type Harness,
  type Rpc,
} from "./helpers/panel-harness.js";

const GONE = "This thread is no longer available";

/** Zeo's own messages for the codes a panel's subscribe or send can get (browser_wire.rs). */
const MESSAGES = {
  agent_start_failed: "The agent could not start in Zeo",
  busy: "Zeo is already serving 8 sessions",
  overloaded: "The session fell too far behind and Zeo closed it",
} as const;
const OTHER_SEND = { code: "send_failed", message: "Zeo could not send the message to the agent" };
const CODES = Object.keys(MESSAGES) as (keyof typeof MESSAGES)[];

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  unmountPanel();
});

const errorFor = (r: Rpc | undefined, error: string, message: string) => ({
  v: 2,
  kind: "error",
  ...(typeof r?.msg.id === "string" ? { id: r.msg.id } : {}),
  error,
  message,
  fatal: false,
});

const disabled = (el: Element | undefined) =>
  el === undefined ||
  (el as HTMLButtonElement).disabled === true ||
  (el as HTMLTextAreaElement).readOnly === true ||
  el.getAttribute("aria-disabled") === "true" ||
  el.closest("[inert], fieldset[disabled]") !== null;

/** The text of every status region outside the composer: the banner, not the composer's line. */
function bannerText(): string {
  return [...document.querySelectorAll("[role=status], [role=alert]")]
    .filter((el) => el.closest('[aria-label="Message composer"]') === null)
    .map((el) => el.textContent ?? "")
    .join(" ")
    .replace(/\s+/g, " ");
}

function expectChatDisabled(what: string) {
  const area = composer();
  expect(disabled(area), `${what}: the textarea is disabled`).toBe(true);
  expect(disabled(button(/^send$/i)), `${what}: Send is disabled`).toBe(true);
}

/** A panel bound to `t-a`, its snapshot shown, `typed` in the composer. */
async function shown(typed = "a message for t-a"): Promise<Harness> {
  sessionStorage.setItem("boundThread", "t-a");
  const h = await mountPanel();
  await h.emit({ v: 2, kind: "threads", id: "r1", items: [thread("t-a"), thread("t-b")] });
  await h.emit(snapshot("t-a", [{ role: "assistant", markdown: "hello from t-a" }]));
  await type(composer()!, typed);
  expect(disabled(button(/^send$/i)), "Send works before the error").toBe(false);
  return h;
}

/** Sends the typed text and answers the send with `error`. */
async function refuseSend(h: Harness, error: string, message: string) {
  await submit(composer()!);
  await h.settle();
  const send = h.lastRpc("send");
  expect(send, "the send went out").toBeDefined();
  await h.emit(errorFor(send, error, message));
}

// ---- hostile: not_found is not "another error" ------------------------------------------------

describe("not_found keeps R5.8's path (R5.8)", () => {
  it("hostile: a send answered not_found drops the binding and shows the list", async () => {
    const h = await shown();
    await refuseSend(h, "not_found", "Zeo has no such thread for this project");
    expect(sessionStorage.getItem("boundThread"), "the binding is dropped").toBeNull();
    expect(text()).toContain(GONE);
    expect(button(/^new thread$/i), "the list is back").toBeDefined();
    expect(composer(), "no chat without a binding").toBeUndefined();
  });

  it("converse: a subscribe answered not_found drops the binding too", async () => {
    sessionStorage.setItem("boundThread", "t-a");
    const h = await mountPanel();
    await h.emit(errorFor(h.lastRpc("subscribe"), "not_found", "gone"));
    expect(sessionStorage.getItem("boundThread")).toBeNull();
    expect(text()).toContain(GONE);
  });
});

// ---- hostile: the same rule on every path ------------------------------------------------------

describe("another error on a send (R5.10)", () => {
  for (const code of CODES) {
    it(`hostile: ${code} shows Zeo's text in the banner, disables the chat, keeps the binding and the text`, async () => {
      const h = await shown("keep this text");
      await refuseSend(h, code, MESSAGES[code]);
      expect(bannerText(), "in the banner, not only in the composer's line").toContain(
        MESSAGES[code],
      );
      expectChatDisabled(code);
      expect(composer()!.value, "R6.8: the refused text stays").toBe("keep this text");
      expect(sessionStorage.getItem("boundThread"), "not R5.8: the binding stays").toBe("t-a");
      expect(text()).not.toContain(GONE);
    });
  }

  it("hostile: any other code on a send (send_failed) is shown and disables the chat as well", async () => {
    const h = await shown();
    await refuseSend(h, OTHER_SEND.code, OTHER_SEND.message);
    expect(bannerText()).toContain(OTHER_SEND.message);
    expectChatDisabled(OTHER_SEND.code);
  });
});

describe("another error on a subscribe (R5.10)", () => {
  for (const code of CODES) {
    it(`hostile: ${code} on a subscribe after the thread was shown (a resync) shows its text and disables the chat`, async () => {
      const h = await shown();
      const before = h.rpcs.filter((r) => r.msg.kind === "subscribe").length;
      // An index past the transcript: the view re-subscribes to resync.
      await h.emit({
        v: 2,
        kind: "entry_added",
        index: 7,
        entry: { role: "assistant", markdown: "out of range", truncated: false },
      });
      await vi.waitFor(() =>
        expect(h.rpcs.filter((r) => r.msg.kind === "subscribe").length).toBe(before + 1),
      );
      await h.emit(errorFor(h.lastRpc("subscribe"), code, MESSAGES[code]));
      expect(bannerText()).toContain(MESSAGES[code]);
      expectChatDisabled(`${code} on a resync`);
      expect(sessionStorage.getItem("boundThread")).toBe("t-a");
    });

    it(`${code} on the first subscribe shows its text and leaves the chat disabled`, async () => {
      sessionStorage.setItem("boundThread", "t-a");
      const h = await mountPanel();
      await h.emit(errorFor(h.lastRpc("subscribe"), code, MESSAGES[code]));
      expect(bannerText()).toContain(MESSAGES[code]);
      expectChatDisabled(`${code} on the first subscribe`);
      expect(sessionStorage.getItem("boundThread")).toBe("t-a");
    });
  }
});

// ---- benign: another thread clears it ----------------------------------------------------------

describe("binding another thread (R5.10)", () => {
  it("clears the old thread's error and its disabled chat", async () => {
    const h = await shown();
    await refuseSend(h, "busy", MESSAGES.busy);
    expect(bannerText()).toContain(MESSAGES.busy);

    // The only way to the list while bound is the thread going away (R5.8); then pick another.
    await h.emit(errorFor(h.lastRpc("subscribe"), "not_found", "gone"));
    await h.emit({ v: 2, kind: "threads", id: "r2", items: [thread("t-b", "Title t-b")] });
    clickable("Title t-b")!.click();
    await h.settle();
    await h.emit(snapshot("t-b", [{ role: "assistant", markdown: "hello from t-b" }]));

    expect(text(), "t-a's error is not shown for t-b").not.toContain(MESSAGES.busy);
    expect(text()).not.toContain(GONE);
    await type(composer()!, "for t-b");
    expect(disabled(composer()), "t-b's chat is enabled").toBe(false);
    expect(disabled(button(/^send$/i))).toBe(false);
  });
});
