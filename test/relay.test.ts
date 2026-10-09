// Story 033, task 5.2 — the relay plugin, against a REAL `createServer` listening on a
// loopback port, a REAL HMR WebSocket client carrying the server's token, and a fake Zeo
// `net.Server` on a temp unix socket (design.md §A2 interface, §A3, §Error Handling).
// Requirements: R6.1, R6.2, R6.3, R6.5, R6.6, R6.7, R9.12 (relayed text), R12.1, R12.3.
// Contract: the second plugin of `zeo({ socketPath })` serves `/@zeo-devtools/client`,
// injects it into index.html, and answers `zeo:select` with `zeo:result` to the sender.
//
// Hostile halves first:
//   - one-tab-only reply: the sender gets its answer AND a second connected client gets
//     nothing; then the reverse, so "reply to the last client" also fails;
//   - path confinement: `../app2/x.tsx` resolves to a sibling that shares the root as a
//     STRING prefix and must be refused locally; `src/../src/App.tsx` stays inside and MUST
//     be forwarded, normalized;
//   - Vite version: 6.0.8 and 5.4.12 must leave the relay off, while 6.0.10 — smaller than
//     "6.0.9" as a string — MUST register it (wrongly refused by string comparison).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { zeo } from "../src/index.js";
import { createServer, type Logger, type Plugin, type ViteDevServer } from "vite";
import { okInserted, startFakeZeo, type FakeZeo } from "./helpers/fake-zeo.js";

const ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";

type Json = Record<string, unknown>;
type LogLine = { level: string; msg: string };

function pageItem(
  file: string,
  text = "Save draft",
  attrs: Json = { "aria-label": "Save draft" },
): Json {
  return {
    src: { file, line: 20, column: 7, end_line: 22 },
    component: "App",
    dom: {
      tag: "button",
      id: "save",
      classes: [],
      text,
      attrs,
      styles: {},
      rect: { x: 1, y: 2, w: 3, h: 4 },
    },
  };
}

function pageSelection(
  items: Json[] = [pageItem("src/App.tsx")],
  screenshot: Json | null = null,
): Json {
  return { v: 1, page_url: "http://127.0.0.1/", items, screenshot };
}

// ---- harness ---------------------------------------------------------------------------

function capturingLogger(lines: LogLine[]): Logger {
  const push = (level: string) => (msg: string) => {
    lines.push({ level, msg: String(msg) });
  };
  return {
    info: push("info"),
    warn: push("warn"),
    warnOnce: push("warn"),
    error: push("error"),
    clearScreen: () => {},
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

interface Stack {
  server: ViteDevServer;
  port: number;
  logs: LogLine[];
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function stack(plugins: Plugin[]): Promise<Stack> {
  const logs: LogLine[] = [];
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "info",
    customLogger: capturingLogger(logs),
    plugins,
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  cleanups.push(() => server.close());
  const port = (server.httpServer!.address() as AddressInfo).port;
  return { server, port, logs };
}

async function fake(path?: string): Promise<FakeZeo> {
  const f = await startFakeZeo(path);
  cleanups.push(() => f.dispose());
  return f;
}

class Hmr {
  private queue: Json[] = [];
  private waiters: Array<() => void> = [];
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (e) => {
      this.queue.push(JSON.parse(String(e.data)) as Json);
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static async open(s: Stack): Promise<Hmr> {
    const token = s.server.config.webSocketToken;
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/?token=${token}`, "vite-hmr");
    const client = new Hmr(ws);
    await new Promise<void>((ok, fail) => {
      ws.addEventListener("open", () => ok(), { once: true });
      ws.addEventListener("error", () => fail(new Error("HMR socket did not open")), {
        once: true,
      });
    });
    cleanups.push(async () => ws.close());
    return client;
  }

  send(event: string, data: unknown) {
    this.ws.send(JSON.stringify({ type: "custom", event, data }));
  }

  /** Resolves the next `zeo:result` payload, or undefined after `ms`. */
  async result(ms = 5000): Promise<Json | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex((m) => m.type === "custom" && m.event === "zeo:result");
      if (i >= 0) {
        return this.queue.splice(i, 1)[0]!.data as Json;
      }
      const left = end - Date.now();
      if (left <= 0) {
        return undefined;
      }
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, left);
      });
    }
  }
}

async function select(client: Hmr, data: unknown, ms?: number) {
  client.send("zeo:select", data);
  return client.result(ms);
}

const selectLines = (logs: LogLine[]) =>
  logs
    .map((l) => l.msg.replace(/\u001b\[[0-9;]*m/g, ""))
    .filter((m) => m.includes("zeo-devtools") && m.includes("event=select"));

// ---- tests -----------------------------------------------------------------------------

describe("client injection (design §A2 interface)", () => {
  it("index.html loads /@zeo-devtools/client as a module, and the module is served", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const html = await (await fetch(`http://127.0.0.1:${s.port}/`)).text();
    expect(html).toMatch(/<script[^>]*type="module"[^>]*\/@zeo-devtools\/client/);
    const mod = await fetch(`http://127.0.0.1:${s.port}/@zeo-devtools/client`);
    expect(mod.status).toBe(200);
    expect(mod.headers.get("content-type") ?? "").toMatch(/javascript/);
  });
});

describe("forwarding (R6.1)", () => {
  it("forwards one request with project_root and absolute item paths, and relays the answer", async () => {
    const zeoFake = await fake();
    zeoFake.reply = { kind: "json", value: okInserted(1) };
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);

    const result = await select(page, pageSelection());

    expect(result).toEqual(okInserted(1));
    expect(zeoFake.requests).toHaveLength(1);
    const sent = zeoFake.requests[0] as Json & { items: Array<Json & { src: Json; dom: Json }> };
    expect(sent.v).toBe(1);
    expect(resolve(String(sent.project_root))).toBe(resolve(ROOT));
    expect(sent.items[0]!.src).toEqual({
      file: join(ROOT, "src/App.tsx"),
      line: 20,
      column: 7,
      end_line: 22,
    });
    expect(sent.items[0]!.dom).toEqual((pageItem("src/App.tsx") as { dom: Json }).dom);
  });

  it("hostile converse: a path that stays inside the root after `..` is forwarded, normalized", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    await select(page, pageSelection([pageItem("src/../src/App.tsx")]));
    const sent = zeoFake.requests[0] as { items: Array<{ src: { file: string } }> };
    expect(sent.items[0]!.src.file).toBe(join(ROOT, "src/App.tsx"));
  });

  it("hostile: paths escaping the root are refused locally, including a string-prefix sibling", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    for (const file of ["../app2/secret.tsx", "../../../../etc/passwd", "/etc/passwd"]) {
      const result = await select(page, pageSelection([pageItem(file)]));
      expect(result, file).toMatchObject({ v: 1, ok: false });
    }
    expect(zeoFake.requests).toHaveLength(0);
  });

  it("reaches $ZEO_DEVTOOLS_SOCKET when no socketPath option is given", async () => {
    const zeoFake = await fake();
    vi.stubEnv("ZEO_DEVTOOLS_SOCKET", zeoFake.path);
    cleanups.push(async () => vi.unstubAllEnvs());
    const s = await stack(zeo());
    const page = await Hmr.open(s);
    expect(await select(page, pageSelection())).toEqual(okInserted(1));
    expect(zeoFake.requests).toHaveLength(1);
  });

  it("falls back to $XDG_RUNTIME_DIR/zeo/devtools.sock", async () => {
    const runtime = await mkdtemp(join(tmpdir(), "zr-"));
    cleanups.push(() => rm(runtime, { recursive: true, force: true }));
    await mkdir(join(runtime, "zeo"), { mode: 0o700 });
    const zeoFake = await fake(join(runtime, "zeo", "devtools.sock"));
    vi.stubEnv("ZEO_DEVTOOLS_SOCKET", undefined);
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    cleanups.push(async () => vi.unstubAllEnvs());
    const s = await stack(zeo());
    const page = await Hmr.open(s);
    expect(await select(page, pageSelection())).toEqual(okInserted(1));
    expect(zeoFake.requests).toHaveLength(1);
  });

  it("a relative $XDG_RUNTIME_DIR is refused with a message naming it", async () => {
    vi.stubEnv("ZEO_DEVTOOLS_SOCKET", undefined);
    vi.stubEnv("XDG_RUNTIME_DIR", "relative/runtime");
    cleanups.push(async () => vi.unstubAllEnvs());
    const s = await stack(zeo());
    const page = await Hmr.open(s);
    const result = await select(page, pageSelection());
    expect(result).toMatchObject({ ok: false });
    expect(String(result?.message)).toMatch(/XDG_RUNTIME_DIR/);
  });
});

describe("the answer goes to the sender only (R6.2)", () => {
  it("hostile: the sender gets it and another connected tab does not — both ways", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const a = await Hmr.open(s);
    const b = await Hmr.open(s);

    zeoFake.reply = { kind: "json", value: okInserted(1) };
    expect(await select(a, pageSelection())).toEqual(okInserted(1));
    expect(await b.result(400)).toBeUndefined();

    zeoFake.reply = { kind: "json", value: okInserted(2) };
    expect(
      await select(b, pageSelection([pageItem("src/App.tsx"), pageItem("src/main.tsx")])),
    ).toEqual(okInserted(2));
    expect(await a.result(400)).toBeUndefined();
  });
});

describe("Zeo's answers and failures reach the page (R6.3, R9.12)", () => {
  it("relays every Zeo error code with its message", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    for (const error of [
      "no_window",
      "no_agent_panel",
      "ai_disabled",
      "bad_request",
      "too_large",
      "outside_project",
      "unsupported_version",
    ]) {
      const message =
        error === "no_window" ? "No Zeo window has this project open" : `Zeo refused: ${error}`;
      zeoFake.reply = { kind: "json", value: { v: 1, ok: false, error, message } };
      const result = await select(page, pageSelection());
      expect(result, error).toMatchObject({ v: 1, ok: false, error });
      expect(String(result?.message).length, error).toBeGreaterThan(0);
      if (error === "no_window") {
        expect(result?.message).toBe("No Zeo window has this project open");
      }
    }
  });

  it("no socket gives `unreachable` with the user-facing text", async () => {
    const zeoFake = await fake();
    const path = zeoFake.path;
    await zeoFake.stop();
    const s = await stack(zeo({ socketPath: path }));
    const page = await Hmr.open(s);
    expect(await select(page, pageSelection())).toMatchObject({
      v: 1,
      ok: false,
      error: "unreachable",
      message: UNREACHABLE,
    });
  });
});

describe("validation in the dev server (R6.5)", () => {
  it("an invalid request is answered with the reason and nothing reaches Zeo", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    for (const bad of [
      pageSelection([]),
      { ...pageSelection(), v: 2 },
      pageSelection([pageItem("src/App.tsx", "x".repeat(501))]),
      pageSelection([pageItem("src/App.tsx", "ok", { value: "secret" })]),
    ]) {
      const result = await select(page, bad);
      expect(result).toMatchObject({ v: 1, ok: false });
      expect(["bad_request", "unsupported_version"]).toContain(result?.error);
      expect(String(result?.message).length).toBeGreaterThan(0);
    }
    expect(zeoFake.requests).toHaveLength(0);
  });
});

describe("the relay never throws into Vite (R6.6, Q4)", () => {
  it("answers garbage with an error and keeps serving", async () => {
    const zeoFake = await fake();
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    for (const garbage of [null, "garbage", 42, [], { v: 1, items: "x" }]) {
      expect(await select(page, garbage), JSON.stringify(garbage)).toMatchObject({ ok: false });
    }
    zeoFake.reply = { kind: "raw", text: "this is not json\n" };
    expect(await select(page, pageSelection())).toMatchObject({ ok: false });

    expect((await fetch(`http://127.0.0.1:${s.port}/`)).status).toBe(200);
    zeoFake.reply = { kind: "json", value: okInserted(1) };
    expect(await select(page, pageSelection())).toEqual(okInserted(1));
  });
});

describe("logging (R12.1, R12.3)", () => {
  it("one key=value line per request with count, screenshot size, outcome and duration", async () => {
    const zeoFake = await fake();
    zeoFake.reply = { kind: "json", value: okInserted(2) };
    const s = await stack(zeo({ socketPath: zeoFake.path }));
    const page = await Hmr.open(s);
    const items = [
      pageItem("src/App.tsx", "SECRET-DOM-TEXT", { "aria-label": "SECRET-ATTR" }),
      pageItem("src/main.tsx"),
    ];
    await select(page, pageSelection(items, { mime: "image/png", data_b64: PNG_1x1, w: 1, h: 1 }));
    await select(page, pageSelection([pageItem("src/App.tsx")]));

    const lines = selectLines(s.logs);
    expect(lines).toHaveLength(2);
    const fields = (line: string) =>
      Object.fromEntries(
        line
          .slice(line.indexOf("zeo-devtools") + "zeo-devtools".length)
          .trim()
          .split(/\s+/)
          .map((kv) => {
            expect(kv, line).toMatch(/^[a-z_]+=\S*$/);
            const at = kv.indexOf("=");
            return [kv.slice(0, at), kv.slice(at + 1)];
          }),
      );
    const first = fields(lines[0]!);
    expect(first).toMatchObject({ event: "select", items: "2", outcome: "inserted" });
    expect(Number(first.screenshot_bytes)).toBeGreaterThan(0);
    expect(first.ms).toMatch(/^\d+$/);
    expect(fields(lines[1]!)).toMatchObject({ items: "1", screenshot_bytes: "0" });

    const all = s.logs.map((l) => l.msg).join("\n");
    expect(all).not.toContain("SECRET-DOM-TEXT");
    expect(all).not.toContain("SECRET-ATTR");
    expect(all).not.toContain(PNG_1x1.slice(0, 24));
    expect(all).not.toContain(ROOT);
  });
});

describe("Vite older than 6.0.9 (R6.7)", () => {
  async function relayWithViteVersion(version: string) {
    vi.resetModules();
    vi.doMock("vite", async (importOriginal) => ({ ...(await importOriginal<object>()), version }));
    cleanups.push(async () => {
      vi.doUnmock("vite");
      vi.resetModules();
    });
    const { zeo: zeoUnderVersion } = await import("../src/index.js");
    const zeoFake = await fake();
    const s = await stack(zeoUnderVersion({ socketPath: zeoFake.path }));
    return { s, zeoFake, page: await Hmr.open(s) };
  }

  for (const old of ["6.0.8", "5.4.12"]) {
    it(`hostile: ${old} leaves the relay off and logs found and required versions`, async () => {
      const { s, zeoFake, page } = await relayWithViteVersion(old);
      expect(await select(page, pageSelection(), 700)).toBeUndefined();
      expect(zeoFake.requests).toHaveLength(0);
      const named = s.logs.filter((l) => l.msg.includes(old) && l.msg.includes("6.0.9"));
      expect(named).toHaveLength(1);
    });
  }

  for (const current of ["6.0.9", "6.0.10", "8.3.0"]) {
    it(`hostile converse: ${current} registers the relay`, async () => {
      const { zeoFake, page } = await relayWithViteVersion(current);
      expect(await select(page, pageSelection())).toEqual(okInserted(1));
      expect(zeoFake.requests).toHaveLength(1);
    });
  }
});
