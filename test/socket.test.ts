// Story 033, task 5.1 — the relay's socket client, against a REAL `net.Server` on a temp
// unix socket. Requirements: R6.3, R6.4 (and Q4: it never rejects, never leaks the socket).
// Contract: `sendToZeo(socketPath, req: SelectionToZeo, timeoutMs = 10_000):
// Promise<DevtoolsResult>` — one NDJSON line out, one line back (design.md §Data Models).
//
// Hostile halves:
//   - `sun_path` is 108 bytes on Linux: a 108-byte path must be refused without a truncated
//     connect, while a path of exactly 107 bytes MUST still connect (wrongly refused by an
//     off-by-one);
//   - "unreachable" covers no file, a non-socket file (ECONNREFUSED) and an early EOF, but a
//     silent server is a `timeout`, not `unreachable` (the two must stay distinguishable);
//   - two concurrent calls each get their own answer (no cross-talk).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sendToZeo } from "../src/socket.js";
import { okInserted, startFakeZeo, type FakeZeo } from "./helpers/fake-zeo.js";

const request = (n = 1) => ({
  v: 1 as const,
  project_root: "/home/dev/app",
  page_url: "http://localhost:5173/",
  items: Array.from({ length: n }, (_, i) => ({
    src: { file: `/home/dev/app/src/F${i}.tsx`, line: 3, column: 5, end_line: 6 },
    component: "App",
    dom: {
      tag: "div",
      id: null,
      classes: [],
      text: "",
      attrs: {},
      styles: {},
      rect: { x: 0, y: 0, w: 1, h: 1 },
    },
  })),
  screenshot: null,
});

const fakes: FakeZeo[] = [];
const dirs: string[] = [];
async function fake(path?: string) {
  const f = await startFakeZeo(path);
  fakes.push(f);
  return f;
}
async function tempDir() {
  const d = await mkdtemp(join(tmpdir(), "zs-"));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.dispose()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const until = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return cond();
};

describe("round trip", () => {
  it("writes exactly one JSON line and returns Zeo's answer", async () => {
    const zeo = await fake();
    zeo.reply = { kind: "json", value: okInserted(2) };
    const req = request(2);
    const result = await sendToZeo(zeo.path, req);
    expect(result).toEqual(okInserted(2));
    expect(zeo.requests).toEqual([req]);
  });

  it("returns an error answer from Zeo as is", async () => {
    const zeo = await fake();
    const answer = {
      v: 1,
      ok: false,
      error: "no_window",
      message: "No Zeo window has this project open",
    };
    zeo.reply = { kind: "json", value: answer };
    expect(await sendToZeo(zeo.path, request())).toEqual(answer);
  });

  it("two concurrent calls each get their own answer", async () => {
    const a = await fake();
    const b = await fake();
    a.reply = { kind: "json", value: okInserted(1) };
    b.reply = { kind: "json", value: okInserted(3) };
    const [ra, rb] = await Promise.all([
      sendToZeo(a.path, request(1)),
      sendToZeo(b.path, request(3)),
    ]);
    expect(ra).toEqual(okInserted(1));
    expect(rb).toEqual(okInserted(3));
  });

  it("closes its socket after the answer", async () => {
    const zeo = await fake();
    await sendToZeo(zeo.path, request());
    expect(await until(() => zeo.closed >= 1)).toBe(true);
  });
});

describe("unreachable (R6.3)", () => {
  it("no socket file", async () => {
    const dir = await tempDir();
    const result = await sendToZeo(join(dir, "absent.sock"), request());
    expect(result).toMatchObject({ v: 1, ok: false, error: "unreachable" });
  });

  it("a file that is not a listening socket (connection refused)", async () => {
    const dir = await tempDir();
    const path = join(dir, "stale.sock");
    await writeFile(path, "");
    expect(await sendToZeo(path, request())).toMatchObject({ ok: false, error: "unreachable" });
  });

  it("the peer closes without answering (early EOF)", async () => {
    const zeo = await fake();
    zeo.reply = { kind: "close" };
    expect(await sendToZeo(zeo.path, request())).toMatchObject({ ok: false, error: "unreachable" });
  });
});

describe("timeout (R6.4)", () => {
  it("hostile: a silent peer is a timeout, not unreachable, and the socket is released", async () => {
    const zeo = await fake();
    zeo.reply = { kind: "silent" };
    const started = Date.now();
    const result = await sendToZeo(zeo.path, request(), 200);
    const elapsed = Date.now() - started;
    expect(result).toMatchObject({ v: 1, ok: false, error: "timeout" });
    expect(typeof (result as { message?: unknown }).message).toBe("string");
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(3000);
    expect(await until(() => zeo.closed >= 1)).toBe(true);
  });
});

describe("malformed answers never reject", () => {
  it("an answer that is not JSON", async () => {
    const zeo = await fake();
    zeo.reply = { kind: "raw", text: "not json\n" };
    await expect(sendToZeo(zeo.path, request())).resolves.toMatchObject({
      ok: false,
      error: "bad_request",
    });
  });

  it("an answer outside the result contract", async () => {
    const zeo = await fake();
    zeo.reply = { kind: "json", value: { v: 1, ok: true, outcome: "exploded" } };
    await expect(sendToZeo(zeo.path, request())).resolves.toMatchObject({
      ok: false,
      error: "bad_request",
    });
  });
});

describe("socket path length (design Gotcha: sun_path is 108 bytes)", () => {
  async function pathOfBytes(n: number): Promise<string> {
    const dir = await tempDir();
    const base = `${dir}/`;
    const path = base + "s".repeat(n - Buffer.byteLength(base));
    expect(Buffer.byteLength(path)).toBe(n);
    return path;
  }

  it("hostile: a 108-byte path is refused with a message, nothing is connected", async () => {
    const path = await pathOfBytes(108);
    const result = await sendToZeo(path, request());
    expect(result.ok).toBe(false);
    expect((result as { message: string }).message.length).toBeGreaterThan(0);
  });

  it("hostile converse: a 107-byte path still connects", async () => {
    const path = await pathOfBytes(107);
    const zeo = await fake(path);
    expect(await sendToZeo(path, request())).toEqual(okInserted(1));
    expect(zeo.requests).toHaveLength(1);
  });
});
