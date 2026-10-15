// Story 052, task 2.2, tech-review fix round 1 — one pick reaches Zeo once, even when zeo()'s
// plugins are registered twice (R2.5). The realistic case: a site that already listed story
// 033's `zeo()` in `vite.plugins` and then adds `zeoAstro()`, which adds `zeo()` again.
//
// Hostile halves first:
//   - zeo() twice, and zeoAstro()'s plugins plus zeo(): ONE `zeo:select` from a real HMR client
//     must produce exactly ONE request to the fake Zeo socket and ONE `zeo:result` (wrongly:
//     each relay instance registers its own listener, so every pick is sent twice and the
//     second answer has no pending send to pair with);
//   - the duplicate is said once: exactly one `duplicate_plugin` warning, while a single
//     registration logs none (so the warning is not a line every server prints).
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Logger, type Plugin } from "vite";
import { zeo, zeoAstro, type ZeoAstroConfigSetup } from "../src/index.js";
import { okInserted, startFakeZeo, type FakeZeo } from "./helpers/fake-zeo.js";

const ROOT = fileURLToPath(new URL("./fixtures/app", import.meta.url));
const DUPLICATE = "zeo-devtools event=warning reason=duplicate_plugin";

type Json = Record<string, unknown>;
type LogLine = { level: string; msg: string };

const selection: Json = {
  v: 1,
  page_url: "http://127.0.0.1/",
  items: [
    {
      src: { file: "src/App.tsx", line: 20, column: 7, end_line: 22 },
      component: "App",
      dom: {
        tag: "button",
        id: "save",
        classes: [],
        text: "Save draft",
        attrs: { "aria-label": "Save draft" },
        styles: {},
        rect: { x: 1, y: 2, w: 3, h: 4 },
      },
    },
  ],
  screenshot: null,
};

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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) {
    await c();
  }
});

async function fake(): Promise<FakeZeo> {
  const f = await startFakeZeo();
  cleanups.push(() => f.dispose());
  return f;
}

/** The plugins `zeoAstro(options)` adds under `astro dev`, as Astro would receive them. */
function zeoAstroPlugins(options: Parameters<typeof zeoAstro>[0]): Plugin[] {
  const added: Plugin[] = [];
  const ctx: ZeoAstroConfigSetup = {
    command: "dev",
    updateConfig(config) {
      added.push(...config.vite.plugins);
      return undefined;
    },
    injectScript() {},
  };
  zeoAstro(options).hooks["astro:config:setup"](ctx);
  expect(added.length).toBeGreaterThan(0); // non-vacuous: the integration did add zeo()
  return added;
}

interface Run {
  logs: LogLine[];
  results: Json[];
}

/** A real dev server with `plugins`, one real HMR client, and ONE `zeo:select` from it. */
async function pickOnce(plugins: Plugin[]): Promise<Run> {
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

  const results: Json[] = [];
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/?token=${server.config.webSocketToken}`,
    "vite-hmr",
  );
  ws.addEventListener("message", (e) => {
    const message = JSON.parse(String(e.data)) as Json;
    if (message.type === "custom" && message.event === "zeo:result") {
      results.push(message.data as Json);
    }
  });
  await new Promise<void>((ok, fail) => {
    ws.addEventListener("open", () => ok(), { once: true });
    ws.addEventListener("error", () => fail(new Error("HMR socket did not open")), {
      once: true,
    });
  });
  cleanups.push(async () => ws.close());

  ws.send(JSON.stringify({ type: "custom", event: "zeo:select", data: selection }));
  const end = Date.now() + 5000;
  while (results.length === 0 && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // Time for a second relay's send and answer to land, were one still listening.
  await new Promise((r) => setTimeout(r, 500));
  return { logs, results };
}

const duplicateLines = (logs: LogLine[]) =>
  logs.map((l) => l.msg.replace(/\u001b\[[0-9;]*m/g, "")).filter((m) => m.includes(DUPLICATE));

describe("one pick, one request to Zeo (R2.5)", () => {
  it("hostile: zeo() registered twice sends the pick once, and says so once", async () => {
    const zeoFake = await fake();
    zeoFake.reply = { kind: "json", value: okInserted(1) };
    const run = await pickOnce([
      ...zeo({ socketPath: zeoFake.path }),
      ...zeo({ socketPath: zeoFake.path }),
    ]);
    expect(run.results).toEqual([okInserted(1)]);
    expect(zeoFake.requests).toHaveLength(1);
    const lines = duplicateLines(run.logs);
    expect(lines).toHaveLength(1);
    // Every field is one `key=value` token.
    expect(lines[0]!.replace(/^.*?zeo-devtools /, "")).toMatch(
      /^(?:\w+=(?:"(?:[^"\\]|\\.)*"|[^\s"=]+)(?: |$))+$/,
    );
  });

  it("hostile: zeoAstro()'s plugins next to an existing zeo() send the pick once", async () => {
    const zeoFake = await fake();
    const run = await pickOnce([
      ...zeo({ socketPath: zeoFake.path }),
      ...zeoAstroPlugins({ socketPath: zeoFake.path }),
    ]);
    expect(run.results).toEqual([okInserted(1)]);
    expect(zeoFake.requests).toHaveLength(1);
    expect(duplicateLines(run.logs)).toHaveLength(1);
  });

  it("a single registration relays the pick and logs no duplicate warning", async () => {
    const zeoFake = await fake();
    const run = await pickOnce(zeo({ socketPath: zeoFake.path }));
    expect(run.results).toEqual([okInserted(1)]);
    expect(zeoFake.requests).toHaveLength(1);
    expect(duplicateLines(run.logs)).toHaveLength(0);
  });
});
