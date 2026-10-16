// Story 055, task 3.1 — the long-lived Zeo session client and the dev-server announce
// (design.md §A2). Requirements: R2.1, R2.4, R2.5, R2.7, R2.8, R9.1, R9.2, R9.3 (Q4, Q5, Q15).
// Validation filter: `npm test -- session`, against the v2 fake Zeo (test/helpers/fake-zeo-v2.ts).
//
// Contract (design.md §A2):
//   - `openSession(socketPath, hello): Session`, `Session = { send(msg): void; on(kind, fn): void;
//      close(): void; state: "connecting" | "open" | "closed" }`;
//   - `announce(root, appUrl, panelUrl)` opens the announce session (`hello.client.kind =
//      "dev_server"`) on the socket `resolveSocketPath` finds (here `$ZEO_DEVTOOLS_SOCKET`);
//   - reconnect after 1, 2, 4, 8, 16 s, then every 30 s; a reconnect re-sends `hello` and
//     re-subscribes the bound thread; frames are NDJSON lines of at most 8 MiB.
// `hello` is passed as the whole v2 hello message; if the implementation takes only the client
// info, adjust `HELLO` alone.
//
// Hostile halves first:
//   - framing: two messages in ONE chunk stay two (wrongly collapsed by a read-per-chunk parser),
//     and one message split over TWO writes stays one (wrongly split);
//   - the 8 MiB cap: a well-formed line just over 8 MiB is never delivered, while a 1 MiB line is;
//   - backoff: no attempt is made one millisecond early at any step (a timer per `error` AND per
//     `close` would double the attempts), and the 30 s cadence repeats instead of growing;
//   - `close()` stops the retry loop: no attempt after it, however long the clock runs;
//   - R2.7, old Zeo: a `bad_request` answer to a hello that passed local validation is state
//     `zeo_too_old`, logged ONCE, and retried every 30 s — never on the 1 s schedule and never
//     given up — so an upgraded Zeo is picked up; while an INVALID hello is never sent at all;
//   - `send()` while not open returns false and writes nothing — not even later, after the
//     session opens (a queue would replay a message the operator was told failed, R6.8);
//   - log hygiene: the text of a sent message never appears in any output (R9.2).
//
// Refine v2 (2026-10-15), R2.8 — Zeo answers every accepted dev-server hello with `welcome` and
// then the project's state. Hostile half first: `welcome` followed by `project_closed` is a state
// change, logged, and NOT an error — the announce session stays open, nothing reconnects, nothing
// reads as `zeo_too_old` (a client treating any post-welcome message as a refusal would collapse
// the two); the converse: `project_open` after `welcome`, and a later flip on the same session,
// are each logged as their own state change. Seam: `stateLogged()` is the one place that decides
// how a logged state names itself (`project_open` / `project_closed` in the event line).
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announce, openSession } from "../src/session.js";
import { captureLogs, type Captured } from "./helpers/capture-logs.js";
import { startFakeZeoV2, type FakeZeoV2, type Msg } from "./helpers/fake-zeo-v2.js";

// Real servers and sockets: waits carry their own messages, so the test budget sits above them.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = "/home/dev/app";
const HELLO = { v: 2, kind: "hello", id: "h1", client: { kind: "panel", root: ROOT } };

type SessionLike = ReturnType<typeof openSession>;

let fake: FakeZeoV2 | undefined;
let sessions: SessionLike[] = [];
let logs: Captured | undefined;

beforeEach(async () => {
  fake = await startFakeZeoV2();
  sessions = [];
  logs = captureLogs();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const s of sessions) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  logs?.restore();
  await fake?.dispose();
  delete process.env.ZEO_DEVTOOLS_SOCKET;
});

const open = (path = fake!.path, hello: object = HELLO) => {
  const s = openSession(path, hello as never);
  sessions.push(s);
  return s;
};

const until = async (cond: () => boolean, ms = 3000, what = "condition") => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("hello and state", () => {
  it("sends hello as the first line and reaches `open`", async () => {
    const s = open();
    expect(s.state).toBe("connecting");
    const conn = await fake!.waitForConn();
    await conn.waitForLine((m) => m.kind === "hello");
    expect(conn.lines[0]).toMatchObject({
      v: 2,
      kind: "hello",
      client: { kind: "panel", root: ROOT },
    });
    await until(() => s.state === "open", 3000, "state open");
  });

  it("close() ends the connection and the state is `closed`", async () => {
    const s = open();
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    s.close();
    expect(s.state).toBe("closed");
    await conn.waitClosed();
  });

  it("send() writes one NDJSON line on the connection", async () => {
    const s = open();
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    s.send({ v: 2, kind: "list_threads", id: "r1" });
    expect(await conn.waitForLine((m) => m.kind === "list_threads")).toMatchObject({ id: "r1" });
  });
});

describe("framing (NDJSON)", () => {
  it("hostile: two messages in one chunk are delivered as two, in order", async () => {
    const s = open();
    const seen: string[] = [];
    s.on("title", (m: Msg) => seen.push(String(m.title)));
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    conn.raw(
      `${JSON.stringify({ v: 2, kind: "title", title: "one" })}\n${JSON.stringify({ v: 2, kind: "title", title: "two" })}\n`,
    );
    await until(() => seen.length === 2, 3000, "two titles");
    expect(seen).toEqual(["one", "two"]);
  });

  it("hostile: one message split over two writes is delivered once, intact", async () => {
    const s = open();
    const seen: unknown[] = [];
    s.on("title", (m: Msg) => seen.push(m.title));
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    const line = `${JSON.stringify({ v: 2, kind: "title", title: "split-in-two" })}\n`;
    conn.raw(line.slice(0, 13));
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual([]);
    conn.raw(line.slice(13));
    await until(() => seen.length === 1, 3000, "the split title");
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toEqual(["split-in-two"]);
  });

  it("hostile: a line over 8 MiB is never delivered; a 1 MiB line is", async () => {
    const s = open();
    const seen: number[] = [];
    s.on("title", (m: Msg) => seen.push(String(m.title).length));
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    const big = "x".repeat(8 * 1024 * 1024 + 1);
    conn.raw(`${JSON.stringify({ v: 2, kind: "title", title: big })}\n`);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.some((n) => n > 8 * 1024 * 1024)).toBe(false);
    // The session may have dropped and reconnected: send the benign line on the newest one.
    const latest = await fake!.waitForConn((c) => !c.closed);
    latest.raw(`${JSON.stringify({ v: 2, kind: "title", title: "y".repeat(1024 * 1024) })}\n`);
    await until(() => seen.includes(1024 * 1024), 5000, "the 1 MiB title");
  });

  it("an unreadable line from Zeo is dropped and the session stays open (Q4)", async () => {
    const s = open();
    const seen: unknown[] = [];
    s.on("title", (m: Msg) => seen.push(m.title));
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    conn.raw("this is not json\n");
    conn.send({ v: 2, kind: "title", title: "after" });
    await until(() => seen.length === 1);
    expect(seen).toEqual(["after"]);
    expect(s.state).toBe("open");
  });
});

describe("reconnect (R2.5)", () => {
  /** Lets libuv deliver connect errors without moving the fake clock. */
  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setImmediate(r));
    }
  };

  it("hostile: retries after exactly 1, 2, 4, 8, 16 s, then every 30 s — never early", async () => {
    const missing = join(fake!.dir, "absent.sock");
    const connect = vi.spyOn(Socket.prototype, "connect");
    // net.createConnection/connect hand Socket#connect its normalized `[options, cb]` array.
    const attempts = () =>
      connect.mock.calls.filter((args) => {
        const first = args[0] as unknown;
        const a = Array.isArray(first) ? (first[0] as unknown) : first;
        return (
          a === missing ||
          (typeof a === "object" && a !== null && (a as { path?: string }).path === missing)
        );
      }).length;
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    open(missing);
    await flush();
    expect(attempts()).toBe(1);
    for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]) {
      const before = attempts();
      await vi.advanceTimersByTimeAsync(delay - 1);
      await flush();
      expect(attempts(), `no retry 1 ms before the ${delay} ms mark`).toBe(before);
      await vi.advanceTimersByTimeAsync(1);
      await flush();
      expect(attempts(), `one retry at the ${delay} ms mark`).toBe(before + 1);
    }
    connect.mockRestore();
  });

  it("hostile: close() stops the retry loop", async () => {
    const missing = join(fake!.dir, "absent.sock");
    const connect = vi.spyOn(Socket.prototype, "connect");
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const s = open(missing);
    await vi.advanceTimersByTimeAsync(1);
    s.close();
    const after = connect.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(connect.mock.calls.length).toBe(after);
    expect(s.state).toBe("closed");
    connect.mockRestore();
  });

  it("a lost session reconnects, re-sends hello and re-subscribes the bound thread", async () => {
    const s = open();
    const first = await fake!.waitForConn();
    await until(() => s.state === "open");
    s.send({ v: 2, kind: "subscribe", id: "s1", target: { thread_id: "t-bound" } });
    await first.waitForLine((m) => m.kind === "subscribe");
    await fake!.restart();
    const second = await fake!.waitForConn((c) => c.n > first.n, 5000);
    // The connection resolves on connect; wait for its first line before reading it.
    await second.waitForLine((m) => m.kind === "hello", 3000);
    expect(second.lines[0]).toMatchObject({ kind: "hello", client: { kind: "panel", root: ROOT } });
    const sub = await second.waitForLine((m) => m.kind === "subscribe", 3000);
    expect(sub).toMatchObject({ target: { thread_id: "t-bound" } });
  });

  it("the first retry after a lost OPEN session is 1 s, not the next step of an old schedule", async () => {
    const s = open();
    const first = await fake!.waitForConn();
    await until(() => s.state === "open");
    const lostAt = Date.now();
    await fake!.restart();
    await fake!.waitForConn((c) => c.n > first.n, 5000);
    expect(Date.now() - lostAt).toBeLessThan(2500);
  });
});

/** Spins the real event loop (never the fake clock) until `cond` holds. */
async function spin(cond: () => boolean, what: string, turns = 5000) {
  for (let i = 0; i < turns; i++) {
    if (cond()) {
      return;
    }
    await new Promise((r) => setImmediate(r));
  }
  throw new Error(`never happened: ${what}`);
}

describe("old Zeo (R2.7)", () => {
  const rejectHello = () => {
    fake!.autoWelcome = false;
    fake!.onLine = (conn, msg) => {
      if (msg.kind === "hello") {
        conn.send({
          v: 2,
          kind: "error",
          id: msg.id,
          error: "bad_request",
          message: "unknown client",
          fatal: false,
        });
      }
    };
  };

  it("hostile: zeo_too_old is logged once and retried every 30 s, never at 1 s, until Zeo accepts", async () => {
    rejectHello();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    const s = open();
    await spin(() => (s.state as string) === "zeo_too_old", "state zeo_too_old");
    const n = fake!.conns.length;
    await vi.advanceTimersByTimeAsync(29_999);
    await spin(() => true, "flush");
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setImmediate(r));
    }
    expect(fake!.conns.length, "no retry before 30 s (not the 1 s schedule)").toBe(n);
    await vi.advanceTimersByTimeAsync(1);
    await spin(() => fake!.conns.length === n + 1, "a retry at 30 s");
    await spin(() => fake!.conns[n]!.hello !== undefined, "the retry says hello again");
    await spin(() => (s.state as string) === "zeo_too_old", "rejected again");
    expect(
      logs!.events().filter((l) => l.includes("event=zeo_too_old")),
      "logged once",
    ).toHaveLength(1);

    // Zeo upgraded: the next 30 s retry is welcomed.
    fake!.onLine = undefined;
    fake!.autoWelcome = true;
    await vi.advanceTimersByTimeAsync(30_000);
    await spin(() => s.state === "open", "open after the upgrade");
  });

  it("hostile: an invalid hello is validated locally and never sent", async () => {
    open(fake!.path, {
      v: 2,
      kind: "hello",
      id: "h1",
      client: { kind: "panel", root: "relative/root" },
    });
    await new Promise((r) => setTimeout(r, 300));
    const hellos = fake!.conns.flatMap((c) => c.lines).filter((l) => (l as Msg).kind === "hello");
    expect(hellos).toEqual([]);
  });
});

describe("send while not open (A2, R6.8)", () => {
  it("returns false on a session that never opened, true once open, false after close", async () => {
    const dead = open(join(fake!.dir, "absent.sock"));
    expect(dead.send({ v: 2, kind: "list_threads", id: "r0" })).toBe(false);
    const live = open();
    const conn = await fake!.waitForConn();
    await until(() => live.state === "open");
    expect(live.send({ v: 2, kind: "list_threads", id: "r1" })).toBe(true);
    live.close();
    expect(live.send({ v: 2, kind: "cancel", id: "r2" })).toBe(false);
    await conn.waitClosed();
    expect(conn.lines.map((l) => (l as Msg).kind)).not.toContain("cancel");
  });

  it("hostile: a refused send is not queued and replayed when the session opens later", async () => {
    await fake!.stop();
    const s = open();
    expect(s.send({ v: 2, kind: "send", id: "m1", text: "too early", attachments: [] })).toBe(
      false,
    );
    await fake!.restart();
    const conn = await fake!.waitForConn(undefined, 5000);
    await until(() => s.state === "open", 5000, "open after Zeo came back");
    await new Promise((r) => setTimeout(r, 100));
    expect(conn.lines.map((l) => (l as Msg).kind)).not.toContain("send");
  });
});

describe("announce (R2.1)", () => {
  it("opens a dev_server session naming the root, the app URL and the panel URL", async () => {
    process.env.ZEO_DEVTOOLS_SOCKET = fake!.path;
    const handle = announce(ROOT, "http://localhost:5173", "http://localhost:5174") as unknown;
    try {
      const conn = await fake!.waitForConn();
      const hello = await conn.waitForLine((m) => m.kind === "hello");
      expect(hello).toMatchObject({
        v: 2,
        kind: "hello",
        client: {
          kind: "dev_server",
          root: ROOT,
          app_url: "http://localhost:5173",
          panel_url: "http://localhost:5174",
        },
      });
    } finally {
      (handle as { close?: () => void } | undefined)?.close?.();
    }
  });

  it("does not throw when Zeo is unreachable (the dev server keeps running)", () => {
    process.env.ZEO_DEVTOOLS_SOCKET = join(fake!.dir, "absent.sock");
    let handle: unknown;
    expect(() => {
      handle = announce(ROOT, "http://localhost:5173", "http://localhost:5174");
    }).not.toThrow();
    (handle as { close?: () => void } | undefined)?.close?.();
  });
});

describe("log hygiene (R9.2)", () => {
  it("hostile: the text of a sent message never reaches any output", async () => {
    const s = open();
    const conn = await fake!.waitForConn();
    await until(() => s.state === "open");
    s.send({ v: 2, kind: "send", id: "m1", text: "SECRET-PROMPT-7f3a", attachments: [] });
    conn.send({
      v: 2,
      kind: "entry_added",
      index: 0,
      entry: { role: "assistant", markdown: "MODEL-OUTPUT-91c2", truncated: false },
    });
    await conn.waitForLine((m) => m.kind === "send");
    await new Promise((r) => setTimeout(r, 50));
    s.close();
    expect(logs!.text()).not.toContain("SECRET-PROMPT-7f3a");
    expect(logs!.text()).not.toContain("MODEL-OUTPUT-91c2");
    for (const line of logs!.events()) {
      expect(line, "structured key=value").toMatch(/zeo-devtools event=[a-z_]+/);
    }
  });
});

// ---- Refine v2 (2026-10-15): the announce session's answers (R2.8, design.md §A2) -------------

describe("announce answers: welcome, then the project's state (R2.8)", () => {
  const APP = "http://localhost:5173";
  const PANEL = "http://localhost:5174";
  type State = "project_open" | "project_closed";

  /** Zeo welcomes the hello (the fake's default) and then sends `state` on the same connection. */
  const announceAnswered = async (state: State) => {
    fake!.onLine = (conn, msg) => {
      if (msg.kind === "hello") {
        conn.send({ v: 2, kind: state });
      }
    };
    process.env.ZEO_DEVTOOLS_SOCKET = fake!.path;
    const handle = announce(ROOT, APP, PANEL) as unknown;
    const conn = await fake!.waitForConn();
    await conn.waitForLine((m) => m.kind === "hello");
    return { handle: handle as { close?: () => void; state?: string } | undefined, conn };
  };
  /** The seam: the event lines that log `state` as the project's state. */
  const stateLogged = (state: State) => logs!.events().filter((l) => l.includes(state));
  const errorEvents = () =>
    logs!.events().filter((l) => /error|zeo_too_old|fail|refused|bad_request/i.test(l));

  it("hostile: project_closed after welcome is a logged state change, not an error — the session stays", async () => {
    const { handle, conn } = await announceAnswered("project_closed");
    try {
      await until(() => stateLogged("project_closed").length > 0, 3000, "project_closed logged");
      // Past the first 1 s retry: a session that took the state as a failure would reconnect.
      await new Promise((r) => setTimeout(r, 1500));
      expect(conn.closed, "the announce session is kept (R2.3)").toBe(false);
      expect(fake!.conns, "no reconnect").toHaveLength(1);
      expect(errorEvents(), "nothing logged as an error").toEqual([]);
      if (handle?.state !== undefined) {
        expect(handle.state).toBe("open");
      }
    } finally {
      handle?.close?.();
    }
  });

  it("converse: project_open after welcome is logged too, and a later flip is another state change", async () => {
    const { handle, conn } = await announceAnswered("project_open");
    try {
      await until(() => stateLogged("project_open").length > 0, 3000, "project_open logged");
      expect(stateLogged("project_closed")).toEqual([]);
      conn.send({ v: 2, kind: "project_closed" });
      await until(() => stateLogged("project_closed").length > 0, 3000, "the flip logged");
      conn.send({ v: 2, kind: "project_open" });
      await until(() => stateLogged("project_open").length > 1, 3000, "the flip back logged");
      await new Promise((r) => setTimeout(r, 1500));
      expect(conn.closed).toBe(false);
      expect(fake!.conns, "the same session throughout").toHaveLength(1);
      expect(errorEvents()).toEqual([]);
    } finally {
      handle?.close?.();
    }
  });
});
