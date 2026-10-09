// The picker's selection state (story 033, task 4.2): pure, no DOM, so it is unit-testable.
// Elements are compared by identity: two twins with the same tag and classes stay two.
import { MAX_ITEMS } from "../contract.js";

export type SelectionState = { mode: "off" } | { mode: "picking"; pending: Element[] };
export type ClickResult = { send: Element[] } | { pending: number } | { refused: "limit" };

export function createSelection() {
  let state: SelectionState = { mode: "off" };
  return {
    get state(): SelectionState {
      return state;
    },
    toggle(): void {
      state = state.mode === "off" ? { mode: "picking", pending: [] } : { mode: "off" };
    },
    escape(): void {
      state = { mode: "off" };
    },
    /** A plain click sends one element; Shift+click adds it to, or removes it from, `pending`. */
    click(el: Element, shift: boolean): ClickResult {
      if (state.mode === "off") {
        state = { mode: "picking", pending: [] };
      }
      if (!shift) {
        return { send: [el] };
      }
      const pending = state.pending;
      const at = pending.indexOf(el);
      if (at !== -1) {
        pending.splice(at, 1);
      } else if (pending.length >= MAX_ITEMS) {
        return { refused: "limit" };
      } else {
        pending.push(el);
      }
      return { pending: pending.length };
    },
    /** Takes the pending elements for a Send, leaving the picker on and the selection empty. */
    take(): Element[] {
      if (state.mode === "off") {
        return [];
      }
      const taken = state.pending;
      state = { mode: "picking", pending: [] };
      return taken;
    },
  };
}
export type Selection = ReturnType<typeof createSelection>;
