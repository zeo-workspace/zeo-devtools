// The v2 additions for the devtools panel (story 055, design.md §A5 and §Data Models "Wire
// additions"): the dev-server and panel identities, `create_thread`, `created`, `project_open`,
// `project_closed`, the new error codes, what a panel page may ask for (`panelClientMsg`) and
// what the app inside the iframe may tell it (`appToPanel`).
//
// Zeo's Rust side is the reference: `devtools_bridge::channel` (`check_root`, `is_local_http_url`)
// and `agent_ui::browser_wire` (`ClientInfo`, `ClientMsg`, `ServerMsg`, `ChannelError`). Both read
// the same fixtures under test/contract/v2/, so a shape or a limit changed here must change there.
//
// Parse order is Zeo's: the version first (`unsupported_version` whatever else is wrong), then the
// kind (`unknown_kind`), and only then the shape, strictly (`bad_request`). Nothing here throws.
//
// This module is imported by the panel page and the app bridge as well as by the plugin, so it
// uses no Node API.
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Limits — each one Rust's constant of the same name

export const PROTOCOL_VERSION = 2;
/** A dev-server or panel `root`, in UTF-8 bytes. */
export const MAX_ROOT_BYTES = 4096;
/** A dev server's `app_url` and `panel_url`, in UTF-8 bytes. */
export const MAX_LOCAL_URL_BYTES = 2048;
/** A request `id`, in code points (Rust `char`s). */
export const MAX_ID_CHARS = 64;
/** A `send`'s text, in code points. */
export const MAX_TEXT_CHARS = 100_000;
/** The hosts a dev server's URLs may name, compared ASCII-case-insensitively. */
export const LOCAL_URL_HOSTS = ["localhost", "127.0.0.1", "[::1]"] as const;

/** An `app_location`'s `href`, in UTF-8 bytes; the app bridge drops a longer one. */
export const MAX_APP_HREF_BYTES = 2048;
/** An `app_location`'s `title`, in code points; the app bridge cuts a longer one. */
export const MAX_APP_TITLE_CHARS = 512;

// ---------------------------------------------------------------------------------------------
// Errors and results

/** Every code of `ChannelError`, in Rust's order: 045's, then story 055's three. */
export const CHANNEL_ERRORS = [
  "bad_request",
  "too_large",
  "unsupported_version",
  "unknown_kind",
  "busy",
  "overloaded",
  "not_approved",
  "approval_denied",
  "approval_timeout",
  "approval_unavailable",
  "no_thread",
  "thread_closed",
  "stale_permission",
  "ai_disabled",
  "send_failed",
  "not_found",
  "project_closed",
  "agent_start_failed",
  "oversized_from_zeo",
] as const;
export type ChannelError = (typeof CHANNEL_ERRORS)[number];

/** A verdict instead of a throw. `message` is English and never quotes the input's content. */
export type Result<T, E = ChannelError> =
  { ok: true; value: T } | { ok: false; error: E; message: string };

// ---------------------------------------------------------------------------------------------
// String measures and the raw-string rules

const encoder = new TextEncoder();
const utf8Len = (s: string): number => encoder.encode(s).length;

/** Unicode code points, the unit Rust counts as `char`. */
const codePoints = (s: string): number => [...s].length;

/**
 * A string Zeo can decode: no lone UTF-16 surrogate. `JSON.stringify` writes one as a `\uD800`
 * escape, which serde_json refuses, so Zeo would answer the whole message `bad_request`.
 */
const text = () =>
  z.string().refine((s) => s.isWellFormed(), { message: "contains a lone UTF-16 surrogate" });

const maxChars = (max: number) =>
  text().refine((s) => codePoints(s) <= max, { message: `longer than ${max} characters` });

/** ASCII-only lowercase, as Rust's `eq_ignore_ascii_case`: no Unicode case mapping. */
const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Bytes Rust refuses anywhere in a local URL: ASCII controls, space, `\`, `?` and `#`. */
const isRefusedUrlUnit = (unit: number): boolean =>
  unit <= 0x1f || unit === 0x7f || unit === 0x20 || unit === 0x5c || unit === 0x3f || unit === 0x23;

/** A root Zeo accepts: `/`-prefixed and at most {@link MAX_ROOT_BYTES} UTF-8 bytes. */
export function isAbsoluteRoot(root: string): boolean {
  return root.startsWith("/") && utf8Len(root) <= MAX_ROOT_BYTES;
}

/**
 * Rust's `is_local_http_url`, on the raw string (GOTCHA G14) — never through `new URL(...)`, which
 * accepts an empty `?` or `#`, port 0, a tab and a backslash, and drops an explicit `:80`.
 *
 * `http://` (scheme compared ASCII-case-insensitively), then an authority up to the first `/`
 * whose last `:` splits it into a host in {@link LOCAL_URL_HOSTS} and a port of digits only in
 * 1-65535, then an empty path or one starting with `/`. Userinfo stays in the compared host, so it
 * never matches. At most {@link MAX_LOCAL_URL_BYTES} UTF-8 bytes.
 */
export function isLocalHttpUrl(url: string): boolean {
  if (utf8Len(url) > MAX_LOCAL_URL_BYTES) {
    return false;
  }
  for (let i = 0; i < url.length; i++) {
    if (isRefusedUrlUnit(url.charCodeAt(i))) {
      return false;
    }
  }
  const scheme = "http://";
  if (asciiLower(url.slice(0, scheme.length)) !== scheme) {
    return false;
  }
  const rest = url.slice(scheme.length);
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const colon = authority.lastIndexOf(":");
  if (colon === -1) {
    return false;
  }
  const host = asciiLower(authority.slice(0, colon));
  const port = authority.slice(colon + 1);
  if (!/^[0-9]+$/.test(port)) {
    return false;
  }
  // Leading zeros are fine, as for `u16::from_str`; the value is what is bounded.
  const value = Number(port);
  return value >= 1 && value <= 65535 && (LOCAL_URL_HOSTS as readonly string[]).includes(host);
}

const root = text().refine(isAbsoluteRoot, {
  message: `root is an absolute path <= ${MAX_ROOT_BYTES} bytes`,
});

const localUrl = text().refine(isLocalHttpUrl, {
  message: `http:// on localhost, 127.0.0.1 or [::1] with a port, no userinfo, query or fragment, <= ${MAX_LOCAL_URL_BYTES} bytes`,
});

const requestId = maxChars(MAX_ID_CHARS);
const v2 = z.literal(PROTOCOL_VERSION);

// ---------------------------------------------------------------------------------------------
// hello — three identities (R2.1, GOTCHA G12)

const helloEnvelope = { v: v2, kind: z.literal("hello"), id: requestId.optional() };

/** The announce session of a dev server running this plugin. */
export const helloDevServer = z.strictObject({
  ...helloEnvelope,
  client: z.strictObject({
    kind: z.literal("dev_server"),
    root,
    app_url: localUrl,
    panel_url: localUrl,
  }),
});
export type HelloDevServer = z.infer<typeof helloDevServer>;

/** One open panel page. */
export const helloPanel = z.strictObject({
  ...helloEnvelope,
  client: z.strictObject({ kind: z.literal("panel"), root }),
});
export type HelloPanel = z.infer<typeof helloPanel>;

/**
 * 045's extension. Its `client` carries no `kind` — installed extensions never send one, and
 * Zeo still reads such a hello as `extension` (GOTCHA G12) — or `kind: "extension"` exactly.
 */
export const helloExtension = z.strictObject({
  ...helloEnvelope,
  client: z.strictObject({
    kind: z.literal("extension").optional(),
    browser: z.enum(["chrome", "chromium", "firefox", "unknown"]),
    extension_id: text(),
    extension_version: text(),
  }),
});
export type HelloExtension = z.infer<typeof helloExtension>;

export const hello = z.union([helloDevServer, helloPanel, helloExtension]);
export type Hello = z.infer<typeof hello>;

/** Each identity's schema by its client `kind`; a `client` without one is an extension (G12). */
const HELLO_BY_CLIENT_KIND = new Map<unknown, z.ZodType<Hello>>([
  ["dev_server", helloDevServer],
  ["panel", helloPanel],
  ["extension", helloExtension],
]);

/** The one identity a hello claims, so a refusal names the broken field, not "no union member". */
function helloSchemaFor(obj: Record<string, unknown>): z.ZodType<Hello> {
  const client = obj.client;
  if (typeof client !== "object" || client === null || !Object.hasOwn(client, "kind")) {
    return helloExtension;
  }
  return HELLO_BY_CLIENT_KIND.get((client as Record<string, unknown>).kind) ?? hello;
}

// ---------------------------------------------------------------------------------------------
// Client requests

/** A panel session's request for a new devtools thread in its own root (R5.1). */
export const createThread = z.strictObject({
  v: v2,
  kind: z.literal("create_thread"),
  id: requestId,
});
export type CreateThread = z.infer<typeof createThread>;

/**
 * What a panel page may ask for through `POST /api/rpc` — six kinds and nothing else: no `hello`
 * (a panel cannot pick its identity), no `open_in_zeo` (R7.5), no follow target (R5.7).
 *
 * The page sends them bare; the `v`/`id` envelope of the wire is accepted too, because the panel
 * server adds it before forwarding. `subscribe` names its thread as `thread_id` (the panel API)
 * or as the wire's `target: { thread_id }` — exactly one of the two.
 */
const panelEnvelope = { v: v2.optional(), id: requestId.optional() };

const panelSchemas = {
  list_threads: z.strictObject({ ...panelEnvelope, kind: z.literal("list_threads") }),
  create_thread: z.strictObject({ ...panelEnvelope, kind: z.literal("create_thread") }),
  subscribe: z
    .strictObject({
      ...panelEnvelope,
      kind: z.literal("subscribe"),
      thread_id: text().optional(),
      target: z.strictObject({ thread_id: text() }).optional(),
    })
    .refine((m) => (m.thread_id === undefined) !== (m.target === undefined), {
      message: "subscribe names its thread as thread_id or target.thread_id, exactly one",
    }),
  send: z.strictObject({
    ...panelEnvelope,
    kind: z.literal("send"),
    text: maxChars(MAX_TEXT_CHARS),
    // The panel attaches nothing in this story; element and image attachments arrive with the
    // selection stories (054, 056, 057), which widen this.
    attachments: z.tuple([]),
  }),
  cancel: z.strictObject({ ...panelEnvelope, kind: z.literal("cancel") }),
  authorize: z.strictObject({
    ...panelEnvelope,
    kind: z.literal("authorize"),
    request_id: text(),
    option_id: text(),
  }),
};

export const panelClientMsg = z.discriminatedUnion("kind", [
  panelSchemas.list_threads,
  panelSchemas.create_thread,
  panelSchemas.subscribe,
  panelSchemas.send,
  panelSchemas.cancel,
  panelSchemas.authorize,
]);
export type PanelKind = keyof typeof panelSchemas;
export const PANEL_KINDS = Object.keys(panelSchemas) as PanelKind[];
/** One panel request; `PanelClientMsg<"send">` narrows it to a kind. */
export type PanelClientMsg<K extends PanelKind = PanelKind> = Extract<
  z.infer<typeof panelClientMsg>,
  { kind: K }
>;

// ---------------------------------------------------------------------------------------------
// Server messages this plugin reads (Zeo → plugin). The thread stream of 045 (`threads`,
// `snapshot`, `entry_*`, `status`, …) is relayed to the panel page as it comes.

const STATES = ["idle", "working", "awaiting_permission", "error"] as const;

/** 045's `ThreadInfo`, unchanged. */
export const threadInfo = z.strictObject({
  thread_id: z.string(),
  title: z.string(),
  project: z.string(),
  agent: z.string(),
  status: z.enum(STATES),
  followed: z.boolean(),
});
export type ThreadInfo = z.infer<typeof threadInfo>;

const serverSchemas = {
  welcome: z.strictObject({
    v: v2,
    kind: z.literal("welcome"),
    id: requestId.optional(),
    // 2 today; any other number is a valid shape that the session reads as a version mismatch.
    protocol: z.int(),
    zeo_version: z.string(),
  }),
  /** The answer to `create_thread`, once the thread's agent connection is ready; `id` echoes it. */
  created: z.strictObject({ v: v2, kind: z.literal("created"), id: requestId, thread: threadInfo }),
  /** The session's project is open in a Zeo window (R7.3). */
  project_open: z.strictObject({ v: v2, kind: z.literal("project_open") }),
  /** The session's project is open in no Zeo window (R2.3, R7.1). */
  project_closed: z.strictObject({ v: v2, kind: z.literal("project_closed") }),
  error: z.strictObject({
    v: v2,
    kind: z.literal("error"),
    id: requestId.optional(),
    error: z.enum(CHANNEL_ERRORS),
    message: z.string(),
    fatal: z.boolean(),
  }),
};

export const welcome = serverSchemas.welcome;
export const created = serverSchemas.created;
export const projectOpen = serverSchemas.project_open;
export const projectClosed = serverSchemas.project_closed;
/** The v2 `error` message, with every code of {@link CHANNEL_ERRORS}. */
export const v2Error = serverSchemas.error;

export const serverMsgV2 = z.discriminatedUnion("kind", [
  serverSchemas.welcome,
  serverSchemas.created,
  serverSchemas.project_open,
  serverSchemas.project_closed,
  serverSchemas.error,
]);
export type ServerKindV2 = keyof typeof serverSchemas;
export const SERVER_KINDS_V2 = Object.keys(serverSchemas) as ServerKindV2[];
/** One server message this plugin reads; `ServerMsgV2<"created">` narrows it to a kind. */
export type ServerMsgV2<K extends ServerKindV2 = ServerKindV2> = Extract<
  z.infer<typeof serverMsgV2>,
  { kind: K }
>;

// ---------------------------------------------------------------------------------------------
// App → panel (postMessage from the app bridge) — data only (R3.5, R3.6)

const appHref = text()
  .refine((h) => utf8Len(h) <= MAX_APP_HREF_BYTES, {
    message: `href longer than ${MAX_APP_HREF_BYTES} bytes`,
  })
  .refine((h) => /^https?:\/\//i.test(h), { message: "href is http: or https:" });

const appSchemas = {
  /** Where the app is, so the panel can show it. */
  app_location: z.strictObject({
    kind: z.literal("app_location"),
    href: appHref,
    title: maxChars(MAX_APP_TITLE_CHARS),
  }),
};

/** No kind here maps to a thread action, and none ever may (R3.6). */
export const appToPanel = z.discriminatedUnion("kind", [appSchemas.app_location]);
export type AppKind = keyof typeof appSchemas;
export type AppToPanel = z.infer<typeof appToPanel>;

// ---------------------------------------------------------------------------------------------
// Parsing

type Fail = { ok: false; error: ChannelError; message: string };
const fail = (error: ChannelError, message: string): Fail => ({ ok: false, error, message });

/** A JSON string is decoded first; anything that is not then a plain object is `null`. */
function asObject(raw: unknown): Record<string, unknown> | null {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** The first issue's path, never its input: a message must not quote what it refuses. */
function shapeFailure(error: z.ZodError): Fail {
  const first = error.issues[0];
  const where = first && first.path.length > 0 ? first.path.join(".") : "message";
  return fail("bad_request", `Invalid message at ${where}: ${first?.message ?? "malformed"}`);
}

/**
 * The version → kind → shape pipeline. With `versioned`, a missing `v` is `bad_request` and any
 * other value than 2 is `unsupported_version`, as in Zeo's `parse_client`; without it (the panel
 * API and postMessage, which carry no version) only the kind and the shape are read.
 */
function parseMessage<T>(
  raw: unknown,
  kinds: readonly string[],
  schema: z.ZodType<T> | ((obj: Record<string, unknown>) => z.ZodType<T>),
  versioned: boolean,
): Result<T> {
  try {
    const obj = asObject(raw);
    if (obj === null) {
      return fail("bad_request", "A message must be a JSON object");
    }
    if (versioned) {
      if (!Object.hasOwn(obj, "v")) {
        return fail("bad_request", "The message has no protocol version");
      }
      if (obj.v !== PROTOCOL_VERSION) {
        return fail(
          "unsupported_version",
          `Unsupported protocol version; this plugin speaks version ${PROTOCOL_VERSION}`,
        );
      }
    }
    if (typeof obj.kind !== "string") {
      return fail("bad_request", "The message has no kind");
    }
    if (!kinds.includes(obj.kind)) {
      return fail("unknown_kind", "Unknown message kind");
    }
    const result = (typeof schema === "function" ? schema(obj) : schema).safeParse(obj);
    return result.success ? { ok: true, value: result.data } : shapeFailure(result.error);
  } catch {
    // A hand-built object (a cycle, a BigInt) can make a refinement throw; JSON input cannot.
    return fail("bad_request", "The message cannot be validated");
  }
}

/** Validates a `hello` this plugin is about to send, or one read off the wire. */
export function parseHello(raw: unknown): Result<Hello> {
  return parseMessage(raw, ["hello"], helloSchemaFor, true);
}

/** Validates a `create_thread` in its wire form (`v` and `id` required). */
export function parseCreateThread(raw: unknown): Result<CreateThread> {
  return parseMessage(raw, ["create_thread"], createThread, true);
}

/** Validates the `msg` of a `POST /api/rpc`, bare or in the wire envelope. */
export function parsePanelClientMsg(raw: unknown): Result<PanelClientMsg> {
  return parseMessage(raw, PANEL_KINDS, panelClientMsg, false);
}

/** Validates a message from Zeo of a kind this plugin reads itself. */
export function parseServerV2(raw: unknown): Result<ServerMsgV2> {
  return parseMessage(raw, SERVER_KINDS_V2, serverMsgV2, true);
}

/** Validates a `postMessage` payload from the app bridge. */
export function parseAppToPanel(raw: unknown): Result<AppToPanel> {
  return parseMessage(raw, Object.keys(appSchemas), appToPanel, false);
}
