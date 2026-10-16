// Story 055, task 5.1 — `zeo()` starts the panel server and the announce session with the dev
// server, prints the panel URL, and stops both with it; nothing runs in `vite build`, Vitest's
// `test` mode or middleware mode (design.md §A6, GOTCHA G1, G2). Requirements: R2.1, R2.6, R3.1,
// R3.7 (Q3, Q5). Validation filter: `npm test -- index`.
//
// Drives a REAL Vite `createServer().listen()` and a REAL `build()` over `test/fixtures/app`, with
// `$ZEO_DEVTOOLS_SOCKET` pointing at the v2 fake Zeo. Vite's own logger is replaced by a capturing
// `customLogger`, so `printUrls()` output and warnings are read without touching stdout.
//
// Contract (tasks.md 5.1 Objective): options `panelPort` (1024-65535) and `panel` (default true);
// the announce hello is `client: { kind: "dev_server", root, app_url, panel_url }` with `app_url`
// EXACTLY Vite's resolved local URL — trailing slash and `base` path included (R2.1 amended) — and
// from `server.resolvedUrls.local[0]` and the panel on the SAME hostname (G1); `printUrls` adds
// `Zeo panel: <url>`; `server.close()` stops both.
//
// Hostile halves first:
//   - option bounds: 1023 and 65536 are refused while 1024 and 65535 pass; a non-integer port and a
//     non-boolean `panel` are refused;
//   - site identity (G1): the panel's hostname EQUALS the app's (127.0.0.1 here — `localhost`
//     would be another site) while its port DIFFERS;
//   - one announce per dev server: zeo() listed twice still opens exactly one dev_server session;
//   - R2.6: build, Vitest's test mode and middleware mode open NO session, while the same config in
//     dev mode does (so the "no session" checks are not vacuous).
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { build, createServer, type Logger, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";
import { startFakeZeoV2, type FakeZeoV2 } from "./helpers/fake-zeo-v2.js";

// Real servers and sockets: waits carry their own messages, so the test budget sits above them.
vi.setConfig({ testTimeout: 20_000 });

const ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));

function capturingLogger(): Logger & { infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  const warned = new Set<string>();
  return {
    infos,
    warns,
    hasWarned: false,
    info: (msg: string) => void infos.push(msg),
    warn: (msg: string) => void warns.push(msg),
    warnOnce: (msg: string) => {
      if (!warned.has(msg)) {
        warned.add(msg);
        warns.push(msg);
      }
    },
    error: (msg: string) => void warns.push(msg),
    clearScreen: () => {},
    hasErrorLogged: () => false,
  };
}

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

const devHellos = () =>
  fake.conns.filter(
    (c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "dev_server",
  );

let fake: FakeZeoV2;
const servers: ViteDevServer[] = [];

async function dev(
  plugins: ReturnType<typeof zeo>[],
  extra: { mode?: string; middlewareMode?: boolean; base?: string } = {},
) {
  const logger = capturingLogger();
  const server = await createServer({
    root: ROOT,
    configFile: false,
    customLogger: logger,
    logLevel: "info",
    mode: extra.mode,
    base: extra.base,
    plugins: plugins.flat(),
    server: extra.middlewareMode
      ? { middlewareMode: true, hmr: false }
      : { host: "127.0.0.1", port: 0, strictPort: false },
  });
  servers.push(server);
  if (!extra.middlewareMode) {
    await server.listen();
  }
  return { server, logger };
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/** Positive control: a plain dev server with zeo() DOES announce, so a "no session" is not vacuous. */
async function expectDevAnnounces() {
  await dev([zeo()]);
  await fake.waitForConn(
    (c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "dev_server",
    5000,
  );
}

beforeAll(async () => {
  fake = await startFakeZeoV2();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await settle(50);
  fake.conns.length = 0;
});

afterAll(async () => {
  await fake?.dispose();
  delete process.env.ZEO_DEVTOOLS_SOCKET;
});

describe("options (A6)", () => {
  // One test per bound, hostile half asserted first: a bound refused only because the option
  // name is unknown would pass the hostile half alone, so the benign half sits in the same test.
  it("panelPort: 1023 and 65536 are refused, 1024 and 65535 accepted; a fractional port refused", () => {
    expect(() => zeo({ panelPort: 1023 } as never)).toThrow();
    expect(() => zeo({ panelPort: 65536 } as never)).toThrow();
    expect(() => zeo({ panelPort: 5000.5 } as never)).toThrow();
    expect(() => zeo({ panelPort: 1024 } as never)).not.toThrow();
    expect(() => zeo({ panelPort: 65535 } as never)).not.toThrow();
  });
  it("panel: a non-boolean is refused, true and false accepted", () => {
    expect(() => zeo({ panel: "no" } as never)).toThrow();
    expect(() => zeo({ panel: false } as never)).not.toThrow();
    expect(() => zeo({ panel: true } as never)).not.toThrow();
  });
});

describe("vite dev: announce and panel (R2.1, R3.1, G1, G2)", () => {
  it("announces root, app URL and panel URL once the server listens", async () => {
    const { server } = await dev([zeo()]);
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    const client = conn.hello!.client as Record<string, string>;
    expect(client.kind).toBe("dev_server");
    expect(client.root).toBe(server.config.root);
    expect(client.app_url, "the full resolved URL, trailing slash included").toBe(
      server.resolvedUrls!.local[0],
    );
    const app = new URL(client.app_url!);
    const panel = new URL(client.panel_url!);
    expect(panel.hostname, "G1: same hostname as the app").toBe(app.hostname);
    expect(panel.port, "another origin: another port").not.toBe(app.port);
  });

  it("hostile: a Vite base path is kept in app_url, never cut to the origin", async () => {
    const { server } = await dev([zeo()], { base: "/app/" });
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    const appUrl = (conn.hello!.client as Record<string, string>).app_url!;
    expect(server.resolvedUrls!.local[0]).toMatch(/\/app\/$/);
    expect(appUrl).toBe(server.resolvedUrls!.local[0]);
  });

  it("the panel URL answers HTTP on that host and port", async () => {
    await dev([zeo()]);
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    const panel = new URL((conn.hello!.client as Record<string, string>).panel_url!);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { hostname: panel.hostname, port: Number(panel.port), path: "/", method: "GET" },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBeGreaterThan(0);
  });

  it("panelPort is honoured", async () => {
    const p = await freePort();
    await dev([zeo({ panelPort: p } as never)]);
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    expect(Number(new URL((conn.hello!.client as Record<string, string>).panel_url!).port)).toBe(p);
  });

  it("printUrls adds `Zeo panel: <url>` beside Vite's own URLs", async () => {
    const { server, logger } = await dev([zeo()]);
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    const panelUrl = (conn.hello!.client as Record<string, string>).panel_url!;
    server.printUrls();
    const out = logger.infos.join("\n");
    expect(out).toMatch(/Local:/);
    expect(out).toMatch(/Zeo panel:/);
    expect(out).toContain(new URL(panelUrl).origin);
  });

  it("hostile: zeo() listed twice still announces exactly once", async () => {
    await dev([zeo(), zeo()]);
    await fake.waitForConn((c) => c.hello !== undefined);
    await settle();
    expect(devHellos()).toHaveLength(1);
  });

  it("panel: false starts neither the panel nor the announce", async () => {
    const { server, logger } = await dev([zeo({ panel: false } as never)]);
    await settle();
    expect(devHellos()).toHaveLength(0);
    server.printUrls();
    expect(logger.infos.join("\n")).not.toMatch(/Zeo panel:/);
    await expectDevAnnounces();
  });
});

describe("nothing outside vite dev (R2.6, G2)", () => {
  it("vite build opens no session", async () => {
    const out = await mkdtemp(join(tmpdir(), "zeo-build-"));
    try {
      await build({
        root: ROOT,
        configFile: false,
        logLevel: "silent",
        plugins: [zeo()],
        build: { outDir: out, write: true, emptyOutDir: true },
      });
      await settle();
      expect(fake.conns).toHaveLength(0);
      await expectDevAnnounces();
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });

  it("Vitest's test mode opens no session", async () => {
    await dev([zeo()], { mode: "test" });
    await settle();
    expect(fake.conns).toHaveLength(0);
    await expectDevAnnounces();
  });

  it("middleware mode opens no session and logs reason=middleware_mode", async () => {
    const { logger } = await dev([zeo()], { middlewareMode: true });
    await settle();
    expect(fake.conns).toHaveLength(0);
    expect([...logger.warns, ...logger.infos].join("\n")).toMatch(
      /zeo-devtools event=\S+.*reason=middleware_mode/,
    );
    await expectDevAnnounces();
  });
});

describe("stops with the dev server (R3.7)", () => {
  it("server.close() ends the announce session and the panel port", async () => {
    const { server } = await dev([zeo()]);
    const conn = await fake.waitForConn((c) => c.hello !== undefined);
    const panel = new URL((conn.hello!.client as Record<string, string>).panel_url!);
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    await conn.waitClosed(3000);
    await expect(
      new Promise((resolve, reject) => {
        const req = httpRequest(
          { hostname: panel.hostname, port: Number(panel.port), path: "/" },
          resolve,
        );
        req.on("error", reject);
        req.end();
      }),
    ).rejects.toThrow();
  });
});
