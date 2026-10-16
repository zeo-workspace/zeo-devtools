// The long-lived v2 session with Zeo's devtools bridge (story 055, design.md §A2): one NDJSON
// connection to `devtools.sock` that says `hello`, waits for `welcome`, relays every server
// message to its listeners, and reconnects after 1, 2, 4, 8, 16 s and then every 30 s (R2.5).
//
// Two kinds of session use it: the dev server's announce session (`announce`, R2.1) and one
// session per open panel page (panel-server.ts). Nothing here throws once a session exists: a
// socket error, an unreadable line or a refusal from Zeo is a state change and a log line, and
// the dev server keeps serving the app.
//
// Logs are one `zeo-devtools event=… key=value` line per open/close and per state change, naming
// the client kind and the root — never the text of a message, in either direction (R9.1, R9.2).
import { Buffer } from "node:buffer";
import { createConnection, type Socket } from "node:net";
import { parseHello, parseServerV2, PROTOCOL_VERSION, type Hello } from "./contract-v2.js";
import { resolveSocketPath } from "./socket.js";

/** The longest NDJSON line either side may send, in bytes, newline excluded. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** Delay before each reconnect attempt; the last one repeats forever (R2.5). */
export const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000] as const;
const SLOW_RETRY = RETRY_DELAYS_MS.length - 1;

/**
 * `connecting` until Zeo welcomes the hello, `open` after; `zeo_too_old` when Zeo refused a hello
 * this plugin had validated (R2.7); `closed` only after `close()` or a hello that never left.
 */
export type SessionState = "connecting" | "open" | "zeo_too_old" | "closed";

/** One message from Zeo, as read off the wire: a JSON object with a string `kind`. */
export type ServerMessage = Record<string, unknown> & { kind: string };

/** The subset of Vite's `Logger` a session writes through. */
export interface SessionLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

export interface SessionOptions {
  /** Where the lines go; Vite's logger in the plugin, the console otherwise. */
  logger?: SessionLogger;
}

export interface AnnounceOptions extends SessionOptions {
  /** Zeo's socket; else `$ZEO_DEVTOOLS_SOCKET`, else `$XDG_RUNTIME_DIR/zeo/devtools.sock`. */
  socketPath?: string;
}

export interface Session {
  readonly state: SessionState;
  /**
   * Writes one message while the session is `open` and answers `true`; otherwise answers `false`
   * and writes nothing, now or later — a refused message is never queued (R6.8). The last
   * `subscribe` sent is re-sent after every reconnect.
   */
  send(msg: object): boolean;
  /** Calls `fn` for every server message of `kind`; `"*"` receives every message. */
  on(kind: string, fn: (msg: ServerMessage) => void): void;
  /** Calls `fn` on every state change. */
  onState(fn: (state: SessionState) => void): void;
  /** Ends the connection and the retry loop for good. */
  close(): void;
}

const consoleLogger: SessionLogger = {
  info: (msg) => console.info(msg),
  warn: (msg) => console.warn(msg),
};

/** A log value as-is, or JSON-quoted when it would break the `key=value` line apart. */
const logValue = (value: string) => (/^[^\s"=]+$/.test(value) ? value : JSON.stringify(value));

/** The `client=… root=…` part of every line of a session. */
function sessionFields(hello: Hello): string {
  const client = hello.client;
  const kind = client.kind ?? "extension";
  return "root" in client ? `client=${kind} root=${logValue(client.root)}` : `client=${kind}`;
}

const isServerMessage = (value: unknown): value is ServerMessage =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  typeof (value as { kind?: unknown }).kind === "string";

/**
 * Splits a byte stream into NDJSON lines of at most `maxBytes`. A line is only decoded once it is
 * whole, so a multi-byte character split across two chunks survives.
 */
class LineSplitter {
  private parts: Buffer[] = [];
  private pending = 0;

  constructor(private readonly maxBytes: number) {}

  /**
   * Feeds one chunk and hands each complete line to `onLine`, which answers whether to keep
   * reading. Answers `false` when a line grows past the cap; nothing of that line is delivered.
   */
  push(chunk: Buffer, onLine: (line: Buffer) => boolean): boolean {
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      if (this.pending + (end - start) > this.maxBytes) {
        return false;
      }
      if (newline === -1) {
        break;
      }
      const piece = chunk.subarray(start, newline);
      const line = this.parts.length === 0 ? piece : Buffer.concat([...this.parts, piece]);
      this.parts = [];
      this.pending = 0;
      start = newline + 1;
      if (!onLine(line)) {
        return true;
      }
    }
    if (start < chunk.length) {
      this.parts.push(chunk.subarray(start));
      this.pending += chunk.length - start;
    }
    return true;
  }
}

class ZeoSession implements Session {
  private current: SessionState = "connecting";
  private socket: Socket | undefined;
  /** Bumped whenever a socket is abandoned, so its late events are ignored. */
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryIndex = 0;
  /** The last `subscribe` line sent, re-sent on every reconnect. */
  private bound: string | undefined;
  private tooOldLogged = false;
  private unreachableLogged = false;
  private readonly listeners = new Map<string, Set<(msg: ServerMessage) => void>>();
  private readonly stateListeners = new Set<(state: SessionState) => void>();

  constructor(
    private readonly path: string,
    private readonly hello: Hello,
    private readonly fields: string,
    private readonly logger: SessionLogger,
  ) {}

  get state(): SessionState {
    return this.current;
  }

  start(): this {
    this.connect();
    return this;
  }

  send(msg: object): boolean {
    const socket = this.socket;
    if (this.current !== "open" || socket === undefined) {
      return false;
    }
    let line: string;
    try {
      line = `${JSON.stringify(msg)}\n`;
    } catch {
      // A cycle or a BigInt: nothing Zeo could read.
      return false;
    }
    if (Buffer.byteLength(line) - 1 > MAX_FRAME_BYTES) {
      return false;
    }
    if ((msg as { kind?: unknown }).kind === "subscribe") {
      this.bound = line;
    }
    socket.write(line);
    return true;
  }

  on(kind: string, fn: (msg: ServerMessage) => void): void {
    let set = this.listeners.get(kind);
    if (set === undefined) {
      set = new Set();
      this.listeners.set(kind, set);
    }
    set.add(fn);
  }

  onState(fn: (state: SessionState) => void): void {
    this.stateListeners.add(fn);
  }

  close(): void {
    if (this.current === "closed") {
      return;
    }
    const wasOpen = this.current === "open";
    clearTimeout(this.timer);
    this.timer = undefined;
    const socket = this.detach();
    if (socket !== undefined) {
      if (wasOpen) {
        // Flush what was already written, then let go.
        socket.end(() => socket.destroy());
      } else {
        socket.destroy();
      }
    }
    if (wasOpen) {
      this.logger.info(`zeo-devtools event=session_closed ${this.fields} reason=closed`);
    }
    this.setState("closed");
  }

  private connect(): void {
    this.timer = undefined;
    const generation = ++this.generation;
    const live = () => generation === this.generation;
    const frames = new LineSplitter(MAX_FRAME_BYTES);
    let cause = "eof";
    // ENOENT, ECONNREFUSED, EINVAL (a path too long) arrive as an `error` event, then `close`;
    // the catch is for anything Node would reject synchronously, inside a timer callback too.
    let socket: Socket;
    try {
      socket = createConnection({ path: this.path });
    } catch {
      this.lost("connect_rejected");
      return;
    }
    this.socket = socket;
    socket.on("connect", () => {
      if (live()) {
        socket.write(`${JSON.stringify(this.hello)}\n`);
      }
    });
    socket.on("data", (chunk: Buffer) => {
      if (!live()) {
        return;
      }
      const fits = frames.push(chunk, (line) => {
        this.onLine(line);
        return live();
      });
      if (!fits && live()) {
        this.lost("frame_too_long");
      }
    });
    // The listener stays for the socket's whole life, so an error can never be unhandled.
    socket.on("error", (err: NodeJS.ErrnoException) => {
      cause = err.code ?? "socket";
    });
    socket.on("close", () => {
      if (live()) {
        this.lost(cause);
      }
    });
  }

  /** Abandons the current socket (its late events are ignored) and returns it. */
  private detach(): Socket | undefined {
    this.generation++;
    const socket = this.socket;
    this.socket = undefined;
    return socket;
  }

  /** The connection went away or failed to come up: retry on the schedule. */
  private lost(reason: string): void {
    this.detach()?.destroy();
    if (this.current === "open") {
      const line = `zeo-devtools event=session_closed ${this.fields} reason=${logValue(reason)}`;
      if (reason === "frame_too_long") {
        this.logger.warn(line);
      } else {
        this.logger.info(line);
      }
      // A fresh outage starts the schedule over; the loss itself was just logged.
      this.retryIndex = 0;
      this.unreachableLogged = true;
    } else if (!this.unreachableLogged) {
      this.unreachableLogged = true;
      this.logger.info(
        `zeo-devtools event=session_unreachable ${this.fields} cause=${logValue(reason)}`,
      );
    }
    this.setState("connecting");
    this.scheduleRetry();
  }

  /** Zeo answered the hello but cannot hold this session: slow retries until it can (R2.7). */
  private tooOld(reason: "bad_request" | "protocol"): void {
    this.detach()?.destroy();
    if (!this.tooOldLogged) {
      this.tooOldLogged = true;
      this.logger.warn(`zeo-devtools event=zeo_too_old ${this.fields} reason=${reason}`);
    }
    this.retryIndex = SLOW_RETRY;
    this.setState("zeo_too_old");
    this.scheduleRetry();
  }

  private opened(): void {
    this.retryIndex = 0;
    this.tooOldLogged = false;
    this.unreachableLogged = false;
    this.setState("open");
    this.logger.info(`zeo-devtools event=session_open ${this.fields}`);
    if (this.bound !== undefined) {
      this.socket?.write(this.bound);
    }
  }

  private scheduleRetry(): void {
    const delay = RETRY_DELAYS_MS[this.retryIndex] ?? RETRY_DELAYS_MS[SLOW_RETRY];
    this.retryIndex = Math.min(this.retryIndex + 1, SLOW_RETRY);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  private onLine(line: Buffer): void {
    if (line.length === 0) {
      return;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(line.toString("utf8"));
    } catch {
      msg = undefined;
    }
    if (!isServerMessage(msg)) {
      // Dropped, session kept (Q4); the line itself is never logged.
      this.logger.warn(`zeo-devtools event=frame_dropped ${this.fields} reason=unreadable`);
      return;
    }
    if (this.current !== "open" && this.handshake(msg)) {
      return;
    }
    if (msg.kind === "project_open" || msg.kind === "project_closed") {
      if (parseServerV2(msg).ok) {
        // A state change of the project, never an error (R2.8).
        this.logger.info(`zeo-devtools event=${msg.kind} ${this.fields}`);
      }
    }
    this.dispatch(msg);
  }

  /** Reads Zeo's answer to the hello; `true` when the message was consumed by the handshake. */
  private handshake(msg: ServerMessage): boolean {
    if (msg.kind === "welcome") {
      // A welcome this plugin cannot read, or for another protocol, is a Zeo it cannot talk to.
      const parsed = parseServerV2(msg);
      if (
        !parsed.ok ||
        parsed.value.kind !== "welcome" ||
        parsed.value.protocol !== PROTOCOL_VERSION
      ) {
        this.tooOld("protocol");
        return true;
      }
      this.opened();
      return false;
    }
    if (msg.kind === "error" && msg.error === "bad_request") {
      // The hello was validated before it left, so Zeo does not know this identity (R2.7).
      const id = msg.id;
      if (id === undefined || id === this.hello.id) {
        this.tooOld("bad_request");
        return true;
      }
    }
    return false;
  }

  private dispatch(msg: ServerMessage): void {
    for (const key of [msg.kind, "*"]) {
      for (const fn of this.listeners.get(key) ?? []) {
        try {
          fn(msg);
        } catch {
          this.logger.warn(
            `zeo-devtools event=listener_threw ${this.fields} kind=${logValue(msg.kind)}`,
          );
        }
      }
    }
  }

  private setState(next: SessionState): void {
    if (this.current === next) {
      return;
    }
    this.current = next;
    for (const fn of this.stateListeners) {
      try {
        fn(next);
      } catch {
        this.logger.warn(`zeo-devtools event=listener_threw ${this.fields} kind=state`);
      }
    }
  }
}

/** A session whose hello never leaves: closed from the start, it sends and hears nothing. */
const closedSession = (): Session => ({
  state: "closed",
  send: () => false,
  on: () => {},
  onState: () => {},
  close: () => {},
});

/**
 * Opens a session on `socketPath` saying `hello`, which is validated first: an invalid hello is
 * never sent, and the session answers `closed` (R9.3). Never throws.
 */
export function openSession(
  socketPath: string,
  hello: Hello,
  options: SessionOptions = {},
): Session {
  const logger = options.logger ?? consoleLogger;
  const checked = parseHello(hello);
  if (!checked.ok) {
    logger.warn(
      `zeo-devtools event=session_refused reason=invalid_hello detail=${logValue(checked.message)}`,
    );
    return closedSession();
  }
  return new ZeoSession(socketPath, checked.value, sessionFields(checked.value), logger).start();
}

/**
 * Opens the dev server's announce session (`hello.client.kind = "dev_server"`, R2.1) and keeps it
 * until `close()`. Never throws: an unresolvable socket path is logged and answers a closed
 * session, and an unreachable Zeo is retried on the schedule while the dev server runs.
 */
export function announce(
  root: string,
  appUrl: string,
  panelUrl: string,
  options: AnnounceOptions = {},
): Session {
  const logger = options.logger ?? consoleLogger;
  const resolved = resolveSocketPath(options.socketPath);
  if (!resolved.ok) {
    logger.warn(
      `zeo-devtools event=announce_skipped root=${logValue(root)} reason=no_socket_path ` +
        `detail=${logValue(resolved.message)}`,
    );
    return closedSession();
  }
  const hello: Hello = {
    v: PROTOCOL_VERSION,
    kind: "hello",
    id: "announce",
    client: { kind: "dev_server", root, app_url: appUrl, panel_url: panelUrl },
  };
  return openSession(resolved.path, hello, options);
}
