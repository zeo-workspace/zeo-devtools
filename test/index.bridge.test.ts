// Story 055, task 6.3 — the plugin injects the app bridge (src/client/bridge.ts) into the app's
// client module, told the panel's origin, only when the panel runs (design.md §A4). Supplementary
// to the frozen bridge.test.ts, which drives the bridge itself.
//
// Drives a REAL Vite dev server over test/fixtures/app with `$ZEO_DEVTOOLS_SOCKET` pointing at
// the v2 fake Zeo, and reads the client module as Vite serves it.
//   - with the panel: the module starts the bridge, and its `panelOrigin` is exactly the origin
//     of the panel URL the plugin announced — so the bridge never posts to `*`;
//   - with `panel: false`: no bridge at all, while the picker is still mounted.
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Logger, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";
import { startFakeZeoV2, type FakeZeoV2 } from "./helpers/fake-zeo-v2.js";

vi.setConfig({ testTimeout: 20_000 });

const ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));
const CLIENT = "/@zeo-devtools/client";

const quietLogger = (): Logger => ({
  hasWarned: false,
  info: () => {},
  warn: () => {},
  warnOnce: () => {},
  error: () => {},
  clearScreen: () => {},
  hasErrorLogged: () => false,
});

let fake: FakeZeoV2;
const servers: ViteDevServer[] = [];

async function dev(options?: Parameters<typeof zeo>[0]) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    customLogger: quietLogger(),
    plugins: zeo(options),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  servers.push(server);
  await server.listen();
  return server;
}

/** The `startBridge(...)` argument in the served client module, or `undefined`. */
const bridgeArg = (code: string): { panelOrigin?: string } | undefined => {
  const m = code.match(/startBridge\((\{[^)]*\})\)/);
  return m ? (JSON.parse(m[1]!) as { panelOrigin?: string }) : undefined;
};

beforeAll(async () => {
  fake = await startFakeZeoV2();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  fake.conns.length = 0;
});

afterAll(async () => {
  await fake?.dispose();
  delete process.env.ZEO_DEVTOOLS_SOCKET;
});

describe("app bridge injection (A4)", () => {
  it("starts the bridge with the announced panel's origin", async () => {
    const server = await dev();
    const conn = await fake.waitForConn((c) => c.hello !== undefined, 5000);
    const panelUrl = (conn.hello!.client as Record<string, string>).panel_url!;
    const result = await server.transformRequest(CLIENT);
    const code = result?.code ?? "";
    expect(code).toMatch(/\bmount\(/);
    expect(bridgeArg(code)).toEqual({ panelOrigin: new URL(panelUrl).origin });
  });

  it("panel: false injects no bridge, and the picker is still mounted", async () => {
    const server = await dev({ panel: false });
    const result = await server.transformRequest(CLIENT);
    const code = result?.code ?? "";
    expect(code).toMatch(/\bmount\(/);
    expect(code).not.toContain("startBridge");
  });
});
