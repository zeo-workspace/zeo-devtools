// Story 055, task 17.2 (refine v3) — the plugin logs every thread action a panel takes
// (design.md §A1 "Thread actions logged (v3)"). Requirements: R9.1, R9.2 (Q15).
// Validation filter: `npm test -- panel-server.log`. Found by 16.2's GUI proof: the plugin wrote no
// line for `create_thread` or `send`, while R9.1 requires one per thread action.
//
// Contract (design.md §A1): where `/api/rpc` relays `create_thread` and `send`, the panel server
// writes `zeo-devtools event=panel_create_thread` and `zeo-devtools event=panel_send` through the
// plugin's key=value logger, with `root`, `panel`, `thread` and the `outcome` — never the text.
// `thread` is the thread the action concerns: the one Zeo created, and the bound (subscribed)
// thread a `send` goes to.
//
// Seams as in panel-bridge.test.ts: `startPanelServer({ host, port, appUrl, root, zeo })`, the v2
// fake Zeo (answers `created`, `snapshot` and `sent` here), `captureLogs` + `keyValues`. Real
// servers and sockets.
//
// Hostile halves first:
//   - one line PER action: two identical sends give two lines (not collapsed), a create_thread
//     gives no `panel_send` and a send no `panel_create_thread` (not crossed);
//   - `panel` tells panels apart: two panels' lines carry different `panel` values;
//   - `outcome` means something: a send Zeo received and a send refused because Zeo is away (503)
//     do not log the same outcome;
//   - R9.2: a send carrying a secret-looking text logs no part of it, under any key.
import { request as httpRequest, type ClientRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startPanelServer } from "../src/panel-server.js";
import { captureLogs, keyValues, type Captured } from "./helpers/capture-logs.js";
import { startFakeZeoV2, threadInfo, type FakeZeoV2, type V2Conn } from "./helpers/fake-zeo-v2.js";

vi.setConfig({ testTimeout: 20_000 });

const HOST = "localhost";
const ROOT = "/home/dev/app";
const APP_URL = `http://${HOST}:5173`;
const SECRET = "sk-ant-api03-Q7vX2mN9pL4kR8sT1wY6zB3cD5fG0hJ-AAAA";

let fake: FakeZeoV2;
let panel: { url: string; close(): Promise<void> };
let port: number;
let logs: Captured;
let created = 0;

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

function post(path: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: HOST,
        port,
        path,
        method: "POST",
        setHost: false,
        headers: {
          Host: `${HOST}:${port}`,
          Origin: `http://${HOST}:${port}`,
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
  events: SseEvent[];
  req: ClientRequest;
  waitWhere(pred: (e: SseEvent) => boolean, ms?: number, from?: number): Promise<SseEvent>;
}

/** The SSE stream, opened the way an EventSource does. */
function events(id: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: HOST,
        port,
        path: `/api/events?panel=${encodeURIComponent(id)}`,
        method: "GET",
        setHost: false,
        headers: {
          Host: `${HOST}:${port}`,
          "Sec-Fetch-Site": "same-origin",
          Accept: "text/event-stream",
        },
      },
      (res) => {
        let buf = "";
        const stream: Stream = {
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
                  `no matching SSE event within ${ms} ms; got ${stream.events.map((e) => e.event).join(",")}`,
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

const isOpen = (e: SseEvent) =>
  e.event === "connection" && (e.data as { state?: string }).state === "open";

/** A panel whose Zeo session is open: its id, its Zeo connection and its stream. */
async function openPanel(): Promise<{ id: string; conn: V2Conn; stream: Stream }> {
  const before = fake.conns.length;
  const r = await post("/api/panels", {});
  expect(r.status).toBe(200);
  const id = (JSON.parse(r.body) as { panel: string }).panel;
  const stream = await events(id);
  const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);
  opened.push({ conn, stream });
  await stream.waitWhere(isOpen);
  return { id, conn, stream };
}

/** Every panel a test opened; closed after each test, as the server caps live panels. */
const opened: { conn: V2Conn; stream: Stream }[] = [];

afterEach(async () => {
  for (const p of opened.splice(0)) {
    p.stream.req.destroy();
    await p.conn.waitClosed(3000);
  }
});

const rpc = (id: string, msg: Record<string, unknown>) => post("/api/rpc", { panel: id, msg });

/** The `event=<name>` lines, parsed, written since `from` lines were captured. */
const linesOf = (name: string, from = 0) =>
  logs.lines
    .slice(from)
    .filter((l) => new RegExp(`zeo-devtools event=${name}(\\s|$)`).test(l))
    .map((l) => ({ raw: l, kv: keyValues(l) }));

async function waitForLines(name: string, count: number, from: number, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const found = linesOf(name, from);
    if (found.length >= count) {
      return found;
    }
    if (Date.now() > end) {
      throw new Error(
        `expected ${count} event=${name} line(s) within ${ms} ms, got ${found.length}:\n${logs.lines.slice(from).join("\n")}`,
      );
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Binds `threadId` on the panel (subscribe answered with its snapshot). */
async function bind(p: { id: string; stream: Stream }, threadId: string) {
  expect(await rpc(p.id, { kind: "subscribe", id: "s1", thread_id: threadId })).toMatchObject({
    status: 204,
  });
  await p.stream.waitWhere((e) => e.event === "snapshot");
}

function expectWellFormed(line: { raw: string; kv: Record<string, string> }, thread: string) {
  expect(line.kv.root, `root in: ${line.raw}`).toBe(ROOT);
  expect(line.kv.panel ?? "", `panel in: ${line.raw}`).not.toBe("");
  expect(line.kv.thread, `thread in: ${line.raw}`).toBe(thread);
  expect(line.kv.outcome ?? "", `outcome in: ${line.raw}`).not.toBe("");
  // Every field parses as key=value: nothing left over once the pairs are taken out.
  const rest = line.raw
    .slice(line.raw.indexOf("zeo-devtools "))
    .replace(/([a-z_]+)=("(?:[^"\\]|\\.)*"|\S+)/g, "")
    .replace("zeo-devtools", "")
    .trim();
  expect(rest, `stray text in: ${line.raw}`).toBe("");
}

beforeAll(async () => {
  fake = await startFakeZeoV2();
  fake.onLine = (conn, msg) => {
    const id = typeof msg.id === "string" ? msg.id : undefined;
    switch (msg.kind) {
      case "create_thread":
        created += 1;
        conn.send({
          v: 2,
          kind: "created",
          id,
          thread: threadInfo(`t-new-${created}`, "New", ROOT),
        });
        break;
      case "subscribe": {
        const target = (msg.target as { thread_id?: string } | undefined)?.thread_id ?? "";
        conn.send({
          v: 2,
          kind: "snapshot",
          id,
          thread: threadInfo(target, target, ROOT),
          earlier: 0,
          entries: [],
          status: { state: "idle", message: null },
          permissions: [],
        });
        break;
      }
      case "send":
        conn.send({ v: 2, kind: "sent", id, queued: false, images: "none" });
        break;
    }
  };
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

// ---- hostile: one line per action, never collapsed or crossed ----------------------------------

describe("one line per thread action (R9.1)", () => {
  it("hostile: a create_thread writes exactly one panel_create_thread line, naming the created thread, and no panel_send", async () => {
    const p = await openPanel();
    const from = logs.lines.length;
    expect(await rpc(p.id, { kind: "create_thread", id: "c1" })).toMatchObject({ status: 204 });
    const answer = await p.stream.waitWhere((e) => e.event === "created");
    const threadId = (answer.data as { thread: { thread_id: string } }).thread.thread_id;

    const [line] = await waitForLines("panel_create_thread", 1, from);
    await new Promise((r) => setTimeout(r, 100));
    expect(linesOf("panel_create_thread", from), "exactly one line").toHaveLength(1);
    expectWellFormed(line!, threadId);
    expect(linesOf("panel_send", from), "a create is not a send").toHaveLength(0);
  });

  it("hostile: two identical sends write two panel_send lines naming the bound thread, and no panel_create_thread", async () => {
    const p = await openPanel();
    await bind(p, "t-bound");
    const from = logs.lines.length;
    for (const id of ["m1", "m2"]) {
      expect(
        await rpc(p.id, { kind: "send", id, text: "same words", attachments: [] }),
      ).toMatchObject({ status: 204 });
      await p.stream.waitWhere((e) => e.event === "sent" && (e.data as { id?: string }).id === id);
    }
    const lines = await waitForLines("panel_send", 2, from);
    await new Promise((r) => setTimeout(r, 100));
    expect(linesOf("panel_send", from), "one line per send, not one per text").toHaveLength(2);
    for (const line of lines) {
      expectWellFormed(line, "t-bound");
    }
    expect(linesOf("panel_create_thread", from), "a send is not a create").toHaveLength(0);
  });

  it("hostile: two panels' lines carry different `panel` values", async () => {
    const a = await openPanel();
    const b = await openPanel();
    await bind(a, "t-a");
    await bind(b, "t-b");
    const from = logs.lines.length;
    await rpc(a.id, { kind: "send", id: "ma", text: "from a", attachments: [] });
    await rpc(b.id, { kind: "send", id: "mb", text: "from b", attachments: [] });
    const lines = await waitForLines("panel_send", 2, from);
    const byThread = new Map(lines.map((l) => [l.kv.thread, l.kv.panel]));
    expect(byThread.get("t-a") ?? "").not.toBe("");
    expect(byThread.get("t-b") ?? "").not.toBe("");
    expect(byThread.get("t-a"), "panel identifies the panel").not.toBe(byThread.get("t-b"));
  });
});

// ---- R9.2: never the text ---------------------------------------------------------------------

describe("no message text in the log (R9.2)", () => {
  it("hostile: a send carrying a secret-looking text logs no part of it, under any key", async () => {
    const p = await openPanel();
    await bind(p, "t-secret");
    const from = logs.lines.length;
    const text = `deploy with ${SECRET} please`;
    expect(await rpc(p.id, { kind: "send", id: "m-secret", text, attachments: [] })).toMatchObject({
      status: 204,
    });
    const [line] = await waitForLines("panel_send", 1, from);
    expectWellFormed(line!, "t-secret");
    expect(line!.kv.text, "no text field").toBeUndefined();
    const written = logs.lines.slice(from).join("\n");
    expect(written).not.toContain(SECRET);
    // No fragment either: neither half of the key, nor the words around it.
    expect(written).not.toContain(SECRET.slice(0, 16));
    expect(written).not.toContain(SECRET.slice(-16));
    expect(written).not.toContain("deploy with");
  });
});

// ---- outcome distinguishes a delivered send from a refused one ---------------------------------

describe("the outcome field (R9.1)", () => {
  it("hostile: a send refused because Zeo is away does not log the outcome of a delivered send", async () => {
    const p = await openPanel();
    await bind(p, "t-out");
    const from = logs.lines.length;
    await rpc(p.id, { kind: "send", id: "m-ok", text: "delivered", attachments: [] });
    const [delivered] = await waitForLines("panel_send", 1, from);

    // Zeo goes away: the panel's session leaves `open`, and a send is refused with 503.
    const seen = p.stream.events.length;
    await fake.stop();
    await p.stream.waitWhere(
      (e) => e.event === "connection" && (e.data as { state?: string }).state !== "open",
      5000,
      seen,
    );
    const mid = logs.lines.length;
    const refused = await rpc(p.id, {
      kind: "send",
      id: "m-503",
      text: "refused",
      attachments: [],
    });
    expect(refused.status).toBe(503);
    const [line] = await waitForLines("panel_send", 1, mid);
    expect(line!.kv.root).toBe(ROOT);
    expect(line!.kv.outcome ?? "").not.toBe("");
    expect(line!.kv.outcome, "a refused send is not logged as delivered").not.toBe(
      delivered!.kv.outcome,
    );
  });
});
