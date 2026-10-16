// Story 055, task 4.1, fix cycle 1 — the panel server's guards beyond the pre-authored
// panel-server.test.ts (which stays frozen): the live-panel cap (M1), symlinks out of the assets
// directory (L1), the security headers on Node's own error answers (L2), duplicated Host headers
// (I1), and the lifecycle rules first measured only by probe — one stream per panel, the 30 s
// unclaimed-panel close, the 15 s heartbeat, 413 on a chunked body and the JSON media type.
// Task 4.2 adds the bridge's own guards: the 32 MiB SSE backlog cut-off, Zeo's answers to hello
// kept until the page's stream opens, the wire `id`, the error relay (`not_found` for the bound
// thread forgets it; a fatal error closes the panel; only the code is logged), the reserved
// `connection` event, and Node's error answers letting go of a half-open socket (N2).
//
// Hostile halves first in each block; every request is raw enough (node:http with `setHost:
// false`, or a bare socket) to send what a hostile page, a DNS-rebinding name or a broken client
// would.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_MS,
  MAX_BODY_BYTES,
  FATAL_GRACE_MS,
  MAX_LIVE_PANELS,
  MAX_STREAM_BACKLOG_BYTES,
  startPanelServer,
  UNCLAIMED_PANEL_MS,
  type PanelServer,
} from "../src/panel-server.js";
import { startFakeZeoV2, type FakeZeoV2, type V2Conn } from "./helpers/fake-zeo-v2.js";

vi.setConfig({ testTimeout: 20_000 });

const HOST = "localhost";
const ROOT = "/home/dev/app";
const APP_URL = `http://${HOST}:5173`;
const SECRET = "OUTSIDE-SECRET-5c1d";
/** Real time, whatever the fake timers of a test do to the global. */
const realSetTimeout = globalThis.setTimeout;
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

let fake: FakeZeoV2;
let dir: string;
let lines: string[] = [];
const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m) };
const open: PanelServer[] = [];

async function start(
  pageDir?: string,
  socketPath = fake.path,
): Promise<{ server: PanelServer; port: number }> {
  const server = await startPanelServer({
    host: HOST,
    appUrl: APP_URL,
    root: ROOT,
    zeo: { socketPath },
    logger,
    ...(pageDir === undefined ? {} : { pageDir }),
  });
  open.push(server);
  return { server, port: Number(new URL(server.url).port) };
}

type Res = { status: number; headers: IncomingHttpHeaders; body: string };

function send(
  port: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: HOST, port, path, method, headers, setHost: false },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const good = (port: number) => ({ Host: `${HOST}:${port}`, "Sec-Fetch-Site": "same-origin" });
const goodPost = (port: number, contentType = "application/json") => ({
  ...good(port),
  Origin: `http://${HOST}:${port}`,
  "Content-Type": contentType,
});

async function newPanel(port: number): Promise<Res> {
  return send(port, "POST", "/api/panels", goodPost(port), "{}");
}
const idOf = (r: Res) => (JSON.parse(r.body) as { panel: string }).panel;

interface Stream {
  status: number;
  body: string;
  data(): string;
  /** Whether the server has ended the stream. */
  ended(): boolean;
  req: ClientRequest;
}

/** Opens a panel's event stream and keeps reading it. */
function stream(port: number, id: string): Promise<Stream> {
  return new Promise((resolve, reject) => {
    let data = "";
    const req = httpRequest(
      {
        hostname: HOST,
        port,
        path: `/api/events?panel=${encodeURIComponent(id)}`,
        headers: good(port),
        setHost: false,
      },
      (res) => {
        let ended = false;
        res.setEncoding("utf8");
        res.on("data", (c: string) => (data += c));
        res.on("end", () => (ended = true));
        const s: Stream = {
          status: res.statusCode ?? 0,
          body: "",
          data: () => data,
          ended: () => ended,
          req,
        };
        if (s.status !== 200) {
          res.on("end", () => resolve({ ...s, body: data }));
          return;
        }
        resolve(s);
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ECONNRESET") {
        reject(e);
      }
    });
    req.end();
  });
}

/** Writes `text` on a bare socket and answers everything the server wrote before closing. */
function raw(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: HOST, port }, () => socket.write(text));
    let data = "";
    socket.setEncoding("latin1");
    socket.on("data", (c: string) => (data += c));
    socket.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code !== "ECONNRESET") {
        reject(e);
      }
    });
    socket.on("close", () => resolve(data));
  });
}

/** Status and lowercased headers of a raw HTTP/1.1 answer. */
function head(answer: string): { status: number; headers: Record<string, string>; body: string } {
  const end = answer.indexOf("\r\n\r\n");
  const [statusLine, ...fields] = answer.slice(0, end).split("\r\n");
  const headers: Record<string, string> = {};
  for (const f of fields) {
    const colon = f.indexOf(":");
    headers[f.slice(0, colon).trim().toLowerCase()] = f.slice(colon + 1).trim();
  }
  return {
    status: Number(statusLine?.split(" ")[1]),
    headers,
    body: answer.slice(end + 4),
  };
}

const expectSecurityHeaders = (headers: Record<string, unknown>, what: string) => {
  expect(String(headers["content-security-policy"]), what).toContain("frame-ancestors 'none'");
  expect(String(headers["x-frame-options"]), what).toBe("DENY");
  expect(String(headers["x-content-type-options"]), what).toBe("nosniff");
  expect(String(headers["referrer-policy"]), what).toBe("no-referrer");
};

/** Polls `get` in real time until it answers something other than `undefined`. */
async function until<T>(
  get: () => T | undefined | Promise<T | undefined>,
  ms: number,
  what: string,
) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await get();
    if (v !== undefined) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    }
    await sleep(10);
  }
}

beforeAll(async () => {
  fake = await startFakeZeoV2();
  dir = await mkdtemp(join(tmpdir(), "zeo-panel-guards-"));
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((s) => s.close()));
});

afterAll(async () => {
  await fake?.dispose();
  await rm(dir, { recursive: true, force: true });
});

describe(`live-panel cap (M1): at most ${MAX_LIVE_PANELS}`, () => {
  it("hostile: the panel past the cap is refused with 503 and opens no Zeo session", async () => {
    lines = [];
    const { port } = await start();
    const before = fake.conns.length;
    const ids: string[] = [];
    for (let i = 0; i < MAX_LIVE_PANELS; i++) {
      const r = await newPanel(port);
      expect(r.status, `panel ${i + 1}`).toBe(200);
      ids.push(idOf(r));
    }
    await until(
      () => (fake.conns.length - before === MAX_LIVE_PANELS ? true : undefined),
      3000,
      `${MAX_LIVE_PANELS} Zeo sessions`,
    );

    const over = await newPanel(port);
    expect(over.status).toBe(503);
    expect(JSON.parse(over.body)).toEqual({ error: "too_many_panels" });
    await sleep(150);
    expect(fake.conns.length - before, "no session for the refused panel").toBe(MAX_LIVE_PANELS);

    const limit = lines.filter((l) => l.includes("reason=too_many_panels"));
    expect(limit).toHaveLength(1);
    expect(limit[0]).toMatch(/^zeo-devtools event=panel_limit /);
    for (const id of ids) {
      expect(lines.join("\n"), "no panel id in any log line").not.toContain(id);
    }

    // Closing a panel (its page went away) frees its place.
    const s = await stream(port, ids[0]!);
    expect(s.status).toBe(200);
    s.req.destroy();
    const again = await until(
      async () => {
        const r = await newPanel(port);
        return r.status === 200 ? r : undefined;
      },
      3000,
      "a place freed by the closed panel",
    );
    expect(idOf(again)).not.toBe(ids[0]);
    await until(
      () => (fake.conns.length - before === MAX_LIVE_PANELS + 1 ? true : undefined),
      3000,
      "the new panel's Zeo session",
    );
  });
});

describe("assets stay inside the assets directory (L1)", () => {
  it("hostile: a symlink out of assets/ answers 404 and never the file's content", async () => {
    const page = join(dir, "page");
    await mkdir(join(page, "assets", "sub"), { recursive: true });
    await writeFile(join(page, "index.html"), "<!doctype html><title>panel</title>");
    await writeFile(join(page, "assets", "ok.js"), "export {};\n");
    await writeFile(join(page, "assets", "sub", "deep.js"), "export {};\n");
    await writeFile(join(dir, "outside.txt"), SECRET);
    await symlink(join(dir, "outside.txt"), join(page, "assets", "link.js"));
    await symlink(dir, join(page, "assets", "dirlink"));
    await symlink(join(page, "assets", "ok.js"), join(page, "assets", "inner.js"));
    const { port } = await start(page);
    const get = (path: string) => send(port, "GET", path, { Host: `${HOST}:${port}` });

    for (const path of ["/assets/link.js", "/assets/dirlink/outside.txt"]) {
      const r = await get(path);
      expect(r.status, path).toBe(404);
      expect(r.body, path).not.toContain(SECRET);
      expectSecurityHeaders(r.headers, path);
    }
    // Benign: real files, nested files and a link that stays inside are served.
    for (const path of ["/assets/ok.js", "/assets/sub/deep.js", "/assets/inner.js"]) {
      const r = await get(path);
      expect(r.status, path).toBe(200);
      expect(String(r.headers["content-type"]), path).toMatch(/^text\/javascript/);
    }
    expect((await get("/")).status).toBe(200);
  });
});

describe("Node's own error answers carry the security headers (L2)", () => {
  it("hostile: a malformed request line gets 400, the headers, Connection: close, no echo", async () => {
    const { port } = await start();
    const answer = head(await raw(port, "BLAH-ECHO-7f2a\r\n\r\n"));
    expect(answer.status).toBe(400);
    expectSecurityHeaders(answer.headers, "malformed request line");
    expect(answer.headers.connection).toBe("close");
    expect(answer.body).not.toContain("ECHO-7f2a");
  });

  it("hostile: an oversized header block gets 431 with the headers", async () => {
    const { port } = await start();
    const big = "x".repeat(32 * 1024);
    const answer = head(
      await raw(port, `GET / HTTP/1.1\r\nHost: ${HOST}:${port}\r\nX-Big: ${big}\r\n\r\n`),
    );
    expect(answer.status).toBe(431);
    expectSecurityHeaders(answer.headers, "header overflow");
    expect(answer.headers.connection).toBe("close");
  });

  it("hostile: an unknown Expect gets 417 with the headers and no echo", async () => {
    const { port } = await start();
    const answer = head(
      await raw(
        port,
        `GET /api/config HTTP/1.1\r\nHost: ${HOST}:${port}\r\nExpect: weird-ECHO-9b3c\r\n` +
          "Sec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n",
      ),
    );
    expect(answer.status).toBe(417);
    expectSecurityHeaders(answer.headers, "Expect");
    expect(answer.body).not.toContain("ECHO-9b3c");
  });

  it("hostile: an HTTP/1.1 request without Host is refused for host, with the headers", async () => {
    lines = [];
    const { port } = await start();
    const answer = head(
      await raw(
        port,
        "GET /api/config HTTP/1.1\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n",
      ),
    );
    expect(answer.status).toBe(403);
    expectSecurityHeaders(answer.headers, "no Host");
    expect(lines.filter((l) => l.includes("event=panel_refused")).at(-1)).toContain("reason=host");
  });
});

describe("duplicated Host (I1)", () => {
  it("hostile: two Host headers are refused for host, in either order", async () => {
    lines = [];
    const { port } = await start();
    const mine = `${HOST}:${port}`;
    for (const [first, second] of [
      [mine, "evil.example"],
      ["evil.example", mine],
      [mine, mine],
    ]) {
      const answer = head(
        await raw(
          port,
          `GET /api/config HTTP/1.1\r\nHost: ${first}\r\nHost: ${second}\r\n` +
            "Sec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n",
        ),
      );
      expect(answer.status, `${first}, ${second}`).toBe(403);
      expect(answer.body).not.toContain("app_url");
    }
    const refused = lines.filter((l) => l.includes("event=panel_refused"));
    expect(refused).toHaveLength(3);
    for (const l of refused) {
      expect(l).toContain("reason=host");
      expect(l).not.toContain("evil.example");
    }
  });
});

describe("one event stream per panel", () => {
  it("hostile: a second stream for an open panel answers 409 and leaves the first alone", async () => {
    const { port } = await start();
    const id = idOf(await newPanel(port));
    const first = await stream(port, id);
    expect(first.status).toBe(200);
    const second = await stream(port, id);
    expect(second.status).toBe(409);
    expect(JSON.parse(second.body)).toEqual({ error: "stream_open" });
    await sleep(50);
    expect(first.req.destroyed, "the first stream is still open").toBe(false);
    first.req.destroy();
  });
});

describe("timers (G4)", () => {
  it(`hostile: a panel whose stream never opens is closed after ${UNCLAIMED_PANEL_MS} ms`, async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    lines = [];
    const { port } = await start();
    const before = fake.conns.length;
    const id = idOf(await newPanel(port));
    const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);

    vi.advanceTimersByTime(UNCLAIMED_PANEL_MS - 5_000);
    await sleep(50);
    expect(conn.closed, "still within the grace period").toBe(false);

    vi.advanceTimersByTime(5_000);
    await conn.waitClosed(3000);
    expect((await stream(port, id)).status, "the panel is gone").toBe(404);
    expect(lines.some((l) => l.includes("event=panel_closed reason=unclaimed"))).toBe(true);
  });

  it(`a ':' heartbeat comment is written every ${HEARTBEAT_MS} ms`, async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    const { port } = await start();
    const s = await stream(port, idOf(await newPanel(port)));
    expect(s.status).toBe(200);
    await until(() => (s.data().includes("event: connection") ? true : undefined), 3000, "connect");
    const beats = () =>
      s
        .data()
        .split("\n\n")
        .filter((block) => block === ":").length;

    vi.advanceTimersByTime(HEARTBEAT_MS - 1_000);
    await sleep(50);
    expect(beats(), "no heartbeat before 15 s").toBe(0);
    vi.advanceTimersByTime(1_000);
    await until(() => (beats() === 1 ? true : undefined), 3000, "the first heartbeat");
    vi.advanceTimersByTime(HEARTBEAT_MS);
    await until(() => (beats() === 2 ? true : undefined), 3000, "the second heartbeat");
    s.req.destroy();
  });
});

describe("POST bodies", () => {
  it("hostile: a chunked body past 8 MiB (no Content-Length) answers 413", async () => {
    const { port } = await start();
    const answer = await new Promise<Res>((resolve, reject) => {
      let got: Res | undefined;
      const req = httpRequest(
        {
          hostname: HOST,
          port,
          path: "/api/rpc",
          method: "POST",
          headers: goodPost(port),
          setHost: false,
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            got = { status: res.statusCode ?? 0, headers: res.headers, body: data };
            resolve(got);
          });
        },
      );
      req.on("error", (e) => (got === undefined ? reject(e) : undefined));
      expect(req.getHeader("content-length")).toBeUndefined();
      const chunk = Buffer.alloc(1024 * 1024, 0x20);
      let sent = 0;
      const pump = () => {
        while (got === undefined && !req.destroyed && sent <= MAX_BODY_BYTES) {
          sent += chunk.length;
          if (!req.write(chunk)) {
            req.once("drain", pump);
            return;
          }
        }
        if (!req.destroyed) {
          req.end();
        }
      };
      pump();
    });
    expect(answer.status).toBe(413);
    expect(JSON.parse(answer.body)).toEqual({ error: "body_too_large" });
    expect(answer.headers.connection).toBe("close");
    expectSecurityHeaders(answer.headers, "413");
  });

  it("Content-Type: application/json with parameters or in any case is accepted", async () => {
    const { port } = await start();
    for (const type of ["application/json; charset=utf-8", "Application/JSON ; charset=UTF-8"]) {
      const r = await send(port, "POST", "/api/panels", goodPost(port, type), "{}");
      expect(r.status, type).toBe(200);
    }
  });

  it("hostile: look-alike and simple-request media types answer 415", async () => {
    const { port } = await start();
    for (const type of [
      "application/jsonx",
      "application/json-seq",
      "text/plain; charset=utf-8",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
    ]) {
      const r = await send(port, "POST", "/api/panels", goodPost(port, type), "{}");
      expect(r.status, type).toBe(415);
    }
  });
});

// ---- Task 4.2: the bridge ---------------------------------------------------------------------

type SseEvent = { event: string; data: Record<string, unknown> };

/** The complete SSE events of a stream so far, comments (heartbeats) left out. */
function sseEvents(data: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of data.split("\n\n").slice(0, -1)) {
    let event = "message";
    let payload: string | undefined;
    for (const line of block.split("\n")) {
      if (line.startsWith("event: ")) {
        event = line.slice(7);
      } else if (line.startsWith("data: ")) {
        payload = line.slice(6);
      }
    }
    if (payload !== undefined) {
      out.push({ event, data: JSON.parse(payload) as Record<string, unknown> });
    }
  }
  return out;
}

const rpc = (port: number, panel: string, msg: Record<string, unknown>) =>
  send(port, "POST", "/api/rpc", goodPost(port), JSON.stringify({ panel, msg }));

/** A panel on `port` with its stream open and its Zeo session welcomed. */
async function openBridged(port: number, zeo: FakeZeoV2) {
  const before = zeo.conns.length;
  const id = idOf(await newPanel(port));
  const s = await stream(port, id);
  expect(s.status).toBe(200);
  const conn = await zeo.waitForConn((c) => c.n >= before && c.hello !== undefined);
  await until(
    () =>
      sseEvents(s.data()).some((e) => e.event === "connection" && e.data.state === "open")
        ? true
        : undefined,
    3000,
    "the open state",
  );
  return { id, s, conn };
}

const kindsOn = (conn: V2Conn) => conn.lines.map((l) => (l as { kind?: string }).kind);

describe("SSE backlog cut-off (4.2)", () => {
  it(`hostile: a page that stops reading is dropped past ${MAX_STREAM_BACKLOG_BYTES} queued bytes`, async () => {
    lines = [];
    const { port } = await start();
    const before = fake.conns.length;
    const id = idOf(await newPanel(port));
    const req = httpRequest(
      {
        hostname: HOST,
        port,
        path: `/api/events?panel=${id}`,
        headers: good(port),
        setHost: false,
      },
      // Reads nothing: the kernel buffers fill, then the server's own queue grows.
      (res) => res.pause(),
    );
    req.on("error", () => {});
    req.end();
    const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);
    await sleep(100);
    const big = "x".repeat(4 * 1024 * 1024);
    for (let i = 0; i < (MAX_STREAM_BACKLOG_BYTES / big.length) * 2; i++) {
      conn.send({ v: 2, kind: "title", title: big });
    }
    await conn.waitClosed(10_000);
    expect(lines.filter((l) => l.includes("event=panel_closed reason=backlog"))).toHaveLength(1);
    expect((await stream(port, id)).status, "the panel is gone").toBe(404);
    req.destroy();
  });

  it("converse: a page that reads keeps its stream through the same volume", async () => {
    lines = [];
    const { port } = await start();
    const { s, conn } = await openBridged(port, fake);
    const big = "y".repeat(4 * 1024 * 1024);
    const count = (MAX_STREAM_BACKLOG_BYTES / big.length) * 2;
    for (let i = 0; i < count; i++) {
      conn.send({ v: 2, kind: "title", title: big });
    }
    await until(
      () => (s.data().split("event: title").length - 1 === count ? true : undefined),
      15_000,
      "every title",
    );
    expect(lines.some((l) => l.includes("reason=backlog"))).toBe(false);
    expect(conn.closed).toBe(false);
    s.req.destroy();
  });
});

describe("Zeo's answers before the stream opens (4.2)", () => {
  it("project_closed sent before the page connects reaches it, after the connection event", async () => {
    const { port } = await start();
    const before = fake.conns.length;
    const id = idOf(await newPanel(port));
    const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);
    conn.send({ v: 2, kind: "project_closed" });
    await sleep(100);
    const s = await stream(port, id);
    await until(
      () => (sseEvents(s.data()).some((e) => e.event === "project_closed") ? true : undefined),
      3000,
      "project_closed",
    );
    const events = sseEvents(s.data()).map((e) => e.event);
    expect(events[0]).toBe("connection");
    expect(events).toContain("welcome");
    expect(events.indexOf("welcome")).toBeLessThan(events.indexOf("project_closed"));
    s.req.destroy();
  });
});

describe("the wire id (4.2, 0058 requires one)", () => {
  it("a request without id gets a fresh one; a page's own id is kept", async () => {
    const { port } = await start();
    const { id, s, conn } = await openBridged(port, fake);
    expect((await rpc(port, id, { kind: "list_threads" })).status).toBe(204);
    expect((await rpc(port, id, { kind: "cancel", id: "page-7" })).status).toBe(204);
    const sent = await conn.waitForLine((m) => m.kind === "list_threads");
    expect(typeof sent.id).toBe("string");
    expect(String(sent.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(await conn.waitForLine((m) => m.kind === "cancel")).toEqual({
      v: 2,
      kind: "cancel",
      id: "page-7",
    });
    s.req.destroy();
  });
});

describe("errors from Zeo (4.2)", () => {
  it("each code is relayed as an SSE error event, data unchanged; only the code is logged", async () => {
    lines = [];
    const { port } = await start();
    const { s, conn } = await openBridged(port, fake);
    const codes = [
      "ai_disabled",
      "not_found",
      "project_closed",
      "agent_start_failed",
      "bad_request",
    ];
    for (const code of codes) {
      conn.send({
        v: 2,
        kind: "error",
        id: "r1",
        error: code,
        message: `TEXT-${code}`,
        fatal: false,
      });
    }
    await until(
      () =>
        sseEvents(s.data()).filter((e) => e.event === "error").length === codes.length
          ? true
          : undefined,
      3000,
      "every error event",
    );
    const errors = sseEvents(s.data()).filter((e) => e.event === "error");
    expect(errors.map((e) => e.data.error)).toEqual(codes);
    expect(errors[0]!.data).toEqual({
      v: 2,
      kind: "error",
      id: "r1",
      error: "ai_disabled",
      message: "TEXT-ai_disabled",
      fatal: false,
    });
    const logged = lines.filter((l) => l.includes("event=zeo_error"));
    expect(logged.map((l) => /code=(\S+)/.exec(l)?.[1])).toEqual(codes);
    expect(lines.join("\n")).not.toContain("TEXT-");
    expect(s.req.destroyed, "a non-fatal error keeps the panel").toBe(false);
    expect(conn.closed).toBe(false);
    s.req.destroy();
  });

  it("hostile: an error code that is not a plain token is logged as other", async () => {
    lines = [];
    const { port } = await start();
    const { s, conn } = await openBridged(port, fake);
    conn.send({ v: 2, kind: "error", error: "x y=evil\nINJECTED", message: "m", fatal: false });
    await until(
      () => (lines.some((l) => l.includes("event=zeo_error")) ? true : undefined),
      3000,
      "log",
    );
    expect(lines.find((l) => l.includes("event=zeo_error"))).toContain("code=other");
    expect(lines.join("\n")).not.toContain("INJECTED");
    s.req.destroy();
  });

  it("a fatal error reaches the page, then the panel and its session close", async () => {
    const { port } = await start();
    const { id, s, conn } = await openBridged(port, fake);
    conn.send({ v: 2, kind: "error", error: "unsupported_version", message: "m", fatal: true });
    await conn.waitClosed(3000);
    await until(
      () =>
        sseEvents(s.data()).some((e) => e.event === "error" && e.data.fatal === true)
          ? true
          : undefined,
      3000,
      "the fatal error event",
    );
    expect((await stream(port, id)).status).toBe(404);
  });
});

describe("the bound thread (4.2, R5.8)", () => {
  /** A panel on its own Zeo, subscribed to t1 with the page id `pageId`; answers the wire id. */
  async function bound(zeo: FakeZeoV2, port: number, pageId: string | undefined) {
    const p = await openBridged(port, zeo);
    const msg = {
      kind: "subscribe",
      thread_id: "t1",
      ...(pageId === undefined ? {} : { id: pageId }),
    };
    expect((await rpc(port, p.id, msg)).status).toBe(204);
    const sub = await p.conn.waitForLine((m) => m.kind === "subscribe");
    return { ...p, wireId: String(sub.id) };
  }

  /** Restarts `zeo` and answers the kinds the panel's new connection sent. */
  async function reconnectKinds(zeo: FakeZeoV2) {
    const before = zeo.conns.length;
    await zeo.restart();
    const again = await zeo.waitForConn((c) => c.n >= before && c.hello !== undefined, 10_000);
    await sleep(200);
    return kindsOn(again);
  }

  const notFound = (id: string) => ({
    v: 2,
    kind: "error",
    id,
    error: "not_found",
    message: "m",
    fatal: false,
  });

  async function withZeo(body: (zeo: FakeZeoV2, port: number) => Promise<void>) {
    const zeo = await startFakeZeoV2();
    try {
      const { port } = await start(undefined, zeo.path);
      await body(zeo, port);
    } finally {
      await zeo.dispose();
    }
  }

  it("a subscribe goes out under the bridge's own id; Zeo's answers carry the page's id back", () =>
    withZeo(async (zeo, port) => {
      const { s, conn, wireId } = await bound(zeo, port, "s1");
      expect(wireId).not.toBe("s1");
      expect(wireId).toMatch(/^[0-9a-f-]{36}$/);
      conn.send({ ...snapshotFor("t1"), id: wireId });
      const snap = await until(
        () => sseEvents(s.data()).find((e) => e.event === "snapshot"),
        3000,
        "snapshot",
      );
      expect(snap.data.id).toBe("s1");
      s.req.destroy();
    }));

  it("hostile: not_found for the subscribe forgets it — a reconnect says hello only", () =>
    withZeo(async (zeo, port) => {
      const { s, conn, wireId } = await bound(zeo, port, "s1");
      conn.send(notFound(wireId));
      const err = await until(
        () => sseEvents(s.data()).find((e) => e.event === "error"),
        3000,
        "error",
      );
      expect(err.data.id, "the page reads its own id").toBe("s1");
      expect(await reconnectKinds(zeo)).toEqual(["hello"]);
      s.req.destroy();
    }));

  it("converse: not_found for another request keeps the subscription across a reconnect", () =>
    withZeo(async (zeo, port) => {
      const { s, conn } = await bound(zeo, port, "s2");
      conn.send(notFound("other"));
      await until(() => sseEvents(s.data()).find((e) => e.event === "error"), 3000, "error");
      expect(await reconnectKinds(zeo)).toEqual(["hello", "subscribe"]);
      s.req.destroy();
    }));

  it("hostile (L2): a page id reused by a cancel — its not_found keeps the subscription", () =>
    withZeo(async (zeo, port) => {
      const { id, s, conn } = await bound(zeo, port, "dup");
      expect((await rpc(port, id, { kind: "cancel", id: "dup" })).status).toBe(204);
      const cancel = await conn.waitForLine((m) => m.kind === "cancel");
      expect(cancel.id).toBe("dup");
      conn.send(notFound("dup"));
      await until(() => sseEvents(s.data()).find((e) => e.event === "error"), 3000, "error");
      expect(await reconnectKinds(zeo)).toEqual(["hello", "subscribe"]);
      s.req.destroy();
    }));

  it("hostile (L2, reverse order): a send in flight under the id a subscribe reuses", () =>
    withZeo(async (zeo, port) => {
      const p = await openBridged(port, zeo);
      const send = { kind: "send", text: "t", attachments: [], id: "x" };
      expect((await rpc(port, p.id, send)).status).toBe(204);
      expect((await rpc(port, p.id, { kind: "subscribe", thread_id: "t1", id: "x" })).status).toBe(
        204,
      );
      await p.conn.waitForLine((m) => m.kind === "subscribe");
      // The late answer to the send, not to the subscribe.
      p.conn.send(notFound("x"));
      await until(() => sseEvents(p.s.data()).find((e) => e.event === "error"), 3000, "error");
      expect(await reconnectKinds(zeo)).toEqual(["hello", "subscribe"]);
      p.s.req.destroy();
    }));
});

/** A minimal 0058 snapshot of `thread_id`, as Zeo answers a subscribe. */
const snapshotFor = (thread_id: string) => ({
  v: 2,
  kind: "snapshot",
  thread: {
    thread_id,
    title: thread_id,
    project: ROOT,
    agent: "Claude Agent",
    status: "idle",
    followed: false,
  },
  earlier: 0,
  entries: [],
  status: { state: "idle", message: null },
  permissions: [],
});

describe("relayed kinds are an allowlist (4.2, L1)", () => {
  const ALLOWED = [
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
  ];

  it("hostile: open, message, connection, kinds no panel gets and a 5000-char kind are dropped", async () => {
    lines = [];
    const { port } = await start();
    const { s, conn } = await openBridged(port, fake);
    const mark = sseEvents(s.data()).length;
    const long = "k".repeat(5000);
    const refused = [
      "open",
      "message",
      "connection",
      "target_changed",
      "approval_pending",
      "bridge_closed",
      "zz_unknown",
      long,
    ];
    for (const kind of refused) {
      conn.send({ v: 2, kind, state: "zeo_too_old", secret: "DROPPED-CONTENT" });
    }
    conn.send({ v: 2, kind: "title", title: "after" });
    await until(() => sseEvents(s.data()).find((e) => e.event === "title"), 3000, "title");
    const events = sseEvents(s.data())
      .slice(mark)
      .map((e) => e.event);
    expect(events).toEqual(["title"]);
    expect(s.data()).not.toContain("event: open");
    expect(s.data()).not.toContain("event: message");
    expect(s.data()).not.toContain(long);
    const dropped = lines.filter((l) => l.includes("event=frame_dropped reason=bad_kind"));
    expect(dropped).toHaveLength(refused.length);
    expect(lines.join("\n")).not.toContain("DROPPED-CONTENT");
    expect(lines.join("\n")).not.toContain("kkkkkkkk");
    s.req.destroy();
  });

  it("each allowed kind is relayed as its own event", async () => {
    const { port } = await start();
    const { s, conn } = await openBridged(port, fake);
    const mark = sseEvents(s.data()).length;
    for (const kind of ALLOWED) {
      conn.send(kind === "error" ? { ...notFoundLike(), kind } : { v: 2, kind });
    }
    await until(
      () => (sseEvents(s.data()).length - mark === ALLOWED.length ? true : undefined),
      3000,
      "every allowed kind",
    );
    expect(
      sseEvents(s.data())
        .slice(mark)
        .map((e) => e.event),
    ).toEqual(ALLOWED);
    s.req.destroy();
  });
});

const notFoundLike = () => ({
  v: 2,
  kind: "error",
  error: "not_found",
  message: "m",
  fatal: false,
});

describe("a fatal error before the stream opens (4.2, N2)", () => {
  const fatalError = {
    v: 2,
    kind: "error",
    error: "unsupported_version",
    message: "m",
    fatal: true,
  };

  async function fatalBeforeStream() {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
      shouldAdvanceTime: true,
    });
    const { port } = await start();
    const before = fake.conns.length;
    const id = idOf(await newPanel(port));
    const conn = await fake.waitForConn((c) => c.n >= before && c.hello !== undefined);
    conn.send(fatalError);
    await conn.waitClosed(3000);
    return { port, id };
  }

  it(`a page connecting within ${FATAL_GRACE_MS} ms reads connection, then the error, then the end`, async () => {
    const { port, id } = await fatalBeforeStream();
    vi.advanceTimersByTime(FATAL_GRACE_MS - 1_000);
    const s = await stream(port, id);
    expect(s.status).toBe(200);
    await until(() => (s.ended() ? true : undefined), 3000, "the stream to end");
    const events = sseEvents(s.data());
    expect(events.map((e) => e.event)).toEqual(["connection", "error"]);
    expect(events[1]!.data).toEqual(fatalError);
    await sleep(50);
    expect((await stream(port, id)).status, "then the panel is gone").toBe(404);
  });

  it(`hostile: after ${FATAL_GRACE_MS} ms the held panel is gone (404)`, async () => {
    const { port, id } = await fatalBeforeStream();
    vi.advanceTimersByTime(FATAL_GRACE_MS + 1);
    await sleep(20);
    expect((await stream(port, id)).status).toBe(404);
  });
});

describe("Node's error answers let go of the socket (N2)", () => {
  /** Open TCP sockets of this process, client and server ends alike. */
  const tcpSockets = () =>
    process.getActiveResourcesInfo().filter((r) => r === "TCPSocketWrap").length;

  it("hostile: a client that keeps its side open after a 400 does not keep the server's socket", async () => {
    const { port } = await start();
    await sleep(50);
    const baseline = tcpSockets();
    const socket = connect({ host: HOST, port, allowHalfOpen: true }, () =>
      socket.write("BLAH\r\n\r\n"),
    );
    socket.on("error", () => {});
    socket.resume();
    try {
      // The answer arrives and the server ends its half; this client never ends its own.
      await new Promise<void>((resolve) => socket.once("end", () => resolve()));
      await until(
        () => (tcpSockets() === baseline + 1 ? true : undefined),
        2000,
        "the server's end of the socket to close (only the client's left)",
      );
    } finally {
      socket.destroy();
    }
  });
});
