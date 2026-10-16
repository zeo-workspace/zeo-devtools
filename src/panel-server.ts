// The panel server (story 055, design.md §A1): serves the panel page and its API on the app's own
// hostname at another port (GOTCHA G1), and holds one Zeo panel session per open panel page.
//
// The API is reachable only by the panel page itself. Every `/api/*` request passes three checks,
// in this order, before anything else reads it (R3.3):
//   1. `Host` is exactly the panel's `host:port` — a DNS-rebinding name, another host for the
//      same machine or the app's port are refused (`reason=host`);
//   2. `Origin`, when present, is exactly the panel's origin, and a `POST` must carry it — a same-
//      origin `GET` (the page's EventSource) sends none (GOTCHA G3) (`reason=origin`);
//   3. `Sec-Fetch-Site` is `same-origin` (`reason=fetch_site`).
// A failure answers 403 and logs one `zeo-devtools event=panel_refused reason=…` line that never
// echoes a header value. The page routes (`/`, `/assets/*`) are checked for `Host` only: a typed
// URL arrives with `Sec-Fetch-Site: none` and no `Origin`.
//
// A `POST` must also say `Content-Type: application/json` — a CORS "simple request" cannot, so a
// foreign page is forced into a preflight this server never approves — and its body is at most
// 8 MiB of UTF-8 JSON. Every response carries the CSP, `X-Frame-Options: DENY`, `nosniff` and
// `no-referrer` headers (R3.4).
//
// Panels: `POST /api/panels` opens a Zeo session (`hello { client: { kind: "panel", root } }`)
// and answers its random id. `GET /api/events?panel=<id>` is that panel's Server-Sent Events
// stream: `event: connection` with the session state once on connect and on every change, a `:`
// heartbeat every 15 s (GOTCHA G4). When the stream closes, the panel's Zeo session is closed and
// the panel forgotten, so sessions never leak toward Zeo's cap. `POST /api/rpc` answers
// `503 { error: "zeo_unreachable" }` while the session is not open and queues nothing (R6.8).
//
// Logs are `key=value` lines naming the root, never message text, header values or panel ids
// (R9.1, R9.2). No handler throws past its own catch: a failure answers, and the server keeps
// serving the page (R9.3).
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { basename, dirname, extname, resolve as resolvePath, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  isAbsoluteRoot,
  isLocalHttpUrl,
  parsePanelClientMsg,
  PROTOCOL_VERSION,
  type Hello,
  type PanelClientMsg,
} from "./contract-v2.js";
import {
  logValue,
  MAX_FRAME_BYTES,
  openSession,
  type ServerMessage,
  type Session,
  type SessionLogger,
  type SessionState,
} from "./session.js";
import { resolveSocketPath } from "./socket.js";

/**
 * Live panels at once. Zeo holds at most 8 devtools sessions, shared with this dev server's
 * announce session and the browser extension, and drops a 5th simultaneous connection that has
 * not said hello yet. A 9th panel would retry forever and crowd those out, so a panel past this
 * many is refused (`503 too_many_panels`) and opens no session; closing a panel frees its place.
 */
export const MAX_LIVE_PANELS = 4;
/** The largest `POST` body accepted, in bytes: one Zeo frame. */
export const MAX_BODY_BYTES = MAX_FRAME_BYTES;
/** Interval of the SSE heartbeat comment (GOTCHA G4). */
export const HEARTBEAT_MS = 15_000;
/**
 * How long a panel may hold a Zeo session without opening its event stream. A page that died
 * between `POST /api/panels` and its `EventSource` would otherwise hold a session forever.
 */
export const UNCLAIMED_PANEL_MS = 30_000;
/**
 * How long a panel that Zeo ended with a fatal error, before its page opened the stream, waits
 * for that stream: a page connecting in time still reads why (`connection`, then the error).
 */
export const FATAL_GRACE_MS = 5_000;
/** How many recent `subscribe` wire ids a panel maps back to the page's own ids. */
const SUBSCRIBE_IDS_KEPT = 8;
/**
 * Bytes an SSE stream may have queued unsent before it is dropped. A page that stopped reading
 * would otherwise make the server buffer every message of its session; the page recovers by
 * opening a new panel (design.md §A3).
 */
export const MAX_STREAM_BACKLOG_BYTES = 4 * MAX_FRAME_BYTES;

export interface PanelServerOptions {
  /** The app's hostname, as in its URL: `localhost`, `127.0.0.1` or `[::1]` (GOTCHA G1). */
  host: string;
  /** The port to listen on; a free one when absent or 0. */
  port?: number;
  /** The app's URL, framed by the page and allowed by the CSP's `frame-src`. */
  appUrl: string;
  /** The project root, said in every panel hello. */
  root: string;
  /** Zeo's socket; else `$ZEO_DEVTOOLS_SOCKET`, else `$XDG_RUNTIME_DIR/zeo/devtools.sock`. */
  zeo: { socketPath?: string };
  /** Where the lines go; Vite's logger in the plugin, the console otherwise. */
  logger?: SessionLogger;
  /** The built page (`index.html` and `assets/`); `dist/panel/` by default. */
  pageDir?: string;
}

export interface PanelServer {
  /** The page's URL, `http://<host>:<port>/`. */
  url: string;
  /** Ends every event stream and Zeo session, then frees the port. */
  close(): Promise<void>;
}

/** One open panel page and its Zeo session. */
interface Panel {
  readonly session: Session;
  /** The page's event stream, once it is open; one per panel. */
  stream: ServerResponse | undefined;
  /** Closes the panel when its stream is not opened in time. */
  unclaimed: ReturnType<typeof setTimeout> | undefined;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  /** SSE frames from Zeo that arrived before the stream opened, sent first when it does. */
  pending: string[];
  pendingBytes: number;
  /** The wire `id` of the last `subscribe` forwarded, to recognise Zeo's `not_found` for it. */
  subscribeId: string | undefined;
  /**
   * Recent `subscribe` wire ids (the bridge's own, never the page's) and the page's id each stands
   * for, oldest first; Zeo's answers carrying one get the page's id back.
   */
  subscribeIds: Map<string, string | undefined>;
  /** Ended by a fatal error before its stream opened: only that error is left to deliver. */
  held: boolean;
  closed: boolean;
}

type RefusalReason = "host" | "origin" | "fetch_site";

/** Every route, named for the logs: a request path is never logged. */
type Route = "page" | "assets" | "config" | "panels" | "events" | "rpc" | "api_other" | "other";

const consoleLogger: SessionLogger = {
  info: (msg) => console.info(msg),
  warn: (msg) => console.warn(msg),
};

/** The session states a page is told about; `closed` is the end of the stream itself. */
const CONNECTION_STATES: ReadonlySet<SessionState> = new Set(["connecting", "open", "zeo_too_old"]);

/** An SSE event name that cannot break the stream's framing. */
const SSE_EVENT_NAME = /^[a-z][a-z0-9_]*$/;

/**
 * The server messages a panel page receives, by kind (design.md §Data Models "Panel API", with
 * 0058's answers `sent` and `ok` to the page's own `send`, `cancel` and `authorize`). Anything
 * else is dropped: `open` and `message` would fire the page's `EventSource` `onopen` and
 * `onmessage`, `connection` is this server's own state event, and the follow mode
 * (`target_changed`), the extension's approval (`approval_pending`) and the native host's
 * `bridge_*` messages are never a panel's.
 */
const RELAYED_KINDS: ReadonlySet<string> = new Set([
  "welcome",
  "threads",
  "snapshot",
  "entry_added",
  "entry_updated",
  "entries_removed",
  "status",
  "title",
  "permission_requested",
  "permission_resolved",
  "thread_closed",
  "sent",
  "ok",
  "created",
  "project_open",
  "project_closed",
  "error",
]);

/** `POST /api/panels` takes an empty object and nothing else. */
const panelsBody = z.strictObject({});
/** `POST /api/rpc`: the panel id and the message, validated on its own with the contract. */
const rpcBody = z.strictObject({ panel: z.string().max(64), msg: z.unknown() });

const PAGE_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** `dist/panel/` beside the built module; from source, the same directory of the build. */
function defaultPageDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "dist"
    ? resolvePath(here, "panel")
    : resolvePath(here, "../dist/panel");
}

/** `[::1]` is how a URL and a `Host` header write it; `listen` wants the bare address. */
const listenAddress = (urlHost: string) => urlHost.replace(/^\[(.*)\]$/, "$1");

/** The `scheme://authority` of a URL already checked by `isLocalHttpUrl`, from the raw string. */
function rawOrigin(url: string): { origin: string; host: string } {
  const scheme = "http://";
  const rest = url.slice(scheme.length);
  const slash = rest.indexOf("/");
  const authority = (slash === -1 ? rest : rest.slice(0, slash)).toLowerCase();
  return { origin: `${scheme}${authority}`, host: authority.slice(0, authority.lastIndexOf(":")) };
}

/** The headers of every response, Node's own error answers included (R3.4). */
const securityHeaders = (csp: string): ReadonlyArray<readonly [string, string]> => [
  ["Content-Security-Policy", csp],
  ["X-Frame-Options", "DENY"],
  ["X-Content-Type-Options", "nosniff"],
  ["Referrer-Policy", "no-referrer"],
];

/** The status Node itself would answer to a request it could not parse. */
const clientErrorStatus = (err: NodeJS.ErrnoException): [number, string] =>
  err.code === "HPE_HEADER_OVERFLOW"
    ? [431, "Request Header Fields Too Large"]
    : err.code === "ERR_HTTP_REQUEST_TIMEOUT"
      ? [408, "Request Timeout"]
      : [400, "Bad Request"];

/** The CSP of every response: the page frames the app and nothing else, and is framed by none. */
const contentSecurityPolicy = (appOrigin: string) =>
  [
    "default-src 'self'",
    `frame-src ${appOrigin}`,
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");

/**
 * One request header as a single string. The server joins duplicates (`joinDuplicateHeaders`),
 * `Host` included, so a repeated header arrives comma-joined and never equals the one value a
 * check expects.
 */
const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

function routeOf(path: string): Route {
  if (path === "/") {
    return "page";
  }
  if (path.startsWith("/assets/")) {
    return "assets";
  }
  switch (path) {
    case "/api/config":
      return "config";
    case "/api/panels":
      return "panels";
    case "/api/events":
      return "events";
    case "/api/rpc":
      return "rpc";
  }
  return path === "/api" || path.startsWith("/api/") ? "api_other" : "other";
}

const isApi = (route: Route) =>
  route === "config" ||
  route === "panels" ||
  route === "events" ||
  route === "rpc" ||
  route === "api_other";

/** The only methods each route answers; anything else is 405. */
const ALLOWED: Record<Route, readonly string[]> = {
  page: ["GET", "HEAD"],
  assets: ["GET", "HEAD"],
  config: ["GET"],
  panels: ["POST"],
  events: ["GET"],
  rpc: ["POST"],
  api_other: [],
  other: [],
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** `true` when the request says its body is JSON, with or without parameters. */
const isJsonContentType = (value: string | undefined) =>
  value !== undefined && value.split(";", 1)[0]!.trim().toLowerCase() === "application/json";

type BodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

/**
 * Reads a JSON body of at most {@link MAX_BODY_BYTES}. Too large answers 413 and stops counting;
 * a client that went away answers `status: 0`, which the caller does not answer at all.
 */
function readJsonBody(req: IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      resolve({ ok: false, status: 413, error: "body_too_large" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (result: BodyResult) => {
      if (!done) {
        done = true;
        resolve(result);
      }
    };
    req.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        finish({ ok: false, status: 413, error: "body_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      let text: string;
      try {
        text = utf8.decode(Buffer.concat(chunks));
      } catch {
        finish({ ok: false, status: 400, error: "bad_json" });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) as unknown });
      } catch {
        finish({ ok: false, status: 400, error: "bad_json" });
      }
    });
    req.on("error", () => finish({ ok: false, status: 0, error: "aborted" }));
    req.on("close", () => finish({ ok: false, status: 0, error: "aborted" }));
  });
}

/**
 * One SSE event, `event: <name>` and one `data:` line of JSON (which never holds a raw newline),
 * or `undefined` when the name could break the framing or the data is not JSON.
 */
function sseFrame(event: string, data: unknown): string | undefined {
  if (!SSE_EVENT_NAME.test(event)) {
    return undefined;
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(data);
  } catch {
    return undefined;
  }
  return json === undefined ? undefined : `event: ${event}\ndata: ${json}\n\n`;
}

/** Writes one frame, answering `false` when the stream is gone. */
function writeFrame(res: ServerResponse, frame: string): boolean {
  if (res.writableEnded || res.destroyed) {
    return false;
  }
  res.write(frame);
  return true;
}

/** Writes one SSE event; see {@link sseFrame} and {@link writeFrame}. */
function writeEvent(res: ServerResponse, event: string, data: unknown): boolean {
  const frame = sseFrame(event, data);
  return frame !== undefined && writeFrame(res, frame);
}

/** An error code from Zeo as it may appear in a log line; anything else is `other`. */
const errorCode = (value: unknown): string =>
  typeof value === "string" && /^[a-z_]{1,32}$/.test(value) ? value : "other";

/** The wire form (0058) of a panel request: `v`, an `id`, and `subscribe` by `target`. */
function toWire(msg: PanelClientMsg, id: string): Record<string, unknown> {
  if (msg.kind === "subscribe") {
    const target = msg.target ?? { thread_id: msg.thread_id ?? "" };
    return { v: PROTOCOL_VERSION, kind: "subscribe", id, target };
  }
  // The page's own `v` and `id`, when it sent them, are replaced by the ones that go out.
  return { ...msg, v: PROTOCOL_VERSION, id };
}

/** Throws when the options cannot describe a panel for this app; the plugin reports it. */
function checkOptions(options: PanelServerOptions): { urlHost: string; appOrigin: string } {
  const urlHost = options.host.toLowerCase();
  if (!["localhost", "127.0.0.1", "[::1]"].includes(urlHost)) {
    throw new Error(`The panel's host must be localhost, 127.0.0.1 or [::1], not ${options.host}`);
  }
  if (!isLocalHttpUrl(options.appUrl)) {
    throw new Error(`The app URL is not a local http URL with a port: ${options.appUrl}`);
  }
  const app = rawOrigin(options.appUrl);
  if (app.host !== urlHost) {
    // GOTCHA G1: another hostname is another site, and the app's cookies break in the iframe.
    throw new Error(`The panel's host ${options.host} is not the app's (${options.appUrl})`);
  }
  if (!isAbsoluteRoot(options.root)) {
    throw new Error(`The project root must be an absolute path: ${options.root}`);
  }
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`The panel port must be an integer from 0 to 65535, not ${String(port)}`);
  }
  return { urlHost, appOrigin: app.origin };
}

function listen(server: Server, port: number, address: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      reject(new Error(`The panel server cannot listen on ${address}:${port}`, { cause: err }));
    };
    server.once("error", onError);
    server.listen(port, address, () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/**
 * Starts the panel server on `host` (the app's hostname, GOTCHA G1) at `port`, or at a free port.
 * Rejects when the options are not a local app's or the port cannot be bound; once it resolves,
 * nothing it does throws.
 */
export async function startPanelServer(options: PanelServerOptions): Promise<PanelServer> {
  const logger = options.logger ?? consoleLogger;
  const { urlHost, appOrigin } = checkOptions(options);
  const socket = resolveSocketPath(options.zeo.socketPath);
  if (!socket.ok) {
    throw new Error(`The panel server cannot reach Zeo: ${socket.message}`);
  }
  const socketPath = socket.path;
  const { root, appUrl } = options;
  const pageDir = resolvePath(options.pageDir ?? defaultPageDir());
  const assetsDir = resolvePath(pageDir, "assets");
  const csp = contentSecurityPolicy(appOrigin);
  const rootField = `root=${logValue(root)}`;
  const panels = new Map<string, Panel>();
  /** Set once the port is known; until then no request can have arrived. */
  let expectedHost = "";
  let panelOrigin = "";

  const refuse = (res: ServerResponse, reason: RefusalReason, route: Route) => {
    logger.warn(`zeo-devtools event=panel_refused reason=${reason} route=${route} ${rootField}`);
    sendJson(res, 403, { error: "forbidden" });
  };

  /** The three checks of every API request, in order; answers the refusal when one fails. */
  const passesApiChecks = (req: IncomingMessage, res: ServerResponse, route: Route): boolean => {
    const origin = header(req, "origin");
    if (origin === undefined ? req.method === "POST" : origin !== panelOrigin) {
      refuse(res, "origin", route);
      return false;
    }
    if (header(req, "sec-fetch-site") !== "same-origin") {
      refuse(res, "fetch_site", route);
      return false;
    }
    return true;
  };

  const closePanel = (id: string, panel: Panel) => {
    if (panel.closed) {
      return;
    }
    panel.closed = true;
    panels.delete(id);
    clearTimeout(panel.unclaimed);
    clearInterval(panel.heartbeat);
    panel.session.close();
    const stream = panel.stream;
    if (stream !== undefined && !stream.writableEnded && !stream.destroyed) {
      stream.end();
    }
  };

  const openPanel = (): string => {
    const id = randomUUID();
    const hello: Hello = {
      v: PROTOCOL_VERSION,
      kind: "hello",
      id: "panel",
      client: { kind: "panel", root },
    };
    const panel: Panel = {
      session: openSession(socketPath, hello, { logger }),
      stream: undefined,
      unclaimed: undefined,
      heartbeat: undefined,
      pending: [],
      pendingBytes: 0,
      subscribeId: undefined,
      subscribeIds: new Map(),
      held: false,
      closed: false,
    };
    panel.unclaimed = setTimeout(() => {
      logger.info(`zeo-devtools event=panel_closed reason=unclaimed ${rootField}`);
      closePanel(id, panel);
    }, UNCLAIMED_PANEL_MS);
    panel.unclaimed.unref();
    panel.session.onState((state) => {
      if (panel.stream !== undefined && CONNECTION_STATES.has(state)) {
        writeEvent(panel.stream, "connection", { state });
      }
    });
    panel.session.on("*", (msg) => relay(id, panel, msg));
    panels.set(id, panel);
    return id;
  };

  /** Sends one frame to the page, or keeps it until the page opens its stream. */
  const deliver = (id: string, panel: Panel, frame: string) => {
    let queued: number;
    if (panel.stream !== undefined) {
      writeFrame(panel.stream, frame);
      queued = panel.stream.writableLength;
    } else {
      panel.pending.push(frame);
      panel.pendingBytes += Buffer.byteLength(frame);
      queued = panel.pendingBytes;
    }
    if (queued > MAX_STREAM_BACKLOG_BYTES) {
      // A page that stopped reading: drop its stream rather than buffer its whole session; the
      // page recovers with a fresh panel (design.md §A3).
      logger.warn(`zeo-devtools event=panel_closed reason=backlog ${rootField}`);
      panel.stream?.destroy();
      closePanel(id, panel);
    }
  };

  /**
   * Keeps a panel that Zeo ended with a fatal error before its page connected, holding only that
   * error, for {@link FATAL_GRACE_MS}: a page connecting in time reads why, then the stream ends.
   */
  const hold = (id: string, panel: Panel, frame: string) => {
    panel.held = true;
    panel.session.close();
    panel.pending = [frame];
    panel.pendingBytes = Buffer.byteLength(frame);
    clearTimeout(panel.unclaimed);
    panel.unclaimed = setTimeout(() => closePanel(id, panel), FATAL_GRACE_MS);
    panel.unclaimed.unref();
  };

  /**
   * One server message of the panel's session, relayed as the SSE event named by its kind, data
   * unchanged (R6.2) — except that an answer to a `subscribe` carries the page's own `id` back.
   * Zeo's answers to `hello` — `welcome`, then `project_open` or `project_closed` — usually
   * arrive before the page opens its stream, so they wait for it.
   */
  const relay = (id: string, panel: Panel, msg: ServerMessage) => {
    if (!RELAYED_KINDS.has(msg.kind)) {
      logger.warn(`zeo-devtools event=frame_dropped reason=bad_kind ${rootField}`);
      return;
    }
    const wireId = typeof msg.id === "string" ? msg.id : undefined;
    const pageId = wireId === undefined ? undefined : panel.subscribeIds.get(wireId);
    const frame = sseFrame(msg.kind, pageId === undefined ? msg : { ...msg, id: pageId });
    if (frame === undefined) {
      logger.warn(`zeo-devtools event=frame_dropped reason=bad_kind ${rootField}`);
      return;
    }
    if (msg.kind !== "error") {
      deliver(id, panel, frame);
      return;
    }
    // An error is the panel's to show (a late or superseded answer is a `bad_request`); only its
    // code is logged, never its message (R9.2).
    const code = errorCode(msg.error);
    const fatal = msg.fatal === true;
    if (code === "not_found" && wireId !== undefined && wireId === panel.subscribeId) {
      // The bound thread is gone (R5.8): a reconnect must not subscribe it again.
      panel.session.unbind();
      panel.subscribeId = undefined;
    }
    (fatal ? logger.warn : logger.info)(
      `zeo-devtools event=zeo_error code=${code} fatal=${fatal} ${rootField}`,
    );
    if (!fatal) {
      deliver(id, panel, frame);
      return;
    }
    // Zeo ends a session after a fatal error; the page recovers with a fresh panel (A3).
    logger.warn(`zeo-devtools event=panel_closed reason=zeo_fatal ${rootField}`);
    if (panel.stream === undefined) {
      hold(id, panel, frame);
      return;
    }
    deliver(id, panel, frame);
    closePanel(id, panel);
  };

  /**
   * Sends one validated request on the panel's open session in its wire form, keeping the page's
   * `id` (it matches Zeo's answer with it) or giving it one: the wire requires it.
   */
  const forward = (res: ServerResponse, panel: Panel, msg: PanelClientMsg) => {
    // A `subscribe` always goes out under the bridge's own id: the page may reuse an id, and a
    // `not_found` answering that other request must not unbind the thread (R5.8, R6.9).
    const subscribe = msg.kind === "subscribe";
    const id = subscribe ? randomUUID() : (msg.id ?? randomUUID());
    if (panel.session.send(toWire(msg, id))) {
      if (subscribe) {
        panel.subscribeId = id;
        panel.subscribeIds.set(id, msg.id);
        for (const old of panel.subscribeIds.keys()) {
          if (panel.subscribeIds.size <= SUBSCRIBE_IDS_KEPT) {
            break;
          }
          panel.subscribeIds.delete(old);
        }
      }
      res.writeHead(204);
      res.end();
      return;
    }
    // The session refuses only when not open: the contract caps every request (a `send` at
    // 100 000 characters) far below a frame, and the 8 MiB body cap holds the rest.
    sendJson(res, 503, { error: "zeo_unreachable" });
  };

  /**
   * Serves `file` when it resolves, symlinks followed, to a regular file inside `within`; a link
   * out of the directory answers 404 like a missing file.
   */
  const servePage = async (res: ServerResponse, file: string, within: string) => {
    let body: Buffer;
    try {
      const [real, realWithin] = await Promise.all([realpath(file), realpath(within)]);
      const info = await stat(real);
      if (!real.startsWith(realWithin + sep) || !info.isFile()) {
        sendText(res, 404, "Not found");
        return;
      }
      body = await readFile(real);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        sendText(
          res,
          404,
          file === resolvePath(pageDir, "index.html")
            ? "The Zeo panel page is not built; run `npm run build` in zeo-devtools"
            : "Not found",
        );
        return;
      }
      throw new Error(`Cannot read a panel page file`, { cause: err });
    }
    res.writeHead(200, {
      "Content-Type": PAGE_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": body.length,
    });
    res.end(body);
  };

  /** The file `/assets/<rest>` names inside `assetsDir`, or `undefined` for anything else. */
  const assetFile = (rest: string): string | undefined => {
    let decoded: string;
    try {
      decoded = decodeURIComponent(rest);
    } catch {
      return undefined;
    }
    if (decoded.includes("\0") || decoded.includes("\\")) {
      return undefined;
    }
    const parts = decoded.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) {
      return undefined;
    }
    const file = resolvePath(assetsDir, ...parts);
    return file.startsWith(assetsDir + sep) ? file : undefined;
  };

  const serveEvents = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams) => {
    const id = query.get("panel") ?? "";
    const panel = panels.get(id);
    if (panel === undefined) {
      sendJson(res, 404, { error: "unknown_panel" });
      return;
    }
    if (panel.stream !== undefined) {
      // One stream per panel: a second one would close the session when either ends.
      sendJson(res, 409, { error: "stream_open" });
      return;
    }
    clearTimeout(panel.unclaimed);
    panel.unclaimed = undefined;
    panel.stream = res;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    // GOTCHA G4: without the flush the browser waits for the first event and the page freezes.
    res.flushHeaders();
    req.socket.setNoDelay(true);
    const state = panel.session.state;
    writeEvent(res, "connection", { state: CONNECTION_STATES.has(state) ? state : "connecting" });
    for (const frame of panel.pending) {
      writeFrame(res, frame);
    }
    panel.pending = [];
    panel.pendingBytes = 0;
    // The page went away (or the server closed the stream): its Zeo session goes with it (G4).
    res.on("close", () => closePanel(id, panel));
    if (panel.held) {
      // Zeo already ended this panel: the page has read why, and recovers (A3).
      res.end();
      return;
    }
    panel.heartbeat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) {
        res.write(":\n\n");
      }
    }, HEARTBEAT_MS);
    panel.heartbeat.unref();
  };

  /** The request's JSON body, or `undefined` once its failure is answered (or the client left). */
  const jsonBody = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<{ value: unknown } | undefined> => {
    const body = await readJsonBody(req);
    if (body.ok) {
      return { value: body.value };
    }
    if (body.status !== 0) {
      if (body.status === 413) {
        // The rest of the body is never read: end the connection with the answer.
        res.setHeader("Connection", "close");
      }
      sendJson(res, body.status, { error: body.error });
    }
    return undefined;
  };

  const serveRpc = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await jsonBody(req, res);
    if (body === undefined) {
      return;
    }
    const shape = rpcBody.safeParse(body.value);
    if (!shape.success) {
      sendJson(res, 400, { error: "bad_request", message: "The body is { panel, msg }" });
      return;
    }
    const msg = parsePanelClientMsg(shape.data.msg);
    if (!msg.ok) {
      sendJson(res, 400, { error: msg.error, message: msg.message });
      return;
    }
    const panel = panels.get(shape.data.panel);
    if (panel === undefined) {
      sendJson(res, 404, { error: "unknown_panel" });
      return;
    }
    if (panel.session.state !== "open") {
      // Nothing is queued: a later replay would deliver what the operator was told failed.
      sendJson(res, 503, { error: "zeo_unreachable" });
      return;
    }
    forward(res, panel, msg.value);
  };

  const servePanels = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await jsonBody(req, res);
    if (body === undefined) {
      return;
    }
    if (!panelsBody.safeParse(body.value).success) {
      sendJson(res, 400, { error: "bad_request", message: "The body is {}" });
      return;
    }
    if (panels.size >= MAX_LIVE_PANELS) {
      // Not `panel_refused`: that event is the request checks' (host, origin, fetch_site).
      logger.warn(
        `zeo-devtools event=panel_limit reason=too_many_panels limit=${MAX_LIVE_PANELS} ${rootField}`,
      );
      sendJson(res, 503, { error: "too_many_panels" });
      return;
    }
    sendJson(res, 200, { panel: openPanel() });
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    route: Route,
    path: string,
    query: string,
  ) => {
    if (header(req, "host")?.toLowerCase() !== expectedHost) {
      refuse(res, "host", route);
      return;
    }
    if (isApi(route) && !passesApiChecks(req, res, route)) {
      return;
    }
    const allowed = ALLOWED[route];
    if (allowed.length === 0) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!allowed.includes(req.method ?? "")) {
      res.setHeader("Allow", allowed.join(", "));
      sendJson(res, 405, { error: "method_not_allowed" });
      return;
    }
    if (req.method === "POST" && !isJsonContentType(header(req, "content-type"))) {
      sendJson(res, 415, { error: "unsupported_media_type" });
      return;
    }
    switch (route) {
      case "page":
        await servePage(res, resolvePath(pageDir, "index.html"), pageDir);
        return;
      case "assets": {
        const file = assetFile(path.slice("/assets/".length));
        if (file === undefined) {
          sendText(res, 404, "Not found");
          return;
        }
        await servePage(res, file, assetsDir);
        return;
      }
      case "config":
        sendJson(res, 200, { app_url: appUrl, root });
        return;
      case "panels":
        await servePanels(req, res);
        return;
      case "events":
        serveEvents(req, res, new URLSearchParams(query));
        return;
      case "rpc":
        await serveRpc(req, res);
        return;
    }
  };

  const headers = securityHeaders(csp);
  const secure = (res: ServerResponse) => {
    for (const [name, value] of headers) {
      res.setHeader(name, value);
    }
  };

  // `requireHostHeader: false`: Node's own 400 for an HTTP/1.1 request without `Host` has no hook
  // to add the security headers, so the request reaches the Host check and is refused there.
  const server = createServer(
    { joinDuplicateHeaders: true, requireHostHeader: false },
    (req, res) => {
      secure(res);
      const target = req.url ?? "";
      // Origin-form only: an absolute or `//` target would name a host the checks never saw.
      if (!target.startsWith("/") || target.startsWith("//")) {
        sendJson(res, 400, { error: "bad_request" });
        return;
      }
      const q = target.indexOf("?");
      const path = q === -1 ? target : target.slice(0, q);
      const route = routeOf(path);
      handle(req, res, route, path, q === -1 ? "" : target.slice(q + 1)).catch((err: unknown) => {
        const cause = (err as { cause?: NodeJS.ErrnoException }).cause?.code ?? "internal";
        logger.warn(
          `zeo-devtools event=panel_error route=${route} cause=${logValue(cause)} ${rootField}`,
        );
        if (res.headersSent) {
          res.destroy();
        } else {
          sendJson(res, 500, { error: "internal" });
        }
      });
    },
  );

  // An `Expect` other than `100-continue`: the same 417 Node would send, with the headers.
  server.on("checkExpectation", (_req: IncomingMessage, res: ServerResponse) => {
    secure(res);
    sendJson(res, 417, { error: "expectation_failed" });
  });
  // A request Node cannot parse: Node's answer, with the headers, and nothing of the request.
  server.on("clientError", (err: NodeJS.ErrnoException, socket: Duplex) => {
    // Node's own rule: no answer once a response is under way on this socket, or it is gone.
    const inFlight = (socket as { _httpMessage?: { headersSent?: boolean } })._httpMessage;
    if (err.code === "ECONNRESET" || !socket.writable || inFlight?.headersSent === true) {
      socket.destroy();
      return;
    }
    const [status, text] = clientErrorStatus(err);
    const lines = [
      `HTTP/1.1 ${status} ${text}`,
      ...headers.map(([name, value]) => `${name}: ${value}`),
      "Content-Length: 0",
      "Connection: close",
    ];
    // Then let go once it is flushed, as Node does: a client that keeps its side open must not
    // hold the socket.
    socket.end(`${lines.join("\r\n")}\r\n\r\n`, () => socket.destroy());
  });

  const port = await listen(server, options.port ?? 0, listenAddress(urlHost));
  if (rawOrigin(options.appUrl).origin === `http://${urlHost}:${port}`) {
    // Only possible when the app is not listening on this address: the page would be the app's
    // own origin, and the iframe sandbox would no longer hold (GOTCHA G13).
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(`The panel server got the app's own port ${port}`);
  }
  expectedHost = `${urlHost}:${port}`;
  panelOrigin = `http://${expectedHost}`;
  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.warn(
      `zeo-devtools event=panel_error route=server cause=${logValue(err.code ?? "server")}`,
    );
  });
  const url = `${panelOrigin}/`;
  logger.info(`zeo-devtools event=panel_server_open url=${logValue(url)} ${rootField}`);

  let closing: Promise<void> | undefined;
  return {
    url,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const [id, panel] of [...panels]) {
          closePanel(id, panel);
        }
        server.close(() => {
          logger.info(`zeo-devtools event=panel_server_closed ${rootField}`);
          resolve();
        });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
