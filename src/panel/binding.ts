// Which thread the panel page is bound to (story 055, design.md §A3, §B6).
//
// A panel opened by Zeo carries `#thread=<id>` (B6): that id wins, is kept in
// `sessionStorage.boundThread` so a reload re-binds, and the fragment is then removed from the
// address with `history.replaceState`, so a copied or bookmarked URL does not carry it. Without a
// fragment, `sessionStorage.boundThread` is the binding. `sessionStorage` is the page's only
// storage, and it holds only that id (design.md §A3).
//
// Both sources are untrusted input: an id is accepted only as 1 to 128 printable ASCII characters
// (no space, no control); anything else is no binding. Storage that throws (disabled, quota) is
// treated as empty.

export const BOUND_KEY = "boundThread";
const THREAD_ID = /^[\x21-\x7e]{1,128}$/;

export const isThreadId = (value: unknown): value is string =>
  typeof value === "string" && THREAD_ID.test(value);

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The id `#thread=<id>` names, or `null`. */
function fragmentThread(hash: string): string | null {
  if (!hash.startsWith("#")) {
    return null;
  }
  try {
    const id = new URLSearchParams(hash.slice(1)).get("thread");
    return isThreadId(id) ? id : null;
  } catch {
    return null;
  }
}

/** Reads the binding, storing a fragment's id and removing the fragment from the address. */
export function takeBinding(win: Pick<Window, "location" | "history">, storage: StorageLike) {
  const { location, history } = win;
  const fromFragment = fragmentThread(location.hash);
  if (location.hash.length > 0) {
    // The fragment goes whatever it held: it is Zeo's one-shot hand-over, not page state.
    history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  }
  if (fromFragment !== null) {
    writeBinding(storage, fromFragment);
    return fromFragment;
  }
  try {
    const stored = storage.getItem(BOUND_KEY);
    return isThreadId(stored) ? stored : null;
  } catch {
    return null;
  }
}

/** Stores the binding, or forgets it with `null`; a storage failure leaves it in memory only. */
export function writeBinding(storage: StorageLike, threadId: string | null): void {
  try {
    if (threadId === null) {
      storage.removeItem(BOUND_KEY);
    } else {
      storage.setItem(BOUND_KEY, threadId);
    }
  } catch {
    // The binding still holds for this page; only a reload loses it.
  }
}
