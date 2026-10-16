// Story 033, task 9.2 — E2E: a real click in a real browser reaches a fake Zeo socket.
// `vite dev` runs in-process on `test/fixtures/app` with `ZEO_DEVTOOLS_SOCKET` pointing at
// a fake Zeo `net.Server` (test/helpers/fake-zeo.ts) that records every request line.
// Requirements: R2.1–R2.7, R3.1–R3.7, R5.1–R5.3, R5.5–R5.7, R6.2, R6.3, R9.12, and the
// success metrics (latency, cross-origin probe).
//
// Test seams, none of which touches the plugin's code:
//   - an init script re-opens the picker's shadow root (`mode: "open"`) so locators can
//     reach the UI, and counts `getDisplayMedia` calls to prove "asks once" (R5.2/R5.7);
//   - the picker button is found by an accessible name matching /zeo|pick/i, the Send and
//     Stop sharing controls by their names (R3.2, R5.3).
//
// Hostile halves:
//   - multi-select: card-a and card-b come from the SAME JSX line, so they carry the same
//     data-zeo-src — they must stay two items (wrongly collapsed by source), and picking
//     card-b before card-a must send them in pick order (wrongly sorted by DOM order);
//   - the page's own click handler must NOT fire while picking, and MUST fire with the
//     picker off (so the first check is not vacuous);
//   - the cross-origin page must not reach Zeo, while the same-origin page does.
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { zeo } from "../src/index.js";
import react from "@vitejs/plugin-react";
import { createServer, type ViteDevServer } from "vite";
import { okInserted, startFakeZeo, type FakeZeo } from "../test/helpers/fake-zeo.js";

const ROOT = fileURLToPath(new URL("../test/fixtures/app", import.meta.url));
const APP_SOURCE = readFileSync(join(ROOT, "src/App.tsx"), "utf8").split("\n");
const lineOf = (marker: string) => {
  const i = APP_SOURCE.findIndex((l) => l.includes(marker));
  if (i < 0) {
    throw new Error(`marker not in fixture: ${marker}`);
  }
  return i + 1;
};

const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
const NO_WINDOW = "No Zeo window has this project open";
const NO_SOURCE = "This element has no source in this project";

type Item = {
  src: { file: string; line: number };
  component: string | null;
  dom: { id: string | null };
};
type Request = {
  items: Item[];
  screenshot: { mime: string; data_b64: string; w: number; h: number } | null;
};

let fake: FakeZeo;
let withShot: { server: ViteDevServer; url: string };
let noShot: { server: ViteDevServer; url: string };

async function dev(screenshot: boolean) {
  const server = await createServer({
    root: ROOT,
    configFile: false,
    logLevel: "silent",
    // The picker relay only: no panel and no announce on the counted fake socket (story 055
    // made both the default; deviation 5.1 did the same for the relay unit tests).
    plugins: [react(), zeo({ screenshot, panel: false })],
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}/` };
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  fake = await startFakeZeo();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
  withShot = await dev(true);
  noShot = await dev(false);
});

test.afterAll(async () => {
  await withShot?.server.close();
  await noShot?.server.close();
  await fake?.dispose();
});

test.beforeEach(async ({ page }) => {
  fake.requests.length = 0;
  fake.receivedAt.length = 0;
  fake.reply = { kind: "json", value: okInserted(1) };
  await page.addInitScript(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init: ShadowRootInit) {
      return attach.call(this, { ...init, mode: "open" });
    };
    const w = window as unknown as { __gdmCalls: number };
    w.__gdmCalls = 0;
    const md = navigator.mediaDevices as MediaDevices | undefined;
    if (md && typeof md.getDisplayMedia === "function") {
      const original = md.getDisplayMedia.bind(md);
      md.getDisplayMedia = (opts?: DisplayMediaStreamOptions) => {
        w.__gdmCalls += 1;
        return original(opts);
      };
    }
  });
});

// ---- helpers ---------------------------------------------------------------------------

/**
 * Loads the fixture in `page` and returns once the picker is mounted, with `page` as the
 * active tab. A tab left behind another one (R6.2 opens a second page after the fixture's)
 * is throttled by Chromium to ~3 animation frames per second, measured under `taskset -c 0`;
 * every `hover()` then waits seconds for its stability check and `isPicking` outlives its
 * poll although the picker is already on. A user picks in the tab they are looking at.
 */
async function open(page: Page, url = noShot.url) {
  await page.bringToFront();
  await page.goto(url);
  await expect(page.locator("#ready")).toHaveText("Fixture app ready");
  // The picker's own ready signal: `mount()` sets it and builds its UI in the same task.
  await expect(page.locator("html[data-zeo-devtools]")).toBeAttached();
}

const pickerButton = (page: Page): Locator => page.getByRole("button", { name: /zeo|pick/i });
const sendButton = (page: Page): Locator => page.getByRole("button", { name: /^send/i });
const tooltip = (page: Page): Locator => page.getByText(/src\/App\.tsx:\d+/);
/** Text of every (re-opened) shadow root on the page: the picker's own UI. */
const pickerText = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("*")].map((el) => el.shadowRoot?.textContent ?? "").join(" "),
  );
const gdmCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __gdmCalls: number }).__gdmCalls);

async function isPicking(page: Page): Promise<boolean> {
  await page.locator("#ready").hover();
  await page.locator("#save").hover();
  return tooltip(page).first().isVisible();
}

async function pickerOn(page: Page) {
  await pickerButton(page).click();
  await expect.poll(() => isPicking(page)).toBe(true);
}

const pick = (page: Page, selector: string, shift = false) =>
  page.locator(selector).click({ force: true, modifiers: shift ? ["Shift"] : [] });

async function nextRequest(n = 1): Promise<Request> {
  await expect.poll(() => fake.requests.length, { timeout: 10_000 }).toBeGreaterThanOrEqual(n);
  return fake.requests[n - 1] as Request;
}

function pngSize(b64: string): { w: number; h: number } {
  const buf = Buffer.from(b64, "base64");
  expect(
    buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  ).toBe(true);
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

// ---- activation (R2.1–R2.5) ------------------------------------------------------------

test("the floating button is shown and toggles the picker (R2.1, R2.4)", async ({ page }) => {
  await open(page);
  await expect(pickerButton(page)).toBeVisible();
  expect(await isPicking(page)).toBe(false);
  await pickerButton(page).click();
  await expect.poll(() => isPicking(page)).toBe(true);
  await pickerButton(page).click();
  await expect.poll(() => isPicking(page)).toBe(false);
});

test("Alt+Shift+Z toggles the picker (R2.3)", async ({ page }) => {
  await open(page);
  await page.keyboard.press("Alt+Shift+Z");
  await expect.poll(() => isPicking(page)).toBe(true);
  await page.keyboard.press("Alt+Shift+Z");
  await expect.poll(() => isPicking(page)).toBe(false);
});

test("dragging the button near another corner docks it there (R2.2)", async ({ page }) => {
  await open(page);
  const vp = page.viewportSize()!;
  const before = (await pickerButton(page).boundingBox())!;
  const startRight = before.x + before.width / 2 > vp.width / 2;
  const startBottom = before.y + before.height / 2 > vp.height / 2;
  const target = { x: startRight ? 40 : vp.width - 40, y: startBottom ? 40 : vp.height - 40 };
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.width / 2, vp.height / 2, { steps: 8 });
  await page.mouse.move(target.x, target.y, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const b = (await pickerButton(page).boundingBox())!;
      const cx = b.x + b.width / 2;
      const cy = b.y + b.height / 2;
      return Math.abs(cx - target.x) < 80 && Math.abs(cy - target.y) < 80;
    })
    .toBe(true);
  expect(fake.requests).toHaveLength(0);
});

test("Esc turns the picker off and discards the pending selection (R2.5)", async ({ page }) => {
  await open(page);
  await pickerOn(page);
  await pick(page, "#card-a", true);
  await pick(page, "#card-b", true);
  await expect(sendButton(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect.poll(() => isPicking(page)).toBe(false);
  await pickerOn(page);
  await expect(sendButton(page)).toBeHidden();
  expect(fake.requests).toHaveLength(0);
});

test("hovering shows the component and file:line (R2.6)", async ({ page }) => {
  await open(page);
  await pickerOn(page);
  await page.locator("#save").hover();
  const tip = tooltip(page).first();
  await expect(tip).toContainText(`src/App.tsx:${lineOf('id="save"')}`);
  await expect(page.getByText(/App/).filter({ hasText: "src/App.tsx" }).first()).toBeVisible();
});

test("page styles do not reach the picker, and the picker adds no style to the page (R2.7)", async ({
  page,
}) => {
  await open(page);
  const pageStyleSheets = await page.evaluate(
    () => document.querySelectorAll("style, link[rel=stylesheet]").length,
  );
  expect(pageStyleSheets).toBe(1); // only the fixture's own <style>
  await page.addStyleTag({ content: "button { display: none !important; }" });
  await expect(page.locator("#save")).toBeHidden(); // the hostile rule really applies to the page
  await expect(pickerButton(page)).toBeVisible(); // ...and not to the picker
  const bg = await page.locator("#static-banner").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bg).toMatch(/sans-serif/);
});

// ---- selecting and sending (R3.x) ------------------------------------------------------

test("hostile converse: with the picker off, the page's click handler fires", async ({ page }) => {
  await open(page);
  await page.locator("#save").click();
  await expect(page.locator("#clicks")).toHaveText("1");
  expect(fake.requests).toHaveLength(0);
});

test("a click sends that element only, with its source line, and the page handler does not fire (R3.1, R3.7)", async ({
  page,
}) => {
  await open(page);
  await pickerOn(page);
  await pick(page, "#save");
  const req = await nextRequest();
  expect(req.items).toHaveLength(1);
  expect(req.items[0]!.src.file).toBe(join(ROOT, "src/App.tsx"));
  expect(req.items[0]!.src.line).toBe(lineOf('id="save"'));
  expect(req.items[0]!.component).toBe("App");
  expect(req.items[0]!.dom.id).toBe("save");
  await expect(page.locator("#clicks")).toHaveText("0");
  await expect(page.getByText("Sent to Zeo")).toBeVisible();
});

test("hostile: two elements from the same JSX line, Shift-picked b then a, are sent as two items in pick order (R3.2, R3.4)", async ({
  page,
}) => {
  await open(page);
  await pickerOn(page);
  await pick(page, "#card-b", true);
  await pick(page, "#card-a", true);
  await expect(sendButton(page)).toBeVisible();
  await expect.poll(() => pickerText(page)).toMatch(/\b2\b/); // the pending count
  expect(fake.requests).toHaveLength(0); // Shift+click alone sends nothing
  fake.reply = { kind: "json", value: okInserted(2) };
  await sendButton(page).click();
  const req = await nextRequest();
  expect(req.items.map((i) => i.dom.id)).toEqual(["card-b", "card-a"]);
  expect(req.items[0]!.src.line).toBe(req.items[1]!.src.line);
  expect(fake.requests).toHaveLength(1); // one request for the whole selection
});

test("Shift+clicking a pending element again removes it (R3.3)", async ({ page }) => {
  await open(page);
  await pickerOn(page);
  await pick(page, "#card-a", true);
  await pick(page, "#card-b", true);
  await pick(page, "#card-a", true);
  await sendButton(page).click();
  const req = await nextRequest();
  expect(req.items.map((i) => i.dom.id)).toEqual(["card-b"]);
});

test("a 21st Shift+click is refused with the limit of 20 (R3.5)", async ({ page }) => {
  await open(page);
  await pickerOn(page);
  for (let n = 1; n <= 20; n++) {
    await pick(page, `#item-${n}`, true);
  }
  await pick(page, "#item-21", true);
  await expect(page.getByText(/limit.*20|20.*limit/i).first()).toBeVisible();
  fake.reply = { kind: "json", value: okInserted(20) };
  await sendButton(page).click();
  const req = await nextRequest();
  expect(req.items).toHaveLength(20);
  expect(req.items.map((i) => i.dom.id)).not.toContain("item-21");
});

test("an element with no tagged ancestor says so and sends nothing (R3.6)", async ({ page }) => {
  await open(page);
  await pickerOn(page);
  await pick(page, "#static-banner");
  await expect(page.getByText(NO_SOURCE)).toBeVisible();
  await page.waitForTimeout(500);
  expect(fake.requests).toHaveLength(0);
});

// ---- answers in the page (R6.x, R9.12) -------------------------------------------------

test("no_window from Zeo shows its message (R9.12)", async ({ page }) => {
  fake.reply = { kind: "json", value: { v: 1, ok: false, error: "no_window", message: NO_WINDOW } };
  await open(page);
  await pickerOn(page);
  await pick(page, "#save");
  await expect(page.getByText(NO_WINDOW)).toBeVisible();
});

test("no socket shows the unreachable message (R6.3)", async ({ page }) => {
  await fake.stop();
  try {
    await open(page);
    await pickerOn(page);
    await pick(page, "#save");
    await expect(page.getByText(UNREACHABLE)).toBeVisible();
  } finally {
    await fake.restart();
  }
});

test("the answer shows in the sending tab only (R6.2)", async ({ page, context }) => {
  const other = await context.newPage();
  await open(other);
  await open(page);
  await pickerOn(page);
  await pick(page, "#save");
  await expect(page.getByText("Sent to Zeo")).toBeVisible();
  await other.waitForTimeout(500);
  await expect(other.getByText("Sent to Zeo")).toHaveCount(0);
  await other.close();
});

// ---- screenshots (R5.x) ----------------------------------------------------------------

test.describe("Chromium tab capture", () => {
  test.use({ viewport: { width: 2000, height: 1000 } });

  test("sends a cropped PNG ≤ 1568 px, asks once, and Stop sharing ends it (R5.1–R5.3, R5.5)", async ({
    page,
    browserName,
  }) => {
    test.skip(browserName !== "chromium", "Chromium only: --auto-accept-this-tab-capture");
    await open(page, withShot.url);
    await pickerOn(page);
    await pick(page, "#wide");
    const first = await nextRequest(1);
    expect(first.screenshot).not.toBeNull();
    expect(first.screenshot!.mime).toBe("image/png");
    const size = pngSize(first.screenshot!.data_b64);
    expect(Math.max(size.w, size.h)).toBeLessThanOrEqual(1568);
    expect(Math.min(size.w, size.h)).toBeGreaterThan(0);
    expect({ w: first.screenshot!.w, h: first.screenshot!.h }).toEqual(size);
    expect(size.w).toBeGreaterThan(size.h); // the crop is the wide block, not the whole tab

    await pick(page, "#save");
    const second = await nextRequest(2);
    expect(second.screenshot).not.toBeNull();
    expect(await gdmCalls(page)).toBe(1);

    const stop = page.getByRole("button", { name: /stop sharing/i });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(stop).toBeHidden();
    await pick(page, "#save");
    await nextRequest(3);
    expect(await gdmCalls(page)).toBe(2);
  });
});

test("Firefox sends without an image and says why (R5.6)", async ({ page, browserName }) => {
  test.skip(browserName !== "firefox", "Firefox only: no single-tab surface");
  await open(page, withShot.url);
  await pickerOn(page);
  await pick(page, "#save");
  const req = await nextRequest();
  expect(req.screenshot).toBeNull();
  expect(req.items).toHaveLength(1);
  await expect(
    page.getByText(/without (an )?image|no (screen)?shot|screenshot/i).first(),
  ).toBeVisible();
});

test("screenshot: false never asks to share the screen (R5.7)", async ({ page }) => {
  await open(page, noShot.url);
  await pickerOn(page);
  await pick(page, "#save");
  const req = await nextRequest();
  expect(req.screenshot).toBeNull();
  expect(await gdmCalls(page)).toBe(0);
});

// ---- success metrics -------------------------------------------------------------------

test("click-to-socket latency: < 1 s without a screenshot", async ({ page }) => {
  await open(page, noShot.url);
  await pickerOn(page);
  const started = Date.now();
  await pick(page, "#save");
  await nextRequest();
  expect(fake.receivedAt[0]! - started).toBeLessThan(1000);
});

test("click-to-socket latency: < 2 s with a screenshot (Chromium)", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "Chromium only: tab capture");
  await open(page, withShot.url);
  await pickerOn(page);
  const started = Date.now();
  await pick(page, "#save");
  const req = await nextRequest();
  expect(req.screenshot).not.toBeNull();
  expect(fake.receivedAt[0]! - started).toBeLessThan(2000);
});

test("hostile: a page from another origin cannot open the HMR socket, so Zeo receives nothing", async ({
  page,
}) => {
  const vitePort = new URL(noShot.url).port;
  const payload = {
    v: 1,
    page_url: "http://evil.test/",
    items: [
      {
        src: { file: "src/App.tsx", line: 1, column: 1, end_line: 1 },
        component: null,
        dom: {
          tag: "div",
          id: null,
          classes: [],
          text: "",
          attrs: {},
          styles: {},
          rect: { x: 0, y: 0, w: 1, h: 1 },
        },
      },
    ],
    screenshot: null,
  };
  const html = `<!doctype html><script>
    window.__probe = { opened: 0, errors: 0 };
    for (const q of ["", "?token=guess"]) {
      const ws = new WebSocket("ws://127.0.0.1:${vitePort}/" + q, "vite-hmr");
      ws.onopen = () => {
        window.__probe.opened += 1;
        ws.send(JSON.stringify({ type: "custom", event: "zeo:select", data: ${JSON.stringify(payload)} }));
      };
      ws.onerror = () => { window.__probe.errors += 1; };
    }
  </script>`;
  const evil: Server = createHttpServer((_, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(html);
  });
  await new Promise<void>((r) => evil.listen(0, "127.0.0.1", () => r()));
  try {
    const port = (evil.address() as AddressInfo).port;
    await page.goto(`http://127.0.0.1:${port}/`);
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __probe: { errors: number } }).__probe.errors),
      )
      .toBe(2);
    expect(
      await page.evaluate(
        () => (window as unknown as { __probe: { opened: number } }).__probe.opened,
      ),
    ).toBe(0);
    await page.waitForTimeout(500);
    expect(fake.requests).toHaveLength(0);
  } finally {
    await new Promise<void>((r) => evil.close(() => r()));
  }
});
