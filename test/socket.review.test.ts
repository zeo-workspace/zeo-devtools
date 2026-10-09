// Story 033, task 5.1 — regressions from the tech review of the socket client (2026-10-09).
import { describe, expect, it } from "vitest";
import { resolveSocketPath, sendToZeo } from "../src/socket.js";
import { startFakeZeo } from "./helpers/fake-zeo.js";

const request = {
  v: 1 as const,
  project_root: "/p",
  page_url: "http://localhost/",
  items: [
    {
      src: { file: "/p/a.tsx", line: 1, column: 1, end_line: 1 },
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

describe("socket client review regressions", () => {
  it("refuses an answer line over 64 KiB even when its newline arrives in the same chunk", async () => {
    const zeo = await startFakeZeo();
    try {
      const body = JSON.stringify({ v: 1, ok: true, outcome: "inserted", items: 1, image: "none" });
      zeo.reply = { kind: "raw", text: `${" ".repeat(70_000)}${body}\n` };
      expect(await sendToZeo(zeo.path, request)).toMatchObject({ ok: false, error: "bad_request" });
    } finally {
      await zeo.dispose();
    }
  });

  it("refuses a relative socket path from the option or the environment, accepts an absolute one", () => {
    expect(resolveSocketPath("relative.sock", {})).toMatchObject({ ok: false });
    expect(resolveSocketPath(undefined, { ZEO_DEVTOOLS_SOCKET: "rel/zeo.sock" })).toMatchObject({
      ok: false,
    });
    expect(resolveSocketPath("/run/user/1000/zeo/devtools.sock", {})).toEqual({
      ok: true,
      path: "/run/user/1000/zeo/devtools.sock",
    });
  });
});
