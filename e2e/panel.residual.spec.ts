// Story 055, task 7.1 — a DOCUMENTED RESIDUAL, not a feature: deviation 6.3, accepted by the
// operator on 2026-10-16. Supplementary to the frozen e2e/panel.spec.ts.
//
// The app runs in an iframe with `allow-popups`. A script in it can, on a user's click, call
// `window.open(panelUrl, "_blank", "noopener")`. Such a popup has no opener, so the panel page
// cannot tell it from a panel the operator opened (and `Sec-Fetch-Site` cannot either: every
// local port is same-site). It mounts a real panel, with its own Zeo session, and takes one of the
// 4 live-panel slots until it is closed.
//
// What still holds, and what these tests pin, in Chromium and Firefox:
//   - `open()` returns null: the app keeps no handle on the popup, so it cannot steer it;
//   - the popup is an ordinary panel, with no opener, like one opened from Zeo;
//   - its slot counts toward the cap of 4 (a 5th page is told to close one) and is freed when the
//     popup closes;
//   - hostile: the same popup opened WITH an opener is refused, opens no Zeo session and shows no
//     app.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test, type BrowserContext, type Frame, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";
import {
  startFakeZeoV2,
  type FakeZeoV2,
  type Msg,
  type V2Conn,
} from "../test/helpers/fake-zeo-v2.js";

const ROOT = fileURLToPath(new URL("../test/fixtures/app", import.meta.url));
const OPENED_BY_PAGE = /opened by another page/i;
const TOO_MANY = /too many devtools panels are open/i;
const MAX_LIVE_PANELS = 4;

let fake: FakeZeoV2;
let server: ViteDevServer;
let appUrl: string;
let panelUrl: string;

const isPanel = (c: V2Conn) => (c.hello?.client as { kind?: string } | undefined)?.kind === "panel";
const panelSessions = () => fake.conns.filter(isPanel);
const livePanelSessions = () => panelSessions().filter((c) => !c.closed).length;

function respond(conn: V2Conn, msg: Msg) {
  if (!isPanel(conn)) {
    return;
  }
  const id = typeof msg.id === "string" ? msg.id : "r";
  if (msg.kind === "hello") {
    conn.send({ v: 2, kind: "project_open" });
  } else if (msg.kind === "list_threads") {
    conn.send({ v: 2, kind: "threads", id, items: [] });
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
  appUrl = `http://127.0.0.1:${(server.httpServer!.address() as AddressInfo).port}`;
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

async function openPanel(page: Page) {
  await page.goto(panelUrl);
  await expect(page.getByRole("button", { name: /^new thread$/i })).toBeVisible();
}

async function appFrame(page: Page): Promise<Frame> {
  await expect
    .poll(() => page.frames().some((f) => f.url().startsWith(appUrl)), { timeout: 10_000 })
    .toBe(true);
  const frame = page.frames().find((f) => f.url().startsWith(appUrl))!;
  await expect(frame.locator("#ready")).toHaveText("Fixture app ready");
  return frame;
}

/**
 * A script in the app adds a button that opens the panel URL with `features`, and the user clicks
 * it (a popup needs the click's activation). Resolves with the popup and what `open()` returned.
 */
async function popupFromApp(context: BrowserContext, page: Page, features: string) {
  const frame = await appFrame(page);
  await frame.evaluate(
    ([url, feat]) => {
      const b = document.createElement("button");
      b.id = "zeo-e2e-popup";
      b.textContent = "Open the panel";
      b.addEventListener("click", () => {
        const handle = window.open(url, "_blank", feat);
        (window as unknown as { __opened: string }).__opened = handle === null ? "null" : "window";
      });
      document.body.prepend(b);
    },
    [panelUrl, features] as const,
  );
  const next = context.waitForEvent("page");
  await frame.locator("#zeo-e2e-popup").click();
  const popup = await next;
  await popup.waitForLoadState();
  const opened = await frame.evaluate(() => (window as unknown as { __opened?: string }).__opened);
  return { popup, opened };
}

test("documented residual (deviation 6.3): an app's noopener popup is an ordinary panel the app cannot reach, and its slot is freed on close", async ({
  context,
  page,
}) => {
  await openPanel(page);
  expect(livePanelSessions()).toBe(1);

  const { popup, opened } = await popupFromApp(context, page, "noopener");
  expect(opened, "the app keeps no handle on the popup").toBe("null");
  await expect(popup.getByRole("button", { name: /^new thread$/i })).toBeVisible();
  expect(await popup.evaluate(() => window.opener === null), "no opener").toBe(true);
  await expect(popup.getByText(OPENED_BY_PAGE)).toHaveCount(0);
  await expect.poll(livePanelSessions).toBe(2);
  const popupSession = panelSessions().at(-1)!;

  // The popup holds a slot: with two more panels the cap is full, and a fifth page is refused.
  const others: Page[] = [];
  for (let i = 2; i < MAX_LIVE_PANELS; i++) {
    const p = await context.newPage();
    await openPanel(p);
    others.push(p);
  }
  await expect.poll(livePanelSessions).toBe(MAX_LIVE_PANELS);
  const fifth = await context.newPage();
  await fifth.goto(panelUrl);
  await expect(fifth.getByText(TOO_MANY)).toBeVisible();
  // Closed before the popup, so its retry cannot take the slot the popup frees.
  await fifth.close();

  // Closing the popup ends its Zeo session and frees its slot: a new page mounts.
  await popup.close();
  await popupSession.waitClosed(10_000);
  const next = await context.newPage();
  await openPanel(next);
  await expect(next.getByText(TOO_MANY)).toHaveCount(0);
  await expect.poll(livePanelSessions).toBe(MAX_LIVE_PANELS);

  for (const p of [...others, next]) {
    await p.close();
  }
  await expect.poll(livePanelSessions).toBe(1);
});

test("hostile: an app popup of the panel WITH an opener is refused and opens no Zeo session", async ({
  context,
  page,
}) => {
  await openPanel(page);
  await expect.poll(livePanelSessions).toBe(1);
  const before = panelSessions().length;

  const { popup, opened } = await popupFromApp(context, page, "");
  expect(opened, "non-vacuous: this popup does have an opener").toBe("window");
  await expect(popup.getByText(OPENED_BY_PAGE)).toBeVisible();
  await expect(popup.locator("iframe")).toHaveCount(0);
  await expect(popup.getByRole("button", { name: /^new thread$/i })).toHaveCount(0);
  await popup.waitForTimeout(500);
  expect(panelSessions().length, "no panel session for the refused popup").toBe(before);
  await popup.close();
});
