// Story 055, task 7.1 (Q17) — accessibility of the panel page in Chromium and Firefox: an axe
// run reports no serious or critical violation, in the unbound, bound and project-closed states,
// and every control is reachable by keyboard. Kept apart from panel.spec.ts because it needs
// `@axe-core/playwright` (a devDependency this story adds; Q12 covers its reason).
//
// Hostile half: keyboard reachability is checked by walking Tab from the top of the page and
// collecting what receives focus — a control that is only clickable (a `div` with a click
// handler, or `tabindex="-1"`) is missed by that walk and fails the test, while an axe pass alone
// would not catch it.
import AxeBuilder from "@axe-core/playwright";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";
import {
  startFakeZeoV2,
  threadInfo,
  type FakeZeoV2,
  type V2Conn,
  type Msg,
} from "../test/helpers/fake-zeo-v2.js";

const ROOT = fileURLToPath(new URL("../test/fixtures/app", import.meta.url));

let fake: FakeZeoV2;
let server: ViteDevServer;
let panelUrl: string;

function respond(conn: V2Conn, msg: Msg) {
  if ((conn.hello?.client as { kind?: string } | undefined)?.kind !== "panel") {
    return;
  }
  const id = typeof msg.id === "string" ? msg.id : "r";
  if (msg.kind === "hello") {
    conn.send({ v: 2, kind: "project_open" }); // R7.6
  } else if (msg.kind === "list_threads") {
    conn.send({
      v: 2,
      kind: "threads",
      id,
      items: [threadInfo("t-1", "Devtools thread one", ROOT)],
    });
  } else if (msg.kind === "create_thread") {
    conn.send({ v: 2, kind: "created", id, thread: threadInfo("t-new", "New thread", ROOT) });
  } else if (msg.kind === "subscribe") {
    conn.send({
      v: 2,
      kind: "snapshot",
      id,
      thread: threadInfo("t-new", "New thread", ROOT),
      earlier: 0,
      entries: [{ role: "assistant", markdown: "Hello from the agent", truncated: false }],
      status: { state: "idle", message: null },
      permissions: [],
    });
  }
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake = await startFakeZeoV2();
  fake.onLine = respond;
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
  server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    plugins: [react(), zeo()],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const announce = await fake.waitForConn(
    (c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "dev_server",
    10_000,
  );
  panelUrl = (announce.hello!.client as { panel_url: string }).panel_url;
});

test.afterAll(async () => {
  await server?.close();
  await fake?.dispose();
});

async function seriousViolations(page: Page) {
  // The app inside the iframe is the operator's code, not the panel: axe checks the panel only.
  const result = await new AxeBuilder({ page }).exclude("iframe").analyze();
  type Violation = { id: string; impact?: string | null; nodes: Array<{ target: unknown[] }> };
  return (result.violations as Violation[])
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

test("no serious or critical axe violation: unbound, bound and project-closed", async ({
  page,
}) => {
  await page.goto(panelUrl);
  await expect(page.getByRole("button", { name: /^new thread$/i })).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  await page.getByRole("button", { name: /^new thread$/i }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);

  const panel = fake.conns
    .filter((c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "panel")
    .at(-1)!;
  panel.send({ v: 2, kind: "project_closed" });
  await expect(page.getByText("Open this project in Zeo to continue")).toBeVisible();
  expect(await seriousViolations(page)).toEqual([]);
});

test("hostile: every control is reachable with Tab", async ({ page, browserName }) => {
  await page.goto(panelUrl);
  await expect(page.getByRole("button", { name: /^new thread$/i })).toBeVisible();
  await page.getByRole("button", { name: /^new thread$/i }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
  // The controls an operator needs: New thread, the listed thread, the composer, Send.
  const wanted = await page.evaluate(() =>
    [
      ...document.querySelectorAll(
        "button, textarea, input, select, a[href], [role=button], [role=option]",
      ),
    ]
      .filter(
        (el) => (el as HTMLElement).offsetParent !== null && !(el as HTMLButtonElement).disabled,
      )
      .filter((el) => !el.closest("iframe"))
      .map((el) => (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim()),
  );
  expect(wanted.length).toBeGreaterThan(0);
  const reached = new Set<string>();
  await page.locator("body").focus();
  const key = browserName === "webkit" ? "Alt+Tab" : "Tab";
  for (let i = 0; i < 60; i++) {
    await page.keyboard.press(key);
    const name = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el.tagName === "IFRAME") {
        return null;
      }
      return (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim();
    });
    if (name !== null) {
      reached.add(name);
    }
  }
  for (const w of wanted) {
    expect([...reached], `reachable by keyboard: ${w}`).toContain(w);
  }
});
