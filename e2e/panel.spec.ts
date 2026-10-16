// Story 055, task 7.1 — E2E: the devtools panel in real Chromium and Firefox (both Playwright
// projects), against the v2 fake Zeo (test/helpers/fake-zeo-v2.ts), with the fixture app
// (`test/fixtures/app`) served by an in-process `vite dev` running `zeo()`.
// Requirements: R3.2, R3.3, R3.5, R3.6, R5.7, R6.1, R6.2, R6.3, R6.4, R6.5, R6.7, R7.2, R7.3 (Q13) and
// the success metrics "zero editor threads in the panel" and "no script in the app iframe can
// send, cancel or answer anything". Accessibility (Q17) is e2e/panel.a11y.spec.ts.
//
// The panel URL is read from the dev server's announce (`hello.client.panel_url`), exactly as Zeo
// learns it. The fake answers a panel session the way Zeo would: `threads`, `created`, `snapshot`,
// `sent` + entries, `ok`; the test pushes `status`, `permission_requested`, `project_closed` and
// `project_open` itself. "A script in the app" is code evaluated inside the app's frame.
//
// Hostile halves first:
//   - every thread action posted by the app to the panel — bare, in 0058's envelope, and as the
//     panel's own rpc body — reaches Zeo as NOTHING, while the app's own `app_location` IS shown
//     (so the drop is not a dead listener);
//   - a frame NESTED in the app (same origin as the app, another window) is dropped too;
//   - `fetch` to the panel API from the app is refused, and `top.location = …` from the app leaves
//     the panel where it is;
//   - the iframe's origin differs from the panel's (G13) and its sandbox omits
//     `allow-top-navigation`;
//   - while `project_closed` holds, New thread sends nothing; `project_open` restores it without
//     a reload.
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Frame, type Page } from "@playwright/test";
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
const CLOSED = "Open this project in Zeo to continue";

let fake: FakeZeoV2;
let server: ViteDevServer;
let appUrl: string;
let panelUrl: string;
let listed: ReturnType<typeof threadInfo>[] = [];

const panelConns = () =>
  fake.conns.filter((c) => (c.hello?.client as { kind?: string } | undefined)?.kind === "panel");
const latestPanel = () => panelConns().at(-1);
const allPanelLines = () => panelConns().flatMap((c) => c.lines as Msg[]);

/** Zeo's side of a panel session, as far as these flows need it. */
function respond(conn: V2Conn, msg: Msg) {
  const id = typeof msg.id === "string" ? msg.id : undefined;
  const isPanel = (conn.hello?.client as { kind?: string } | undefined)?.kind === "panel";
  if (!isPanel) {
    return;
  }
  switch (msg.kind) {
    case "hello":
      // R7.6: after the welcome, the project's current state.
      conn.send({ v: 2, kind: "project_open" });
      break;
    case "list_threads":
      conn.send({ v: 2, kind: "threads", id: id ?? "r", items: listed });
      break;
    case "create_thread": {
      const t = threadInfo("t-new", "New thread", ROOT);
      listed = [t, ...listed];
      conn.send({ v: 2, kind: "created", id: id ?? "c", thread: t });
      break;
    }
    case "subscribe": {
      const target = (msg.target as { thread_id?: string } | undefined)?.thread_id;
      const t =
        listed.find((x) => x.thread_id === target) ??
        threadInfo(String(target), String(target), ROOT);
      conn.send({
        v: 2,
        kind: "snapshot",
        id,
        thread: t,
        earlier: 0,
        entries: [],
        status: { state: "idle", message: null },
        permissions: [],
      });
      break;
    }
    case "send":
      conn.send({ v: 2, kind: "sent", id: id ?? "s", queued: false, images: "none" });
      conn.send({
        v: 2,
        kind: "entry_added",
        index: 0,
        entry: { role: "user", markdown: String(msg.text), truncated: false },
      });
      conn.send({
        v: 2,
        kind: "entry_added",
        index: 1,
        entry: { role: "assistant", markdown: "Agent reply: **done**", truncated: false },
      });
      break;
    case "cancel":
    case "authorize":
      conn.send({ v: 2, kind: "ok", id: id ?? "o" });
      if (msg.kind === "authorize") {
        conn.send({ v: 2, kind: "permission_resolved", request_id: msg.request_id });
      }
      break;
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

test.beforeEach(() => {
  listed = [
    threadInfo("t-1", "Devtools thread one", ROOT),
    threadInfo("t-2", "Devtools thread two", ROOT),
  ];
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

async function bindNewThread(page: Page) {
  await page.getByRole("button", { name: /^new thread$/i }).click();
  await expect(page.getByRole("textbox")).toBeVisible();
}

// ---- the page and its iframe (R3.2, G13) ----------------------------------------------------

test("the app runs in a sandboxed iframe of another origin, without top navigation", async ({
  page,
}) => {
  await openPanel(page);
  const iframe = page.locator("iframe");
  await expect(iframe).toHaveCount(1);
  const src = (await iframe.getAttribute("src")) ?? "";
  expect(new URL(src).origin).toBe(new URL(appUrl).origin);
  expect(new URL(src).origin).not.toBe(new URL(panelUrl).origin);
  const sandbox = ((await iframe.getAttribute("sandbox")) ?? "").split(/\s+/);
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-top-navigation");
  expect(sandbox).not.toContain("allow-top-navigation-by-user-activation");
  await appFrame(page);
});

// ---- picker and binding (R6.1, R5.7) ----------------------------------------------------------

test("with no thread bound, only New thread and the project's devtools threads show", async ({
  page,
}) => {
  await openPanel(page);
  await expect(page.getByText("Devtools thread one")).toBeVisible();
  await expect(page.getByText("Devtools thread two")).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText(/follow/i)).toHaveCount(0);
});

// ---- the chat (R6.2-R6.5) ------------------------------------------------------------------

test("send streams the agent's reply; Stop cancels; a permission is answered", async ({ page }) => {
  await openPanel(page);
  await bindNewThread(page);
  await page.getByRole("textbox").fill("make the save button green");
  await page.getByRole("button", { name: /^send$/i }).click();
  await expect
    .poll(() =>
      allPanelLines().some((m) => m.kind === "send" && m.text === "make the save button green"),
    )
    .toBe(true);
  await expect(page.getByText("Agent reply:")).toBeVisible();
  await expect(page.locator("strong", { hasText: "done" })).toBeVisible();

  latestPanel()!.send({ v: 2, kind: "status", status: { state: "working", message: null } });
  await page.getByRole("button", { name: /^stop$/i }).click();
  await expect.poll(() => allPanelLines().some((m) => m.kind === "cancel")).toBe(true);

  latestPanel()!.send({
    v: 2,
    kind: "permission_requested",
    permission: {
      request_id: "q-9",
      entry_index: 1,
      title: "Edit src/App.tsx?",
      options: [
        { option_id: "allow", label: "Allow once", kind: "allow_once" },
        { option_id: "reject", label: "Reject", kind: "reject_once" },
      ],
    },
  });
  await expect(page.getByText("Edit src/App.tsx?")).toBeVisible();
  await page.getByRole("button", { name: /allow once/i }).click();
  await expect
    .poll(() =>
      allPanelLines().some(
        (m) => m.kind === "authorize" && m.request_id === "q-9" && m.option_id === "allow",
      ),
    )
    .toBe(true);
  await expect(page.getByText("Edit src/App.tsx?")).toHaveCount(0);
});

// ---- project closed / open (R7.2, R7.3) ---------------------------------------------------------

test("project_closed disables the panel; project_open restores it without a reload", async ({
  page,
}) => {
  await openPanel(page);
  const navigations: string[] = [];
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) {
      navigations.push(f.url());
    }
  });
  latestPanel()!.send({ v: 2, kind: "project_closed" });
  await expect(page.getByText(CLOSED)).toBeVisible();
  const newThread = page.getByRole("button", { name: /^new thread$/i });
  await expect(newThread).toBeDisabled();
  const before = allPanelLines().filter((m) => m.kind === "create_thread").length;
  await newThread.click({ force: true });
  await page.waitForTimeout(300);
  expect(allPanelLines().filter((m) => m.kind === "create_thread").length).toBe(before);

  latestPanel()!.send({ v: 2, kind: "project_open" });
  await expect(page.getByText(CLOSED)).toHaveCount(0);
  await expect(newThread).toBeEnabled();
  expect(navigations, "no reload").toEqual([]);
});

// ---- hostile app scripts (R3.3, R3.5, R3.6) -------------------------------------------------

test("hostile: no app script can send, cancel, answer or create anything in a thread", async ({
  page,
}) => {
  await openPanel(page);
  await bindNewThread(page);
  const frame = await appFrame(page);
  const actionKinds = [
    "send",
    "cancel",
    "authorize",
    "create_thread",
    "subscribe",
    "list_threads",
    "open_in_zeo",
  ];
  const countActions = () =>
    allPanelLines().filter((m) => actionKinds.includes(String(m.kind))).length;
  const baseline = countActions();

  await frame.evaluate(() => {
    const actions: Array<Record<string, unknown>> = [
      { kind: "send", text: "HOSTILE-SEND", attachments: [] },
      { kind: "cancel" },
      { kind: "authorize", request_id: "q-1", option_id: "allow" },
      { kind: "create_thread" },
      { kind: "subscribe", target: { thread_id: "t-2" } },
      { kind: "open_in_zeo" },
    ];
    for (const a of actions) {
      parent.postMessage(a, "*");
      parent.postMessage({ v: 2, id: "x", ...a }, "*");
      parent.postMessage({ panel: "guess", msg: a }, "*");
      parent.postMessage(JSON.stringify(a), "*");
    }
  });
  // A frame nested in the app: same origin as the app, but not the iframe's window.
  await frame.evaluate(() => {
    const nested = document.createElement("iframe");
    nested.srcdoc =
      "<script>top.postMessage({kind:'app_location',href:'http://127.0.0.1:1/NESTED-FAKE',title:'NESTED-FAKE'},'*');" +
      "top.postMessage({kind:'send',text:'HOSTILE-NESTED',attachments:[]},'*');</" +
      "script>";
    document.body.append(nested);
  });
  await page.waitForTimeout(500);
  expect(countActions(), "no thread action reached Zeo").toBe(baseline);
  expect(JSON.stringify(allPanelLines())).not.toContain("HOSTILE");
  await expect(page.getByText("NESTED-FAKE")).toHaveCount(0);

  // The benign half: the app's own navigation IS reported to the panel.
  await frame.evaluate(() => history.pushState(null, "", "/zeo-e2e-location"));
  await expect(page.getByText(/zeo-e2e-location/)).toBeVisible();
});

test("hostile: the app cannot call the panel API or navigate the panel away", async ({ page }) => {
  await openPanel(page);
  const frame = await appFrame(page);
  const before = fake.conns.length;
  const results = await frame.evaluate(async (panel) => {
    const out: string[] = [];
    for (const [path, body] of [
      ["/api/panels", "{}"],
      ["/api/rpc", JSON.stringify({ panel: "x", msg: { kind: "list_threads" } })],
    ] as const) {
      try {
        const r = await fetch(new URL(path, panel), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        out.push(`status:${r.status}`);
      } catch {
        out.push("blocked");
      }
      try {
        const r = await fetch(new URL(path, panel), { method: "POST", mode: "no-cors", body });
        out.push(`opaque:${r.type}`);
      } catch {
        out.push("blocked");
      }
    }
    return out;
  }, panelUrl);
  expect(results.some((r) => r === "status:200" || r === "status:204")).toBe(false);
  await page.waitForTimeout(300);
  expect(fake.conns.length, "no panel session opened by the app").toBe(before);

  await frame.evaluate(() => {
    try {
      (top as Window).location.href = "https://example.com/";
    } catch {
      // blocked by the sandbox, as wanted
    }
  });
  await page.waitForTimeout(500);
  expect(new URL(page.url()).origin).toBe(new URL(panelUrl).origin);
});

// ---- isolation from editor threads (success metric) ---------------------------------------------

test("the panel lists exactly what Zeo lists for it, nothing more", async ({ page }) => {
  listed = [threadInfo("t-only", "Only devtools thread", ROOT)];
  await openPanel(page);
  await expect(page.getByText("Only devtools thread")).toBeVisible();
  await expect(page.getByText("Devtools thread one")).toHaveCount(0);
});

// ---- HMR, not the panel, refreshes the app (R6.7) ---------------------------------------------

test.describe("an edit to the app's source", () => {
  // A private copy of the fixture app, so the edit never touches the repository. Its
  // node_modules is a symlink to the package's, and Vite's cache lives in the copy.
  let dir: string;
  let hmrServer: ViteDevServer;
  let hmrPanelUrl: string;

  test.beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "zeo-hmr-"));
    await cp(ROOT, join(dir, "app"), { recursive: true });
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(dir, "app", "node_modules"),
    );
    const before = fake.conns.length;
    hmrServer = await createServer({
      root: join(dir, "app"),
      configFile: false,
      logLevel: "silent",
      cacheDir: join(dir, ".vite"),
      plugins: [react(), zeo()],
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    });
    await hmrServer.listen();
    const announce = await fake.waitForConn(
      (c) =>
        c.n >= before && (c.hello?.client as { kind?: string } | undefined)?.kind === "dev_server",
      10_000,
    );
    hmrPanelUrl = (announce.hello!.client as { panel_url: string }).panel_url;
  });

  test.afterAll(async () => {
    await hmrServer?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("is shown in the iframe by HMR, with no reload of the panel or the app", async ({
    page,
  }) => {
    await page.goto(hmrPanelUrl);
    const navigations: string[] = [];
    page.on("framenavigated", (f) => navigations.push(f === page.mainFrame() ? "panel" : f.url()));
    await expect.poll(() => page.frames().length, { timeout: 10_000 }).toBeGreaterThan(1);
    const frame = page.frames().find((f) => f !== page.mainFrame())!;
    await expect(frame.locator("#ready")).toHaveText("Fixture app ready");
    await frame.evaluate(() => ((window as unknown as { __zeoMarker: number }).__zeoMarker = 42));

    const file = join(dir, "app", "src", "App.tsx");
    const source = await readFile(file, "utf8");
    expect(source).toContain("Fixture app ready");
    await writeFile(file, source.replace("Fixture app ready", "Fixture app edited"));

    await expect(frame.locator("#ready")).toHaveText("Fixture app edited", { timeout: 10_000 });
    expect(
      await frame.evaluate(() => (window as unknown as { __zeoMarker?: number }).__zeoMarker),
      "the app was hot-updated, not reloaded",
    ).toBe(42);
    expect(navigations, "neither the panel nor the iframe navigated").toEqual([]);
  });
});
