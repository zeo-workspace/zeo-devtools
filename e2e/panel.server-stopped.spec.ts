// Story 055, task 17.1 (refine v3) — E2E: the panel page tells its own dev server stopping apart
// from Zeo being unreachable, in real Chromium and Firefox (both Playwright projects), against the
// v2 fake Zeo (test/helpers/fake-zeo-v2.ts) and the fixture app served by an in-process
// `vite dev` running `zeo()`. Requirements: R3.8, R3.9 (Q13). Found by 16.2's GUI proof: closing
// a Zeo-started project showed "Zeo is not running" while the dev server itself was gone.
//
// Contract (design.md §A3 "Own server gone (v3)"): when the page's event stream is lost it probes
// its own origin (`GET /api/config`); no answer → "The dev server stopped. Start devtools from Zeo
// to continue.", the chat and New thread disabled, the typed draft kept (R3.8); an answer → the
// existing "Zeo is not running, or its devtools bridge is off" (R3.9).
//
// Each test starts its own fake Zeo and dev server: the first one closes its server for good.
//
// Hostile halves first:
//   - the dev server closing under an open panel shows R3.8 and NOT the unreachable notice, with
//     the draft still in the textarea (disabled, not cleared) — on a bound page AND on an unbound
//     page, whose New thread is disabled;
//   - converse: Zeo going away while the dev server stays up shows the unreachable notice and NOT
//     R3.8 (a page that always blames its own server would pass the first test alone).
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { zeo } from "../src/index.js";
import {
  startFakeZeoV2,
  threadInfo,
  type FakeZeoV2,
  type Msg,
  type V2Conn,
} from "../test/helpers/fake-zeo-v2.js";

const ROOT = fileURLToPath(new URL("../test/fixtures/app", import.meta.url));
const STOPPED = "The dev server stopped. Start devtools from Zeo to continue.";
const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
const DRAFT = "a message the operator was still typing";

interface Stack {
  fake: FakeZeoV2;
  server: ViteDevServer;
  panelUrl: string;
  closed: boolean;
}

/** Zeo's side of a panel session, as far as binding a thread needs it. */
function respond(conn: V2Conn, msg: Msg) {
  const id = typeof msg.id === "string" ? msg.id : undefined;
  if ((conn.hello?.client as { kind?: string } | undefined)?.kind !== "panel") {
    return;
  }
  switch (msg.kind) {
    case "hello":
      conn.send({ v: 2, kind: "project_open" });
      break;
    case "list_threads":
      conn.send({
        v: 2,
        kind: "threads",
        id: id ?? "r",
        items: [threadInfo("t-1", "Devtools thread one", ROOT)],
      });
      break;
    case "create_thread":
      conn.send({ v: 2, kind: "created", id: id ?? "c", thread: threadInfo("t-new", "New", ROOT) });
      break;
    case "subscribe": {
      const target = (msg.target as { thread_id?: string } | undefined)?.thread_id ?? "t-new";
      conn.send({
        v: 2,
        kind: "snapshot",
        id,
        thread: threadInfo(String(target), String(target), ROOT),
        earlier: 0,
        entries: [],
        status: { state: "idle", message: null },
        permissions: [],
      });
      break;
    }
  }
}

async function startStack(): Promise<Stack> {
  const fake = await startFakeZeoV2();
  fake.onLine = respond;
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    plugins: [react(), zeo()],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  expect((server.httpServer!.address() as AddressInfo).port).toBeGreaterThan(0);
  const announce = await fake.waitForConn(
    (c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "dev_server",
    10_000,
  );
  const panelUrl = (announce.hello!.client as { panel_url: string }).panel_url;
  return { fake, server, panelUrl, closed: false };
}

async function stopStack(stack: Stack | undefined) {
  if (stack === undefined) {
    return;
  }
  if (!stack.closed) {
    await stack.server.close();
  }
  await stack.fake.dispose();
}

async function openPanel(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByRole("button", { name: /^new thread$/i })).toBeVisible();
}

/** A page bound to a new thread with `DRAFT` typed and not sent. */
async function boundPageWithDraft(page: Page, url: string) {
  await openPanel(page, url);
  await page.getByRole("button", { name: /^new thread$/i }).click();
  const box = page.getByRole("textbox");
  await expect(box).toBeVisible();
  await expect(box).toBeEditable();
  await box.fill(DRAFT);
  await expect(page.getByRole("button", { name: /^send$/i })).toBeEnabled();
}

test.describe.configure({ mode: "serial" });

test("hostile: the dev server closing under an open panel shows R3.8, disables the chat and New thread, and keeps the draft", async ({
  page,
  context,
}) => {
  let stack: Stack | undefined;
  try {
    stack = await startStack();
    await boundPageWithDraft(page, stack.panelUrl);
    const unbound = await context.newPage();
    await openPanel(unbound, stack.panelUrl);
    await expect(unbound.getByRole("button", { name: /^new thread$/i })).toBeEnabled();

    // Zeo stops a dev server it started (B5); closing it is what the operator's project close does.
    await stack.server.close();
    stack.closed = true;

    // The bound page: R3.8, not R3.9; the chat disabled; the draft still there.
    await expect(page.getByText(STOPPED)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(UNREACHABLE)).toHaveCount(0);
    const box = page.getByRole("textbox");
    await expect(box).toHaveValue(DRAFT);
    await expect(box).not.toBeEditable();
    await expect(page.getByRole("button", { name: /^send$/i })).toBeDisabled();

    // The unbound page: R3.8, and New thread disabled.
    await expect(unbound.getByText(STOPPED)).toBeVisible({ timeout: 10_000 });
    await expect(unbound.getByText(UNREACHABLE)).toHaveCount(0);
    await expect(unbound.getByRole("button", { name: /^new thread$/i })).toBeDisabled();
    await unbound.close();
  } finally {
    await stopStack(stack);
  }
});

test("converse: Zeo going away while the dev server stays up shows the unreachable notice, not R3.8", async ({
  page,
}) => {
  let stack: Stack | undefined;
  try {
    stack = await startStack();
    await boundPageWithDraft(page, stack.panelUrl);

    await stack.fake.stop();

    await expect(page.getByText(UNREACHABLE)).toBeVisible({ timeout: 10_000 });
    // Give a probe (if the stream was lost too) time to answer: the origin is up, so no R3.8.
    await page.waitForTimeout(2500);
    await expect(page.getByText(STOPPED)).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveValue(DRAFT);
  } finally {
    await stopStack(stack);
  }
});
