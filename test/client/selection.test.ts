// Story 033, task 4.2 — the picker's selection state machine (pure, no DOM).
// Requirements: R2.5, R3.1, R3.2, R3.3, R3.4, R3.5.
// Contract (tasks.md 4.2 Objective): states `off | picking{pending: Element[]}`, with
// `toggle()`, `click(el, shift)` → `{ send: Element[] } | { pending: number } |
// { refused: "limit" }`, and `escape()`.
// The Objective names no factory and no state accessor. This test assumes
// `createSelection()` and a `state` of `{ mode: "off" } | { mode: "picking"; pending }`;
// if the module spells them differently, adjust ONLY `make`, `isOn` and `pendingOf`.
//
// Hostile halves first, for "is this the same element?":
//   - wrongly collapse: two DIFFERENT elements with the same tag and classes must stay two
//     pending entries (identity, never structural equality);
//   - wrongly split: Shift+clicking the SAME element again must remove it, not add a copy;
//   - the 20 limit must refuse a 21st element but never block removing one at 20.
import { describe, expect, it } from "vitest";
import { createSelection } from "../../src/client/selection.js";

type Machine = ReturnType<typeof createSelection>;

const make = (): Machine => createSelection();
const isOn = (m: Machine): boolean => m.state.mode === "picking";
const pendingOf = (m: Machine): readonly Element[] =>
  m.state.mode === "picking" ? m.state.pending : [];

/** Structurally identical stand-ins: same tag, same classes, distinct identity. */
const el = (tag = "DIV", className = "card"): Element =>
  ({ tagName: tag, className }) as unknown as Element;

function picking(): Machine {
  const m = make();
  m.toggle();
  expect(isOn(m)).toBe(true);
  return m;
}

describe("toggle and escape (R2.5)", () => {
  it("starts off; toggle turns it on and off", () => {
    const m = make();
    expect(isOn(m)).toBe(false);
    m.toggle();
    expect(isOn(m)).toBe(true);
    m.toggle();
    expect(isOn(m)).toBe(false);
  });

  it("escape turns it off and discards the pending selection", () => {
    const m = picking();
    m.click(el(), true);
    m.click(el(), true);
    expect(pendingOf(m)).toHaveLength(2);
    m.escape();
    expect(isOn(m)).toBe(false);
    m.toggle();
    expect(pendingOf(m)).toHaveLength(0);
    expect(m.click(el(), true)).toEqual({ pending: 1 });
  });
});

describe("plain click (R3.1)", () => {
  it("sends that element and only it, leaving the pending selection untouched", () => {
    const m = picking();
    const a = el();
    const b = el();
    m.click(a, true);
    const result = m.click(b, false);
    expect(result).toEqual({ send: [b] });
    expect((result as { send: Element[] }).send[0]).toBe(b);
    expect(pendingOf(m)).toEqual([a]);
    expect(pendingOf(m)[0]).toBe(a);
  });
});

describe("Shift+click accumulates (R3.2, R3.3, R3.4)", () => {
  it("hostile: two different elements with the same tag and classes stay two entries", () => {
    const m = picking();
    const a = el("DIV", "card");
    const twin = el("DIV", "card");
    expect(m.click(a, true)).toEqual({ pending: 1 });
    expect(m.click(twin, true)).toEqual({ pending: 2 });
    expect(pendingOf(m)[0]).toBe(a);
    expect(pendingOf(m)[1]).toBe(twin);
  });

  it("hostile converse: Shift+clicking the same element again removes it", () => {
    const m = picking();
    const a = el();
    const b = el();
    m.click(a, true);
    m.click(b, true);
    expect(m.click(a, true)).toEqual({ pending: 1 });
    expect(pendingOf(m)).toHaveLength(1);
    expect(pendingOf(m)[0]).toBe(b);
  });

  it("keeps pick order, and a re-added element goes to the end", () => {
    const m = picking();
    const [a, b, c] = [el(), el(), el()];
    m.click(b, true);
    m.click(a, true);
    m.click(c, true);
    expect(pendingOf(m)).toEqual([b, a, c]);
    pendingOf(m).forEach((x, i) => expect(x).toBe([b, a, c][i]));
    m.click(a, true);
    m.click(a, true);
    const order = pendingOf(m);
    expect(order[0]).toBe(b);
    expect(order[1]).toBe(c);
    expect(order[2]).toBe(a);
  });
});

describe("the 20-element limit (R3.5)", () => {
  it("refuses a 21st element and keeps the 20", () => {
    const m = picking();
    const twenty = Array.from({ length: 20 }, () => el());
    twenty.forEach((x, i) => expect(m.click(x, true)).toEqual({ pending: i + 1 }));
    expect(m.click(el(), true)).toEqual({ refused: "limit" });
    expect(pendingOf(m)).toHaveLength(20);
  });

  it("hostile: at 20, Shift+clicking a member still removes it", () => {
    const m = picking();
    const twenty = Array.from({ length: 20 }, () => el());
    twenty.forEach((x) => m.click(x, true));
    expect(m.click(twenty[7]!, true)).toEqual({ pending: 19 });
    expect(pendingOf(m)).not.toContain(twenty[7]);
  });

  it("a plain click at 20 still sends its one element", () => {
    const m = picking();
    Array.from({ length: 20 }, () => el()).forEach((x) => m.click(x, true));
    const extra = el();
    expect(m.click(extra, false)).toEqual({ send: [extra] });
  });
});
