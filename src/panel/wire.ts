// What the panel page reads off its event stream (story 055, design.md §A1 "Panel API"): the
// panel server's own `connection` event, and the Zeo messages it relays unchanged by kind.
//
// The thread-stream shapes (`snapshot`, `entry_*`, `status`, `permission_*`, …) are 045's, moved
// from zeo-browser/src/contract.ts (D6); the v2 additions (`created`, `project_*`, `error` with
// 055's codes, `welcome`) come from contract-v2.ts, the one copy the Rust agreement test reads.
// Every event is parsed strictly before the view sees it: the stream is external data, and a
// message that does not parse is dropped and logged by kind, never by content. Nothing throws.
import "./zod-jitless.js";
import { z } from "zod";
import {
  created,
  MAX_ID_CHARS,
  PROTOCOL_VERSION,
  projectClosed,
  projectOpen,
  threadInfo,
  v2Error,
  welcome,
} from "../contract-v2.js";

/** The most threads one `threads` answer lists (Zeo's cap, as in 045). */
export const MAX_THREADS = 50;
/** The most entries one `snapshot` carries (Zeo's cap, as in 045). */
export const MAX_SNAPSHOT_ENTRIES = 100;

const v2 = z.literal(PROTOCOL_VERSION);
const requestId = z.string().max(MAX_ID_CHARS);
const index = z.int().min(0);

const STATES = ["idle", "working", "awaiting_permission", "error"] as const;

const status = z.strictObject({ state: z.enum(STATES), message: z.string().nullable() });
export type Status = z.infer<typeof status>;

// `markdown` is not capped: Zeo truncates past its own limit and appends a note, and the panel
// server's frame cap bounds the line anyway.
const entry = z.strictObject({
  role: z.enum(["user", "assistant", "tool", "question", "compaction"]),
  markdown: z.string(),
  truncated: z.boolean(),
  tool: z
    .strictObject({
      title: z.string(),
      status: z.enum([
        "pending",
        "in_progress",
        "completed",
        "failed",
        "canceled",
        "awaiting_permission",
      ]),
    })
    .optional(),
});
export type Entry = z.infer<typeof entry>;

const permission = z.strictObject({
  request_id: z.string(),
  entry_index: index,
  title: z.string(),
  options: z.array(
    z.strictObject({
      option_id: z.string(),
      label: z.string(),
      kind: z.enum(["allow_once", "allow_always", "reject_once", "reject_always"]),
    }),
  ),
});
export type Permission = z.infer<typeof permission>;

export type ThreadInfo = z.infer<typeof threadInfo>;

const eventSchemas = {
  /** The panel server's state of this panel's Zeo session (not a Zeo message). */
  connection: z.strictObject({ state: z.enum(["connecting", "open", "zeo_too_old"]) }),
  welcome,
  threads: z.strictObject({
    v: v2,
    kind: z.literal("threads"),
    id: requestId,
    items: z.array(threadInfo).max(MAX_THREADS),
  }),
  snapshot: z.strictObject({
    v: v2,
    kind: z.literal("snapshot"),
    id: requestId.optional(),
    thread: threadInfo.nullable(),
    earlier: index,
    entries: z.array(entry).max(MAX_SNAPSHOT_ENTRIES),
    status,
    permissions: z.array(permission),
  }),
  entry_added: z.strictObject({ v: v2, kind: z.literal("entry_added"), index, entry }),
  entry_updated: z.strictObject({ v: v2, kind: z.literal("entry_updated"), index, entry }),
  entries_removed: z.strictObject({
    v: v2,
    kind: z.literal("entries_removed"),
    start: index,
    end: index,
  }),
  status: z.strictObject({ v: v2, kind: z.literal("status"), status }),
  title: z.strictObject({ v: v2, kind: z.literal("title"), title: z.string() }),
  permission_requested: z.strictObject({
    v: v2,
    kind: z.literal("permission_requested"),
    permission,
  }),
  permission_resolved: z.strictObject({
    v: v2,
    kind: z.literal("permission_resolved"),
    request_id: z.string(),
  }),
  thread_closed: z.strictObject({ v: v2, kind: z.literal("thread_closed") }),
  sent: z.strictObject({
    v: v2,
    kind: z.literal("sent"),
    id: requestId,
    queued: z.boolean(),
    images: z.enum(["included", "skipped_unsupported", "none"]),
  }),
  ok: z.strictObject({ v: v2, kind: z.literal("ok"), id: requestId }),
  created,
  project_open: projectOpen,
  project_closed: projectClosed,
  error: v2Error,
};

export type EventKind = keyof typeof eventSchemas;
/** Every SSE event name the page listens for. */
export const EVENT_KINDS = Object.keys(eventSchemas) as EventKind[];
/** One parsed stream event; `PanelEvent<"snapshot">` narrows it to a kind. */
export type PanelEvent<K extends EventKind = EventKind> = z.infer<(typeof eventSchemas)[K]>;
/** A parsed event with its kind beside it, so a `switch` narrows both. */
export type TaggedEvent = { [K in EventKind]: { kind: K; data: PanelEvent<K> } }[EventKind];

/**
 * One SSE event's `data`, parsed against its event name. `null` when it is not JSON or does not
 * match; the reason is the first issue's path only — never the content.
 */
export function parseEvent(
  kind: EventKind,
  raw: string,
): { ok: true; event: TaggedEvent } | { ok: false; reason: string } {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  try {
    const result = eventSchemas[kind].safeParse(value);
    if (!result.success) {
      const first = result.error.issues[0];
      return { ok: false, reason: first?.path.join(".") || "shape" };
    }
    return { ok: true, event: { kind, data: result.data } as TaggedEvent };
  } catch {
    return { ok: false, reason: "unvalidatable" };
  }
}
