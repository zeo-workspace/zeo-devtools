// Story 055 — a fake Zeo devtools bridge speaking the session protocol v2 (patch 0058): a real
// `net.Server` on a temp unix socket that keeps every connection open, records every NDJSON line
// per connection, and lets a test answer or push server messages. Test support only — never
// imported by `src/`. The one-shot v1 fake stays in `fake-zeo.ts`.
//
// Default behaviour: a `hello` is answered with `welcome` (protocol 2), so a client that waits
// for the welcome before sending works; `onLine` can add more answers per test.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Msg = Record<string, unknown> & { kind?: string };

export interface V2Conn {
  /** Index in `FakeZeoV2.conns`, in accept order. */
  n: number;
  /** Every complete line, parsed (or the raw text when it is not JSON). */
  lines: unknown[];
  /** The first `hello` this connection sent, if any. */
  hello: Msg | undefined;
  closed: boolean;
  send(msg: object): void;
  /** Writes raw bytes, no newline added. */
  raw(text: string): void;
  end(): void;
  destroy(): void;
  /** Resolves with the first line (already received or future) matching `pred`. */
  waitForLine(pred: (m: Msg) => boolean, ms?: number): Promise<Msg>;
  waitClosed(ms?: number): Promise<void>;
}

export interface FakeZeoV2 {
  path: string;
  dir: string;
  conns: V2Conn[];
  autoWelcome: boolean;
  onLine: ((conn: V2Conn, msg: Msg) => void) | undefined;
  waitForConn(pred?: (c: V2Conn) => boolean, ms?: number): Promise<V2Conn>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

const poll = async <T>(get: () => T | undefined, ms: number, what: string): Promise<T> => {
  const until = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() > until) {
      throw new Error(`fake-zeo-v2: timed out after ${ms} ms waiting for ${what}`);
    }
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 5));
  }
};

export const welcome = (id?: unknown) => ({
  v: 2,
  kind: "welcome",
  ...(typeof id === "string" ? { id } : {}),
  protocol: 2,
  zeo_version: "0.0.0-test",
});

export const threadInfo = (thread_id: string, title = thread_id, project = "/p/app") => ({
  thread_id,
  title,
  project,
  agent: "Claude Agent",
  status: "idle",
  followed: false,
});

export async function startFakeZeoV2(socketPath?: string): Promise<FakeZeoV2> {
  const dir = await mkdtemp(join(tmpdir(), "zeo-fake-v2-"));
  const path = socketPath ?? join(dir, "devtools.sock");
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  const fake: FakeZeoV2 = {
    path,
    dir,
    conns: [],
    autoWelcome: true,
    onLine: undefined,
    waitForConn(pred = () => true, ms = 5000) {
      return poll(() => fake.conns.find(pred), ms, "a connection");
    },
    async stop() {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    },
    async restart() {
      await fake.stop();
      await listen();
    },
    async dispose() {
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };

  const accept = (socket: Socket) => {
    sockets.add(socket);
    let buffer = "";
    const conn: V2Conn = {
      n: fake.conns.length,
      lines: [],
      hello: undefined,
      closed: false,
      send(msg) {
        if (!socket.destroyed) {
          socket.write(`${JSON.stringify(msg)}\n`);
        }
      },
      raw(text) {
        if (!socket.destroyed) {
          socket.write(text);
        }
      },
      end() {
        socket.end();
      },
      destroy() {
        socket.destroy();
      },
      waitForLine(pred, ms = 5000) {
        return poll(
          () =>
            conn.lines.find((l): l is Msg => typeof l === "object" && l !== null && pred(l as Msg)),
          ms,
          `a line on connection ${conn.n}`,
        );
      },
      waitClosed(ms = 5000) {
        return poll(
          () => (conn.closed ? true : undefined),
          ms,
          `connection ${conn.n} to close`,
        ).then(() => undefined);
      },
    };
    fake.conns.push(conn);
    socket.on("close", () => {
      sockets.delete(socket);
      conn.closed = true;
    });
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) {
          break;
        }
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = line;
        }
        conn.lines.push(parsed);
        if (typeof parsed === "object" && parsed !== null) {
          const msg = parsed as Msg;
          if (msg.kind === "hello") {
            conn.hello ??= msg;
            if (fake.autoWelcome) {
              conn.send(welcome(msg.id));
            }
          }
          fake.onLine?.(conn, msg);
        }
      }
    });
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const s = createServer(accept);
      s.once("error", reject);
      s.listen(path, () => {
        server = s;
        resolve();
      });
    });

  await listen();
  return fake;
}
