// Story 055, task 4.1 — the panel server: routes, request checks, security headers, close
// (design.md §A1, §Security Considerations, GOTCHA G3). Requirements: R3.1, R3.3, R3.4, R3.7,
// R9.1, R9.2, R9.3 (Q4, Q5, Q15, Q16). Validation filter: `npm test -- panel-server`.
// Amended contract: `GET /api/config` → `{ app_url, root }` under the same checks as every
// `/api/*` route (the page builds its iframe from it).
//
// Contract (design.md §A1): `startPanelServer({ host, port, appUrl, root, zeo })` →
// `Promise<{ url: string; close(): Promise<void> }>`; routes `GET /`, `GET /assets/*`,
// `POST /api/panels` → `{ panel }`, `GET /api/events?panel=<id>` (SSE), `POST /api/rpc`.
// Checks on every `/api/*` request, in order: Host (`reason=host`), Origin — when present it must
// equal the panel origin, and a POST must carry it (`reason=origin`) — then
// `Sec-Fetch-Site: same-origin` (`reason=fetch_site`); a failure is 403 and one log line
// `zeo-devtools event=panel_refused reason=…`.
// `zeo` is `{ socketPath }` (design.md §A1, now explicit); `$ZEO_DEVTOOLS_SOCKET` is set to the
// same path as well.
//
// Requests go through `node:http` so Host, Origin and Sec-Fetch-Site can be set to what a hostile
// page or a DNS-rebinding attacker would send.
//
// Hostile halves first, for each check:
//   - Host: another name, `127.0.0.1` for a panel bound to `localhost` (same machine, different
//     host — a rebinding name resolves there too), and the APP's port on the panel's name;
//   - Origin: the APP's origin (same site, different origin — exactly what an app script sends),
//     `null`, and a POST with NO Origin are refused; a GET with no Origin MUST pass (G3: the panel's
//     own EventSource sends none);
//   - Sec-Fetch-Site: `same-site` (the app), `cross-site`, `none` and a missing header are refused;
//   - order: a request wrong on Host AND Origin is refused for `host`;
//   - Content-Type: a text/plain POST (a CORS "simple request") is refused.
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPanelServer } from "../src/panel-server.js";
import { captureLogs, keyValues, type Captured } from "./helpers/capture-logs.js";
import { startFakeZeoV2, type FakeZeoV2 } from "./helpers/fake-zeo-v2.js";

// Real servers and sockets: waits carry their own messages, so the test budget sits above them.
vi.setConfig({ testTimeout: 20_000 });

const HOST = "localhost";
const ROOT = "/home/dev/app";
const APP_PORT = 5173;
const APP_URL = `http://${HOST}:${APP_PORT}`;

type Res = { status: number; headers: IncomingHttpHeaders; body: string };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

let fake: FakeZeoV2;
let panel: { url: string; close(): Promise<void> };
let port: number;
let origin: string;
let logs: Captured;

async function start(p?: number) {
  return startPanelServer({
    host: HOST,
    port: p,
    appUrl: APP_URL,
    root: ROOT,
    zeo: { socketPath: fake.path },
  } as never);
}

/** One request to `targetPort`; `abortAfterHeaders` for SSE streams that never end. */
function sendTo(
  targetPort: number,
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string | undefined>,
  body?: string,
  abortAfterHeaders = false,
): Promise<Res> {
  const clean = Object.fromEntries(
    Object.entries(headers).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: HOST, port: targetPort, path, method, headers: clean, setHost: false },
      (res) => {
        if (abortAfterHeaders) {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
          req.destroy();
          return;
        }
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }),
        );
      },
    );
    req.on("error", reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

const send = (
  method: "GET" | "POST",
  path: string,
  headers: Record<string, string | undefined>,
  body?: string,
  abortAfterHeaders = false,
) => sendTo(port, method, path, headers, body, abortAfterHeaders);

const good = (extra: Record<string, string | undefined> = {}, p = port) => ({
  Host: `${HOST}:${p}`,
  "Sec-Fetch-Site": "same-origin",
  ...extra,
});
const goodPost = (extra: Record<string, string | undefined> = {}, p = port) =>
  good({ Origin: `http://${HOST}:${p}`, "Content-Type": "application/json", ...extra }, p);

const refusals = () =>
  logs
    .events()
    .filter((l) => l.includes("event=panel_refused"))
    .map((l) => keyValues(l).reason);

async function expectRefused(res: Promise<Res>, reason: "host" | "origin" | "fetch_site") {
  const before = refusals().length;
  const r = await res;
  expect(r.status).toBe(403);
  const after = refusals();
  expect(after.length, "one panel_refused line per refusal").toBe(before + 1);
  expect(after.at(-1)).toBe(reason);
}

beforeAll(async () => {
  fake = await startFakeZeoV2();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
  logs = captureLogs();
  port = await freePort();
  panel = await start(port);
  origin = `http://${HOST}:${port}`;
});

afterAll(async () => {
  await panel?.close();
  logs?.restore();
  await fake?.dispose();
  delete process.env.ZEO_DEVTOOLS_SOCKET;
});

describe("where it listens (R3.1)", () => {
  it("serves on the app's host at the requested port, and says so in its url", () => {
    const u = new URL(panel.url);
    expect(u.hostname).toBe(HOST);
    expect(Number(u.port)).toBe(port);
    expect(u.origin).toBe(origin);
  });

  it("with no port, picks a free one (never the app's)", async () => {
    const other = await start(undefined);
    try {
      const u = new URL(other.url);
      expect(u.hostname).toBe(HOST);
      expect(Number(u.port)).toBeGreaterThan(0);
      expect(Number(u.port)).not.toBe(port);
      expect(Number(u.port)).not.toBe(APP_PORT);
    } finally {
      await other.close();
    }
  });
});

describe("Host check (R3.3, DNS rebinding)", () => {
  it("hostile: another host name is refused", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ Host: `evil.example:${port}` }), "{}"),
      "host",
    );
  });
  it("hostile: 127.0.0.1 is not the panel's host when it is bound as localhost", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ Host: `127.0.0.1:${port}` }), "{}"),
      "host",
    );
  });
  it("hostile: the app's port on the panel's name is refused", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ Host: `${HOST}:${APP_PORT}` }), "{}"),
      "host",
    );
  });
  it("hostile: on a GET too", async () => {
    await expectRefused(
      send("GET", "/api/events?panel=x", good({ Host: `evil.example:${port}` })),
      "host",
    );
  });
  it("order: wrong Host AND wrong Origin is refused for host", async () => {
    await expectRefused(
      send(
        "POST",
        "/api/panels",
        goodPost({ Host: `evil.example:${port}`, Origin: "http://evil.example" }),
        "{}",
      ),
      "host",
    );
  });
});

describe("Origin check (R3.3, G3)", () => {
  it("hostile: the app's own origin (same site, other origin) is refused", async () => {
    await expectRefused(send("POST", "/api/panels", goodPost({ Origin: APP_URL }), "{}"), "origin");
  });
  it("hostile: Origin null is refused", async () => {
    await expectRefused(send("POST", "/api/panels", goodPost({ Origin: "null" }), "{}"), "origin");
  });
  it("hostile: a POST with no Origin is refused", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ Origin: undefined }), "{}"),
      "origin",
    );
  });
  it("hostile: a GET whose Origin is present and foreign is refused", async () => {
    await expectRefused(send("GET", "/api/events?panel=x", good({ Origin: APP_URL })), "origin");
  });
  it("benign: a GET with no Origin passes the checks (the panel's EventSource)", async () => {
    const before = refusals().length;
    const created = await send("POST", "/api/panels", goodPost(), "{}");
    expect(created.status).toBe(200);
    const id = (JSON.parse(created.body) as { panel: string }).panel;
    const r = await send(
      "GET",
      `/api/events?panel=${encodeURIComponent(id)}`,
      good(),
      undefined,
      true,
    );
    expect(r.status).toBe(200);
    expect(String(r.headers["content-type"])).toMatch(/^text\/event-stream/);
    expect(refusals().length).toBe(before);
  });
});

describe("GET /api/config (A1)", () => {
  it("hostile: refused like every API route — foreign Host, foreign Origin, cross-site", async () => {
    await expectRefused(send("GET", "/api/config", good({ Host: `evil.example:${port}` })), "host");
    await expectRefused(send("GET", "/api/config", good({ Origin: APP_URL })), "origin");
    await expectRefused(
      send("GET", "/api/config", good({ "Sec-Fetch-Site": "cross-site" })),
      "fetch_site",
    );
  });

  it("answers { app_url, root } to the panel's own GET (no Origin)", async () => {
    const r = await send("GET", "/api/config", good());
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ app_url: APP_URL, root: ROOT });
  });
});

describe("Sec-Fetch-Site check (R3.3)", () => {
  it("hostile: same-site (the app on another port) is refused", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ "Sec-Fetch-Site": "same-site" }), "{}"),
      "fetch_site",
    );
  });
  it("hostile: cross-site is refused", async () => {
    await expectRefused(
      send("POST", "/api/panels", goodPost({ "Sec-Fetch-Site": "cross-site" }), "{}"),
      "fetch_site",
    );
  });
  it("hostile: a missing Sec-Fetch-Site is refused", async () => {
    await expectRefused(
      send("GET", "/api/events?panel=x", good({ "Sec-Fetch-Site": undefined })),
      "fetch_site",
    );
  });
  it("hostile: `none` (a typed URL or bookmark) is refused on the API", async () => {
    await expectRefused(
      send("GET", "/api/events?panel=x", good({ "Sec-Fetch-Site": "none" })),
      "fetch_site",
    );
  });
});

describe("POST body rules (R9.3, Q4)", () => {
  it("hostile: a text/plain POST (a CORS simple request) is refused with a 4xx", async () => {
    const r = await send(
      "POST",
      "/api/rpc",
      goodPost({ "Content-Type": "text/plain" }),
      JSON.stringify({ panel: "x", msg: { kind: "list_threads" } }),
    );
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  it("malformed JSON answers 400 with { error } and the server keeps serving", async () => {
    const r = await send("POST", "/api/rpc", goodPost(), "{not json");
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toHaveProperty("error");
    const again = await send("POST", "/api/panels", goodPost(), "{}");
    expect(again.status).toBe(200);
  });

  it("an rpc for an unknown panel answers 404 with { error }", async () => {
    const r = await send(
      "POST",
      "/api/rpc",
      goodPost(),
      JSON.stringify({ panel: "no-such-panel", msg: { kind: "list_threads" } }),
    );
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toHaveProperty("error");
  });

  it("panel ids are random and distinct (128-bit)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const r = await send("POST", "/api/panels", goodPost(), "{}");
      ids.add((JSON.parse(r.body) as { panel: string }).panel);
    }
    expect(ids.size).toBe(3);
    for (const id of ids) {
      expect(id.replace(/-/g, "").length).toBeGreaterThanOrEqual(32);
    }
  });
});

describe("security headers on every response (R3.4)", () => {
  const check = (r: Res, what: string) => {
    const csp = String(r.headers["content-security-policy"] ?? "");
    expect(csp, what).toContain("frame-ancestors 'none'");
    expect(String(r.headers["x-frame-options"]).toUpperCase(), what).toBe("DENY");
    expect(String(r.headers["x-content-type-options"]), what).toBe("nosniff");
  };
  it("on the page, an asset miss, an API success and an API refusal", async () => {
    check(await send("GET", "/", good({ "Sec-Fetch-Site": "none" })), "GET /");
    check(await send("GET", "/assets/does-not-exist.js", good()), "asset 404");
    check(await send("POST", "/api/panels", goodPost(), "{}"), "POST /api/panels");
    check(await send("POST", "/api/panels", goodPost({ Origin: APP_URL }), "{}"), "403");
  });
  it("the CSP lets the app, and only the app, be framed", async () => {
    const r = await send("GET", "/", good({ "Sec-Fetch-Site": "none" }));
    const csp = String(r.headers["content-security-policy"]);
    const frameSrc = csp.match(/frame-src ([^;]+)/)?.[1] ?? "";
    expect(frameSrc).toContain(APP_URL);
    expect(frameSrc).not.toContain("*");
  });
});

describe("logs (R9.1, R9.2)", () => {
  it("every refusal line parses as key=value and echoes no header value", () => {
    const lines = logs.events().filter((l) => l.includes("event=panel_refused"));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const kv = keyValues(l);
      expect(["host", "origin", "fetch_site"]).toContain(kv.reason);
      expect(l).not.toContain("evil.example");
    }
  });
});

describe("close (R3.7)", () => {
  it("after close() the port refuses connections and its Zeo sessions are closed", async () => {
    const p = await freePort();
    const local = await start(p);
    const before = fake.conns.length;
    const created = await sendTo(p, "POST", "/api/panels", goodPost({}, p), "{}");
    expect(created.status).toBe(200);
    const conn = await fake.waitForConn((c) => c.n >= before);
    await local.close();
    await conn.waitClosed(3000);
    await expect(sendTo(p, "GET", "/", good({ "Sec-Fetch-Site": "none" }, p))).rejects.toThrow();
  });
});
