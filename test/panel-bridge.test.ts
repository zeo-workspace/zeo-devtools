// Story 055, task 4.2 — each panel bridged to its own Zeo panel session (design.md §A1 Panel API,
// §A2, GOTCHA G4). Requirements: R2.7, R5.4, R6.2, R6.3, R6.4, R6.5, R6.8, R7.1, R7.3, R7.6
// (+ R9.1, R9.2; Q4, Q5).
// Validation filter: `npm test -- panel-bridge`, against the v2 fake Zeo.
//
// Contract: `POST /api/panels` opens a session whose hello is `client: { kind: "panel", root }`
// and answers `{ panel }`; every server message of that session becomes one SSE event
// (`event: <kind>`, `data: <json>`) on `GET /api/events?panel=<id>`; `POST /api/rpc
// { panel, msg }` forwards `msg` as a v2 message on that session and answers 204.
// Assumed seam: as in panel-server.test.ts, `zeo` is `{ socketPath }` (and `$ZEO_DEVTOOLS_SOCKET`
// is set to the same path); adjust `startPanelServer`'s call alone if it moved.
//
// Hostile halves first:
//   - panel identity: two panels stay apart in BOTH directions — panel A's rpc never reaches B's
//     Zeo session, and B's SSE stream never carries A's server messages (wrongly collapsed by one
//     shared session); and one panel's two rpcs go to ONE session (wrongly split by a session per
//     request);
//   - the rpc filter: `subscribe { follow: true }`, `open_in_zeo` and `hello` never reach Zeo;
//   - a closed EventSource closes its Zeo session (G4: sessions leak toward Zeo's cap);
//   - connection state is streamed: `event: connection` once on connect and on every A2 change
//     (connecting → open across a Zeo restart; `zeo_too_old` when Zeo refuses the panel hello);
//   - nothing is queued while Zeo is away: an rpc then answers 503 `zeo_unreachable`, and when
//     Zeo comes back the session says hello and NOTHING else (a replay would deliver a message the
//     operator was told failed, R6.8);
//   - the text the operator sends and the model output never appear in the plugin's logs (R9.2),
//     while a panel_open-type line naming the root does (R9.1).
import { request as httpRequest, type ClientRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPanelServer } from "../src/panel-server.js";
import { captureLogs, keyValues, type Captured } from "./helpers/capture-logs.js";
import { join } from "node:path";
import { startFakeZeoV2, threadInfo, type FakeZeoV2, type V2Conn } from "./helpers/fake-zeo-v2.js";

// Real servers and sockets: waits carry their own messages, so the test budget sits above them.
vi.setConfig({ testTimeout: 20_000 });

const HOST = "localhost";
const ROOT = "/home/dev/app";
const APP_URL = `http://${HOST}:5173`;

let fake: FakeZeoV2;
let panel: { url: string; close(): Promise<void> };
let port: number;
let logs: Captured;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port: p } = s.address() as AddressInfo;
      s.close(() => resolve(p));
    });
  });
}

function post(
  path: string,
  body: unknown,
  p: number = port,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: HOST,
        port: p,
        path,
        method: "POST",
        setHost: false,
        headers: {
          Host: `${HOST}:${p}`,
          Origin: `http://${HOST}:${p}`,
          "Sec-Fetch-Site": "same-origin",
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

type SseEvent = { event: string; data: unknown };
interface Stream {
  status: number;
  events: SseEvent[];
  req: ClientRequest;
  waitFor(kind: string, ms?: number): Promise<SseEvent>;
  waitWhere(pred: (e: SseEvent) => boolean, ms?: number, from?: number): Promise<SseEvent>;
}

/** Opens the SSE stream the way an EventSource does: GET, no Origin, same-origin fetch site. */
function events(id: string, p: number = port): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: HOST,
        port: p,
        path: `/api/events?panel=${encodeURIComponent(id)}`,
        method: "GET",
        setHost: false,
        headers: {
          Host: `${HOST}:${p}`,
          "Sec-Fetch-Site": "same-origin",
          Accept: "text/event-stream",
        },
      },
      (res) => {
        let buf = "";
        const stream: Stream = {
          status: res.statusCode ?? 0,
          events: [],
          req,
          async waitWhere(pred, ms = 3000, from = 0) {
            const end = Date.now() + ms;
            for (;;) {
              const hit = stream.events.slice(from).find(pred);
              if (hit) {
                return hit;
              }
              if (Date.now() > end) {
                throw new Error(
                  `no matching SSE event within ${ms} ms; got ${JSON.stringify(stream.events.slice(from))}`,
                );
              }
              await new Promise((r) => setTimeout(r, 10));
            }
          },
          async waitFor(kind, ms = 3000) {
            const end = Date.now() + ms;
            for (;;) {
              const hit = stream.events.find((e) => e.event === kind);
              if (hit) {
                return hit;
              }
              if (Date.now() > end) {
                throw new Error(
                  `no SSE event ${kind} within ${ms} ms; got ${stream.events.map((e) => e.event).join(",")}`,
                );
              }
              await new Promise((r) => setTimeout(r, 10));
            }
          },
        };
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) >= 0) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let event = "message";
            const data: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                event = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                data.push(line.slice(5).trimStart());
              }
            }
            if (data.length > 0) {
              stream.events.push({ event, data: JSON.parse(data.join("\n")) });
            }
          }
        });
        resolve(stream);
      },
    );
    req.on("error", (e) => {
      if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") {
        reject(e);
      }
    });
    req.end();
  });
}

/** Opens a panel and returns its id, its Zeo connection and its SSE stream. */
async function openPanel(): Promise<{ id: string; conn: V2Conn; stream: Stream }> {
  const before = fake.conns.length;
  const r = await post("/api/panels", {});
  expect(r.status).toBe(200);
  const id = (JSON.parse(r.body) as { panel: string }).panel;
  const stream = await events(id);
  expect(stream.status).toBe(200);
  const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);
  return { id, conn, stream };
}

const rpc = (id: string, msg: Record<string, unknown>) => post("/api/rpc", { panel: id, msg });

beforeAll(async () => {
  fake = await startFakeZeoV2();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
  logs = captureLogs();
  port = await freePort();
  panel = await startPanelServer({
    host: HOST,
    port,
    appUrl: APP_URL,
    root: ROOT,
    zeo: { socketPath: fake.path },
  } as never);
});

afterAll(async () => {
  await panel?.close();
  logs?.restore();
  await fake?.dispose();
  delete process.env.ZEO_DEVTOOLS_SOCKET;
});

describe("one Zeo panel session per panel", () => {
  it("POST /api/panels opens a session whose hello is a panel of this root", async () => {
    const { conn, stream } = await openPanel();
    expect(conn.hello).toMatchObject({
      v: 2,
      kind: "hello",
      client: { kind: "panel", root: ROOT },
    });
    stream.req.destroy();
  });

  it("hostile: two panels stay apart — rpc and SSE never cross", async () => {
    const a = await openPanel();
    const b = await openPanel();
    expect(a.conn).not.toBe(b.conn);
    expect(await rpc(a.id, { kind: "send", text: "only for A", attachments: [] })).toMatchObject({
      status: 204,
    });
    await a.conn.waitForLine((m) => m.kind === "send");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.conn.lines.some((l) => (l as { kind?: string }).kind === "send")).toBe(false);
    a.conn.send({ v: 2, kind: "title", title: "A's title" });
    await a.stream.waitFor("title");
    await new Promise((r) => setTimeout(r, 50));
    expect(b.stream.events.some((e) => e.event === "title")).toBe(false);
    a.stream.req.destroy();
    b.stream.req.destroy();
  });

  it("hostile: one panel's successive rpcs share one session (no session per request)", async () => {
    const before = fake.conns.length;
    const p = await openPanel();
    await rpc(p.id, { kind: "list_threads" });
    await rpc(p.id, { kind: "cancel" });
    await p.conn.waitForLine((m) => m.kind === "cancel");
    expect(fake.conns.length - before).toBe(1);
    p.stream.req.destroy();
  });
});

describe("rpc → session (R5.4, R6.3, R6.4, R6.5)", () => {
  it("list_threads, subscribe, send, cancel and authorize reach Zeo as v2 messages", async () => {
    const p = await openPanel();
    const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ kind: "list_threads" }, { v: 2, kind: "list_threads" }],
      // design.md §Panel API: the panel says `subscribe { thread_id }`; Zeo gets 0058's target form.
      [
        { kind: "subscribe", thread_id: "t1" },
        { v: 2, kind: "subscribe", target: { thread_id: "t1" } },
      ],
      [
        { kind: "send", text: "make the button blue", attachments: [] },
        { v: 2, kind: "send", text: "make the button blue" },
      ],
      [{ kind: "cancel" }, { v: 2, kind: "cancel" }],
      [
        { kind: "authorize", request_id: "q1", option_id: "o1" },
        { v: 2, kind: "authorize", request_id: "q1", option_id: "o1" },
      ],
      [{ kind: "create_thread" }, { v: 2, kind: "create_thread" }],
    ];
    for (const [msg, onWire] of cases) {
      const r = await rpc(p.id, msg);
      expect(r.status, JSON.stringify(msg)).toBe(204);
      expect(await p.conn.waitForLine((m) => m.kind === msg.kind)).toMatchObject(onWire);
    }
    p.stream.req.destroy();
  });

  it("hostile: follow, open_in_zeo and hello are refused with 400 and never reach Zeo", async () => {
    const p = await openPanel();
    const refused = [
      { kind: "subscribe", target: { follow: true } },
      { kind: "subscribe", follow: true },
      { kind: "open_in_zeo" },
      {
        kind: "hello",
        client: { kind: "dev_server", root: "/", app_url: APP_URL, panel_url: APP_URL },
      },
    ];
    for (const msg of refused) {
      const r = await rpc(p.id, msg);
      expect(r.status, JSON.stringify(msg)).toBe(400);
      expect(JSON.parse(r.body)).toHaveProperty("error");
    }
    await new Promise((r) => setTimeout(r, 50));
    const kinds = p.conn.lines.map((l) => (l as { kind?: string }).kind);
    expect(kinds.filter((k) => k === "hello")).toHaveLength(1);
    expect(kinds).not.toContain("open_in_zeo");
    expect(p.conn.lines.some((l) => JSON.stringify(l).includes('"follow"'))).toBe(false);
    p.stream.req.destroy();
  });
});

describe("session → SSE (R6.2, R6.5, R7.1, R7.3)", () => {
  it("every server message becomes one SSE event named by its kind, data unchanged", async () => {
    const p = await openPanel();
    const msgs = [
      { v: 2, kind: "threads", id: "r1", items: [threadInfo("t1"), threadInfo("t2")] },
      { v: 2, kind: "created", id: "c1", thread: threadInfo("t3") },
      {
        v: 2,
        kind: "entry_added",
        index: 0,
        entry: { role: "user", markdown: "hi", truncated: false },
      },
      {
        v: 2,
        kind: "permission_requested",
        permission: { request_id: "q1", entry_index: 0, title: "Run", options: [] },
      },
      { v: 2, kind: "project_closed" },
      { v: 2, kind: "project_open" },
    ];
    for (const m of msgs) {
      p.conn.send(m);
      expect((await p.stream.waitFor(m.kind)).data).toEqual(m);
    }
    p.stream.req.destroy();
  });

  it("events for an unknown panel id answer 404, not a stream", async () => {
    const s = await events("no-such-panel");
    expect(s.status).toBe(404);
    s.req.destroy();
  });
});

describe("lifecycle (G4, R3.7)", () => {
  it("hostile: closing the EventSource closes its Zeo session", async () => {
    const p = await openPanel();
    p.stream.req.destroy();
    await p.conn.waitClosed(3000);
  });
});

describe("connection state (A1 `event: connection`, R2.7)", () => {
  it("sends a connection event on connect, and connecting → open across a Zeo restart", async () => {
    const p = await openPanel();
    const first = await p.stream.waitWhere(() => true);
    expect(first.event, "the first event is the connection state").toBe("connection");
    await p.stream.waitWhere(
      (e) => e.event === "connection" && (e.data as { state?: string }).state === "open",
    );
    const mark = p.stream.events.length;
    await fake.restart();
    await p.stream.waitWhere(
      (e) => e.event === "connection" && (e.data as { state?: string }).state === "connecting",
      5000,
      mark,
    );
    await p.stream.waitWhere(
      (e) => e.event === "connection" && (e.data as { state?: string }).state === "open",
      5000,
      mark,
    );
    p.stream.req.destroy();
  });

  it("hostile: a Zeo that refuses the panel hello is zeo_too_old, not merely unreachable", async () => {
    const old = await startFakeZeoV2();
    old.autoWelcome = false;
    old.onLine = (conn, msg) => {
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
    const p2 = await freePort();
    const server = await startPanelServer({
      host: HOST,
      port: p2,
      appUrl: APP_URL,
      root: ROOT,
      zeo: { socketPath: old.path },
    } as never);
    try {
      const r = await post("/api/panels", {}, p2);
      expect(r.status).toBe(200);
      const stream = await events((JSON.parse(r.body) as { panel: string }).panel, p2);
      await stream.waitWhere(
        (e) => e.event === "connection" && (e.data as { state?: string }).state === "zeo_too_old",
        5000,
      );
      stream.req.destroy();
    } finally {
      await server.close();
      await old.dispose();
    }
  });
});

describe("Zeo unreachable (R6.8)", () => {
  it("hostile: rpc answers 503 zeo_unreachable and nothing is replayed when Zeo comes back", async () => {
    const absent = join(fake.dir, "later.sock");
    const p2 = await freePort();
    const server = await startPanelServer({
      host: HOST,
      port: p2,
      appUrl: APP_URL,
      root: ROOT,
      zeo: { socketPath: absent },
    } as never);
    let late: FakeZeoV2 | undefined;
    try {
      const r = await post("/api/panels", {}, p2);
      expect(r.status).toBe(200);
      const id = (JSON.parse(r.body) as { panel: string }).panel;
      const stream = await events(id, p2);
      const refused = await post(
        "/api/rpc",
        { panel: id, msg: { kind: "send", text: "while away", attachments: [] } },
        p2,
      );
      expect(refused.status).toBe(503);
      expect(JSON.parse(refused.body)).toEqual({ error: "zeo_unreachable" });

      late = await startFakeZeoV2(absent);
      const conn = await late.waitForConn((c) => c.hello !== undefined, 10_000);
      await stream.waitWhere(
        (e) => e.event === "connection" && (e.data as { state?: string }).state === "open",
        10_000,
      );
      await new Promise((r2) => setTimeout(r2, 200));
      expect(conn.lines.map((l) => (l as { kind?: string }).kind)).toEqual(["hello"]);
      stream.req.destroy();
    } finally {
      await server.close();
      await late?.dispose();
    }
  });
});

describe("logs (R9.1, R9.2)", () => {
  it("a panel session opening is logged with the root; message text and model output never are", async () => {
    const p = await openPanel();
    await rpc(p.id, { kind: "send", text: "SECRET-PROMPT-4b1e", attachments: [] });
    await p.conn.waitForLine((m) => m.kind === "send");
    p.conn.send({
      v: 2,
      kind: "entry_added",
      index: 1,
      entry: { role: "assistant", markdown: "MODEL-OUT-77aa", truncated: false },
    });
    await p.stream.waitFor("entry_added");
    p.stream.req.destroy();
    await p.conn.waitClosed(3000);
    const text = logs.text();
    expect(text).not.toContain("SECRET-PROMPT-4b1e");
    expect(text).not.toContain("MODEL-OUT-77aa");
    const withRoot = logs.events().filter((l) => keyValues(l).root === ROOT);
    expect(withRoot.length, "a key=value line names the root").toBeGreaterThan(0);
  });
});
