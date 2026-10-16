// Story 052, task 2.2 — E2E: the picker on a REAL `astro dev` page, a real click reaching a fake
// Zeo socket, and a real `astro build` carrying nothing of the plugin.
// Requirements: R1.1, R1.2, R1.4, R1.6, R1.8, R2.2–R2.5, R2.8 (R2.6 and R2.7 are the contract
// fixtures and e2e/picker.spec.ts, run untouched next to this spec).
//
// Astro runs in-process (`dev()` / `build()` from "astro") on `test/fixtures/astro` with
// `zeoAstro()` in `integrations` and `ZEO_DEVTOOLS_SOCKET` pointing at the fake Zeo of
// test/helpers/fake-zeo.ts. Test seams, none touching the plugin's code:
//   - an init script re-opens the picker's shadow root so locators can reach its UI (as in
//     e2e/picker.spec.ts);
//   - R2.8 needs a module the tagger cannot parse on a page that still renders. Astro's
//     compiler and `parse()` reject the same inputs, so no real file can be both. The plugin
//     parses with the APP's `@astrojs/compiler-rs` while Astro compiles with its own copy, so
//     `beforeAll` gives the fixture a `node_modules/@astrojs/compiler-rs` that wraps the real one
//     and reports a parse error for any module carrying `zeo-e2e:unparseable`
//     (src/pages/broken.astro). `afterAll` removes it; `node_modules/` is gitignored.
//   - `astro dev` is stopped before `astro build` runs, so the two never share the process.
//
// Hostile halves:
//   - multi-byte text (ç, →, emoji) sits before every element of Hero.astro: the line Zeo
//     receives must be the line an editor shows (wrongly shifted);
//   - card-a and card-b come from the SAME source line of Card.astro: Shift-picked b then a,
//     they stay two items in pick order (wrongly collapsed by source);
//   - the component is the file that rendered the element: the layout's header is `Base`, the
//     page's paragraph is `index`, a card is `Card` (wrongly named after the page);
//   - the broken page has the picker loaded (so "nothing sent" is not vacuous) and gives the
//     no-source toast;
//   - the build output is first proved to be the fixture's own pages, so "no data-zeo-" is not
//     vacuously true of an empty build.
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { build, dev } from "astro";
import { zeoAstro } from "../src/index.js";
import { okInserted, startFakeZeo, type FakeZeo } from "../test/helpers/fake-zeo.js";

const ROOT = fileURLToPath(new URL("../test/fixtures/astro", import.meta.url));
const SHIM_DIR = join(ROOT, "node_modules/@astrojs/compiler-rs");
const REAL_COMPILER = createRequire(import.meta.url).resolve("@astrojs/compiler-rs");
const NO_SOURCE = "This element has no source in this project";

const source = (rel: string) => readFileSync(join(ROOT, rel), "utf8").split("\n");
/** 1-based line of the first line of `rel` containing `marker`. */
const lineOf = (rel: string, marker: string) => {
  const i = source(rel).findIndex((l) => l.includes(marker));
  if (i < 0) {
    throw new Error(`marker not in fixture ${rel}: ${marker}`);
  }
  return i + 1;
};
/** 1-based column of `<` of the element on the line holding `marker`. */
const columnOf = (rel: string, marker: string) => {
  const line = source(rel)[lineOf(rel, marker) - 1]!;
  return line.lastIndexOf("<", line.indexOf(marker)) + 1;
};

type Item = {
  src: { file: string; line: number; column: number };
  component: string | null;
  dom: { id: string | null };
};
type Request = { items: Item[] };

let fake: FakeZeo;
let server: { stop(): Promise<void>; address: AddressInfo } | undefined;
let url = "";

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", () => r()));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

/** The fixture's own `@astrojs/compiler-rs`: the real one, with `parse()` failing on a marker. */
async function writeCompilerShim() {
  await mkdir(SHIM_DIR, { recursive: true });
  await writeFile(
    join(SHIM_DIR, "package.json"),
    JSON.stringify({
      name: "@astrojs/compiler-rs",
      version: "0.0.0-zeo-e2e",
      type: "module",
      exports: { ".": "./index.mjs", "./package.json": "./package.json" },
    }),
  );
  const real = JSON.stringify(pathToFileURL(REAL_COMPILER).href);
  await writeFile(
    join(SHIM_DIR, "index.mjs"),
    [
      `import * as real from ${real};`,
      `export * from ${real};`,
      "export function parse(source) {",
      "  const result = real.parse(source);",
      '  if (!source.includes("zeo-e2e:unparseable")) {',
      "    return result;",
      "  }",
      "  const forced = { severity: 'error', text: 'zeo e2e: forced parse failure', hint: '', labels: [] };",
      "  return { ...result, diagnostics: [...result.diagnostics, forced] };",
      "}",
    ].join("\n"),
  );
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  process.env.ASTRO_TELEMETRY_DISABLED = "1";
  await writeCompilerShim();
  fake = await startFakeZeo();
  process.env.ZEO_DEVTOOLS_SOCKET = fake.path;
});

test.afterAll(async () => {
  await fake?.dispose();
  await rm(SHIM_DIR, { recursive: true, force: true });
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
  });
});

// ---- helpers ---------------------------------------------------------------------------

async function open(page: Page, path = "") {
  await page.goto(url + path);
  await expect(page.locator(path === "broken" ? "#broken-ready" : "#ready")).toBeVisible();
}

const pickerButton = (page: Page): Locator => page.getByRole("button", { name: /zeo|pick/i });
const sendButton = (page: Page): Locator => page.getByRole("button", { name: /^send/i });
const tooltip = (page: Page): Locator => page.getByText(/src\/[\w/]+\.astro:\d+/);

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

test.describe("astro dev", () => {
  test.beforeAll(async () => {
    const port = await freePort();
    server = await dev({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      devToolbar: { enabled: false },
      // The picker relay only: no panel and no announce on the counted fake socket (story 055
      // made both the default; deviation 5.1 did the same for the relay unit tests).
      integrations: [zeoAstro({ screenshot: false, panel: false })],
      server: { host: "127.0.0.1", port },
    });
    url = `http://127.0.0.1:${server.address.port}/`;
  });

  // Stopped before the build describe runs: the two never share the process at once.
  test.afterAll(async () => {
    await server?.stop();
    server = undefined;
  });

  // ---- the picker on an Astro page (R2.2, R2.4) ------------------------------------------

  test("the picker loads on an astro dev page and toggles (R2.2)", async ({ page }) => {
    await open(page);
    await expect(pickerButton(page)).toBeVisible();
    expect(await isPicking(page)).toBe(false);
    await page.keyboard.press("Alt+Shift+Z");
    await expect.poll(() => isPicking(page)).toBe(true);
  });

  test("the served page carries the source attributes (R1.1, R1.2)", async ({ page }) => {
    await open(page);
    const rel = "src/components/Hero.astro";
    await expect(page.locator("#save")).toHaveAttribute(
      "data-zeo-src",
      `${rel}:${lineOf(rel, 'id="save"')}:${columnOf(rel, 'id="save"')}-${lineOf(rel, 'id="save"')}`,
    );
    await expect(page.locator("#save")).toHaveAttribute("data-zeo-c", "Hero");
    await expect(page.locator("#item-2")).toHaveAttribute("data-zeo-c", "Hero");
    // No <script> or <style> carries one: on <script> it would make Astro inline the script.
    expect(await page.locator("script[data-zeo-src], style[data-zeo-src]").count()).toBe(0);
  });

  test("hovering shows <Component> · <path>:<line> (R2.4)", async ({ page }) => {
    await open(page);
    await pickerOn(page);
    await page.locator("#card-a-title").hover();
    const rel = "src/components/Card.astro";
    await expect(tooltip(page).first()).toHaveText(`Card · ${rel}:${lineOf(rel, "<h2")}`);
  });

  // ---- picking (R2.5) --------------------------------------------------------------------

  test("hostile: a pick after multi-byte text sends the .astro file and the line an editor shows (R1.4, R2.5)", async ({
    page,
  }) => {
    await open(page);
    await pickerOn(page);
    await pick(page, "#save");
    const req = await nextRequest();
    const rel = "src/components/Hero.astro";
    expect(req.items).toHaveLength(1);
    expect(req.items[0]!.src.file).toBe(join(ROOT, rel));
    expect(req.items[0]!.src.line).toBe(lineOf(rel, 'id="save"'));
    expect(req.items[0]!.src.column).toBe(columnOf(rel, 'id="save"'));
    expect(req.items[0]!.component).toBe("Hero");
    expect(req.items[0]!.dom.id).toBe("save");
    await expect(page.getByText("Sent to Zeo")).toBeVisible();
  });

  test("an element rendered inside {items.map(...)} is picked with its own line (R1.1)", async ({
    page,
  }) => {
    await open(page);
    await pickerOn(page);
    await pick(page, "#item-2");
    const req = await nextRequest();
    const rel = "src/components/Hero.astro";
    expect(req.items[0]!.src.file).toBe(join(ROOT, rel));
    expect(req.items[0]!.src.line).toBe(lineOf(rel, "items.map"));
    expect(req.items[0]!.dom.id).toBe("item-2");
  });

  test("hostile: the component is the file that rendered the element, not the page (R1.2)", async ({
    page,
  }) => {
    await open(page);
    await pickerOn(page);
    await pick(page, "#layout-header", true);
    await pick(page, "#ready", true);
    await pick(page, "#card-b-title", true);
    fake.reply = { kind: "json", value: okInserted(3) };
    await sendButton(page).click();
    const req = await nextRequest();
    expect(req.items.map((i) => [i.dom.id, i.component, i.src.file])).toEqual([
      ["layout-header", "Base", join(ROOT, "src/layouts/Base.astro")],
      ["ready", "index", join(ROOT, "src/pages/index.astro")],
      ["card-b-title", "Card", join(ROOT, "src/components/Card.astro")],
    ]);
    expect(req.items[0]!.src.line).toBe(lineOf("src/layouts/Base.astro", 'id="layout-header"'));
    expect(req.items[1]!.src.line).toBe(lineOf("src/pages/index.astro", 'id="ready"'));
  });

  test("hostile: two cards from the same source line, Shift-picked b then a, stay two items in pick order", async ({
    page,
  }) => {
    await open(page);
    await pickerOn(page);
    await pick(page, "#card-b", true);
    await pick(page, "#card-a", true);
    fake.reply = { kind: "json", value: okInserted(2) };
    await sendButton(page).click();
    const req = await nextRequest();
    expect(req.items.map((i) => i.dom.id)).toEqual(["card-b", "card-a"]);
    expect(req.items[0]!.src.line).toBe(req.items[1]!.src.line);
    expect(req.items[0]!.src.file).toBe(join(ROOT, "src/components/Card.astro"));
  });

  // ---- a module the tagger could not parse (R1.6, R2.8) -----------------------------------

  test("a pick on a page whose module could not be parsed shows the no-source toast and sends nothing (R2.8)", async ({
    page,
  }) => {
    await open(page, "broken");
    await expect(pickerButton(page)).toBeVisible(); // the picker is there: "nothing sent" is not vacuous
    expect(await page.locator("#broken-target").getAttribute("data-zeo-src")).toBeNull();
    await pickerButton(page).click();
    await pick(page, "#broken-target");
    await expect(page.getByText(NO_SOURCE)).toBeVisible();
    await page.waitForTimeout(500);
    expect(fake.requests).toHaveLength(0);
  });
});

// ---- astro build (R1.8, R2.3) ----------------------------------------------------------

test("astro build emits the fixture's pages with no data-zeo- attribute and no picker (R1.8, R2.3)", async ({
  browserName,
}) => {
  test.skip(browserName !== "chromium", "browser-independent: run once");
  test.setTimeout(120_000);
  const outDir = await mkdtemp(join(tmpdir(), "zeo-astro-dist-"));
  try {
    await build({
      root: ROOT,
      configFile: false,
      logLevel: "silent",
      outDir,
      devToolbar: { enabled: false },
      integrations: [zeoAstro()],
    });
    const entries = await readdir(outDir, { recursive: true, withFileTypes: true });
    const files = entries.filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name));
    const output = (await Promise.all(files.map((f) => readFile(f, "utf8")))).join("\n");
    expect(output).toContain("Astro fixture ready"); // non-vacuous: the real pages are there
    expect(output).toContain("Layout header");
    expect(output).not.toContain("data-zeo-");
    expect(output).not.toContain("@zeo-devtools");
    expect(output).not.toContain("zeo:select");
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
