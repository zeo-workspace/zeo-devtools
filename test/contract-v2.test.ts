// Story 055, task 2.1 — the v2 additions in zod and their shared fixtures (design.md §A5,
// §Data Models "Wire additions"). Requirements: R2.1, R3.5, R3.6, R5.1, R7.1, R7.3, R9.3
// (Q3, Q5, Q14). Validation filter: `npm test -- contract`.
//
// Contract (tasks.md 2.1 Objective): `src/contract-v2.ts` exports zod schemas `helloDevServer`,
// `helloPanel`, `createThread`, `created`, `projectOpen`, `projectClosed`, the v2 `error`
// message (with codes `not_found`, `project_closed`, `agent_start_failed`), `PanelClientMsg`
// and `appToPanel`. Assumed seam — the ONLY place names are resolved is `schema()` below: it
// accepts the camelCase or PascalCase spelling, and for the error message any of `v2Error`,
// `errorMsg`, `serverError`, `error`. Message shapes follow 0058's v2 wire (`v: 2`, `kind`,
// `id`); a `PanelClientMsg` is accepted with or without the `v`/`id` envelope (the panel server
// may add it), so the test pins the kinds and fields, not the envelope.
//
// Hostile halves first:
//   - identity of the two new hellos: a dev_server hello must NOT parse as a panel hello and vice
//     versa (a collapse would let a panel announce a dev server); `kind` typos are refused;
//   - limits count UTF-8 bytes: a root of 4096 bytes made of 2-byte characters passes, 4097 bytes
//     fails, while a 2049-character ASCII-looking URL fails;
//   - URL rule (design.md §Data Models, amended): an `http:` URL on `localhost`, `127.0.0.1` or
//     `[::1]` with an EXPLICIT port and ANY path (Vite's `base`, e.g. `http://localhost:5173/app/`)
//     passes; `localhost.evil.com`, userinfo (`localhost@evil.com`, `u:p@localhost`), `https:`,
//     `0.0.0.0`, a missing port, a query and a fragment are refused — the path is allowed, so the
//     refusals must come from the host/port/userinfo/query/fragment rules, not a "no path" rule;
//   - the 2048-byte URL cap is inclusive: 2048 bytes passes, 2049 fails;
//   - `appToPanel` carries data only: every thread action kind, shaped exactly as the panel
//     would send it, is refused (R3.6), and an `app_location` with an extra field is refused;
//   - `PanelClientMsg` refuses `subscribe { follow: true }` (R5.7), `open_in_zeo` (R7.5) and
//     `hello` (a panel cannot pick its identity), while each of its six kinds is accepted.
// Fixtures: a non-vacuous guard fails on a missing or thin `test/contract/v2/` before any
// verdict is checked.
//
// Refine v2 (2026-10-15) adds, hostile halves first:
//   - GOTCHA G14: the URL rule is Rust's (`devtools_bridge::channel::is_local_http_url`) applied
//     to the RAW string — an empty `?`, an empty `#`, port 0, a tab and a backslash are refused,
//     although WHATWG `new URL(...)` accepts or rewrites every one of them; the converse: an
//     explicit `:80`, which `new URL` drops (port ''), is accepted, and so is an upper-case
//     scheme and host (Rust compares them case-insensitively, so a raw-string check that is
//     case-sensitive would wrongly split them off);
//   - each of those five inputs has its own fixture in `test/contract/v2/client/` — carrying that
//     input alone, so the fixture isolates one rule — with the refused ones expecting
//     `bad_request` as Rust answers them (Task 16.1 compares the two);
//   - `created` carries a required `id` echoing the `create_thread` request (8.1): without it,
//     or with a non-string one, it is refused.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as v2 from "../src/contract-v2.js";

type Schema = z.ZodType;
const mod = v2 as unknown as Record<string, unknown>;
const isSchema = (v: unknown): v is Schema =>
  typeof v === "object" && v !== null && typeof (v as Schema).safeParse === "function";

function schema(...names: string[]): Schema {
  for (const name of names) {
    for (const spelling of [name, name[0]!.toUpperCase() + name.slice(1)]) {
      const found = mod[spelling];
      if (isSchema(found)) {
        return found;
      }
    }
  }
  throw new Error(`src/contract-v2.ts exports no zod schema named ${names.join(" | ")}`);
}

const ok = (s: Schema, value: unknown) => s.safeParse(value).success;

const ROOT = "/home/dev/app";
const APP = "http://localhost:5173";
const PANEL = "http://localhost:5174";
const devHello = (client: Record<string, unknown> = {}) => ({
  v: 2,
  kind: "hello",
  id: "h1",
  client: { kind: "dev_server", root: ROOT, app_url: APP, panel_url: PANEL, ...client },
});
const panelHello = (client: Record<string, unknown> = {}) => ({
  v: 2,
  kind: "hello",
  id: "h1",
  client: { kind: "panel", root: ROOT, ...client },
});
const thread = {
  thread_id: "5f0c2a9e-7b1d-4c3a-9e4f-2d8b6a1c0e7f",
  title: "New thread",
  project: ROOT,
  agent: "Claude Agent",
  status: "idle",
  followed: false,
};

/** 2-byte UTF-8 characters, so `.length` and byte length disagree by half. */
const rootOfBytes = (bytes: number) =>
  "/" + "é".repeat((bytes - 1 - ((bytes - 1) % 2)) / 2) + "x".repeat((bytes - 1) % 2);

describe("hello identities (R2.1, G12 TS half)", () => {
  it("hostile: a dev_server hello is not a panel hello, and a panel hello is not a dev_server one", () => {
    expect(ok(schema("helloPanel"), devHello())).toBe(false);
    expect(ok(schema("helloDevServer"), panelHello())).toBe(false);
  });

  it("hostile: a `kind` typo or a missing client kind is refused by both", () => {
    for (const k of ["dev-server", "devServer", "Dev_server", "panel ", "extension"]) {
      expect(ok(schema("helloDevServer"), devHello({ kind: k })), k).toBe(false);
      expect(ok(schema("helloPanel"), panelHello({ kind: k })), k).toBe(false);
    }
    const noKind: Record<string, unknown> = { ...devHello().client };
    delete noKind.kind;
    expect(ok(schema("helloDevServer"), { ...devHello(), client: noKind })).toBe(false);
  });

  it("hostile: unknown fields are refused (strict objects)", () => {
    expect(ok(schema("helloDevServer"), devHello({ token: "x" }))).toBe(false);
    expect(ok(schema("helloPanel"), panelHello({ app_url: APP }))).toBe(false);
    expect(ok(schema("helloPanel"), { ...panelHello(), extra: 1 })).toBe(false);
  });

  it("hostile: v other than 2 is refused", () => {
    expect(ok(schema("helloDevServer"), { ...devHello(), v: 1 })).toBe(false);
    expect(ok(schema("helloPanel"), { ...panelHello(), v: 3 })).toBe(false);
  });

  it("benign: each hello parses with its own schema", () => {
    expect(ok(schema("helloDevServer"), devHello())).toBe(true);
    expect(ok(schema("helloPanel"), panelHello())).toBe(true);
  });
});

describe("root and URL limits (design.md §Data Models)", () => {
  it("hostile: a relative root is refused", () => {
    expect(ok(schema("helloDevServer"), devHello({ root: "home/dev/app" }))).toBe(false);
    expect(ok(schema("helloPanel"), panelHello({ root: "./app" }))).toBe(false);
  });

  it("hostile: the root cap counts UTF-8 bytes — 4097 bytes fails, 4096 passes", () => {
    const at = rootOfBytes(4096);
    const over = rootOfBytes(4097);
    expect(new TextEncoder().encode(at).length).toBe(4096);
    expect(new TextEncoder().encode(over).length).toBe(4097);
    expect(at.length).toBeLessThan(4096);
    expect(ok(schema("helloPanel"), panelHello({ root: over }))).toBe(false);
    expect(ok(schema("helloPanel"), panelHello({ root: at }))).toBe(true);
  });

  it("hostile: URLs that only look local, or carry userinfo, query or fragment, are refused", () => {
    for (const url of [
      "http://localhost.evil.com:5173",
      "http://localhost@evil.com:5173",
      "http://u:p@localhost:5173/",
      "http://evil.com:5173",
      "https://localhost:5173",
      "http://0.0.0.0:5173",
      "http://127.0.0.1.evil.com:5173",
      "http://localhost/",
      "http://localhost",
      "http://localhost:5173/?token=x",
      "http://localhost:5173/app/#frag",
      "javascript:alert(1)",
      "ws://localhost:5173",
      "localhost:5173",
    ]) {
      expect(ok(schema("helloDevServer"), devHello({ app_url: url })), url).toBe(false);
      expect(ok(schema("helloDevServer"), devHello({ panel_url: url })), url).toBe(false);
    }
  });

  it("hostile: the URL cap is 2048 bytes inclusive", () => {
    const base = "http://localhost:5173/";
    const at = base + "a".repeat(2048 - base.length);
    const over = base + "a".repeat(2049 - base.length);
    expect(new TextEncoder().encode(at).length).toBe(2048);
    expect(ok(schema("helloDevServer"), devHello({ app_url: at }))).toBe(true);
    expect(ok(schema("helloDevServer"), devHello({ app_url: over }))).toBe(false);
  });

  it("benign: the three local hosts with a port pass, with or without a path (Vite base)", () => {
    for (const url of [
      "http://localhost:5173",
      "http://localhost:5173/",
      "http://localhost:5173/app/",
      "http://127.0.0.1:5173/nested/base/",
      "http://[::1]:5173",
      "http://[::1]:5173/app/",
    ]) {
      expect(ok(schema("helloDevServer"), devHello({ app_url: url, panel_url: url })), url).toBe(
        true,
      );
    }
  });
});

describe("new client and server kinds (R5.1, R7.1, R7.3, R9.3)", () => {
  it("create_thread is an empty request", () => {
    expect(ok(schema("createThread"), { v: 2, kind: "create_thread", id: "c1" })).toBe(true);
    expect(
      ok(schema("createThread"), { v: 2, kind: "create_thread", id: "c1", root: "/other" }),
    ).toBe(false);
  });

  it("created carries a ThreadInfo", () => {
    expect(ok(schema("created"), { v: 2, kind: "created", id: "c1", thread })).toBe(true);
    expect(ok(schema("created"), { v: 2, kind: "created", id: "c1", thread: {} })).toBe(false);
  });

  it("project_open and project_closed carry nothing", () => {
    expect(ok(schema("projectOpen"), { v: 2, kind: "project_open" })).toBe(true);
    expect(ok(schema("projectClosed"), { v: 2, kind: "project_closed" })).toBe(true);
    expect(ok(schema("projectClosed"), { v: 2, kind: "project_closed", root: ROOT })).toBe(false);
    // Identity: one is never the other.
    expect(ok(schema("projectOpen"), { v: 2, kind: "project_closed" })).toBe(false);
  });

  it("the error message knows not_found, project_closed and agent_start_failed, non-fatal", () => {
    const error = schema("v2Error", "errorMsg", "serverError", "error");
    for (const code of ["not_found", "project_closed", "agent_start_failed"]) {
      expect(
        ok(error, { v: 2, kind: "error", id: "r1", error: code, message: "m", fatal: false }),
        code,
      ).toBe(true);
    }
    expect(
      ok(error, { v: 2, kind: "error", id: "r1", error: "notfound", message: "m", fatal: false }),
    ).toBe(false);
  });
});

// A PanelClientMsg is accepted when some envelope (bare, or 0058's `v`/`id`) parses; refused only
// when no envelope does.
const envelopes = (msg: Record<string, unknown>) => [msg, { v: 2, id: "r1", ...msg }];
const panelAccepts = (msg: Record<string, unknown>) =>
  envelopes(msg).some((m) => ok(schema("panelClientMsg"), m));

describe("PanelClientMsg (R5.7, R6.3-R6.5, R7.5)", () => {
  it("hostile: subscribe { follow: true } is refused (no follow target in the panel)", () => {
    expect(panelAccepts({ kind: "subscribe", target: { follow: true } })).toBe(false);
    expect(panelAccepts({ kind: "subscribe", thread_id: "t", target: { follow: true } })).toBe(
      false,
    );
  });

  it("hostile: open_in_zeo and hello are refused (no request raises Zeo or picks an identity)", () => {
    expect(panelAccepts({ kind: "open_in_zeo" })).toBe(false);
    expect(panelAccepts({ kind: "hello", client: { kind: "panel", root: ROOT } })).toBe(false);
    expect(
      panelAccepts({
        kind: "hello",
        client: { kind: "dev_server", root: ROOT, app_url: APP, panel_url: PANEL },
      }),
    ).toBe(false);
  });

  it("benign: its six kinds are accepted", () => {
    expect(panelAccepts({ kind: "list_threads" })).toBe(true);
    expect(panelAccepts({ kind: "create_thread" })).toBe(true);
    expect(
      panelAccepts({ kind: "subscribe", target: { thread_id: "t1" } }) ||
        panelAccepts({ kind: "subscribe", thread_id: "t1" }),
    ).toBe(true);
    expect(panelAccepts({ kind: "send", text: "hi", attachments: [] })).toBe(true);
    expect(panelAccepts({ kind: "cancel" })).toBe(true);
    expect(panelAccepts({ kind: "authorize", request_id: "q1", option_id: "o1" })).toBe(true);
  });
});

describe("appToPanel carries data only (R3.5, R3.6)", () => {
  it("hostile: every thread action, as the panel itself would send it, is refused", () => {
    const actions = [
      { kind: "send", text: "rm -rf /", attachments: [] },
      { kind: "cancel" },
      { kind: "authorize", request_id: "q1", option_id: "o1" },
      { kind: "create_thread" },
      { kind: "subscribe", target: { thread_id: "t1" } },
      { kind: "list_threads" },
      { kind: "open_in_zeo" },
    ];
    for (const a of actions) {
      for (const m of envelopes(a)) {
        expect(ok(schema("appToPanel"), m), JSON.stringify(m)).toBe(false);
      }
    }
  });

  it("hostile: an app_location smuggling an action field is refused", () => {
    expect(
      ok(schema("appToPanel"), {
        kind: "app_location",
        href: "http://localhost:5173/",
        title: "t",
        text: "send this",
      }),
    ).toBe(false);
  });

  it("benign: app_location { href, title } is accepted", () => {
    expect(
      ok(schema("appToPanel"), {
        kind: "app_location",
        href: "http://localhost:5173/a",
        title: "A",
      }),
    ).toBe(true);
  });
});

// ---- shared fixtures (TS half of Q14; the Rust half is Task 16.1) -----------------------------

const DIR = fileURLToPath(new URL("./contract/v2/", import.meta.url));

function load(side: "client" | "server", kind: "valid" | "invalid") {
  const dir = `${DIR}${side}/${kind}/`;
  expect(existsSync(dir), `${dir} exists`).toBe(true);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((name) => {
      const raw = JSON.parse(readFileSync(`${dir}${name}`, "utf8")) as Record<string, unknown>;
      const { $expect, ...body } = raw;
      return { name, expected: $expect as string | undefined, body };
    });
}

/** The schema a fixture is judged by, from its kind (and, for hello, its client kind). */
function judge(side: "client" | "server", body: Record<string, unknown>): boolean {
  const k = body.kind;
  if (side === "client") {
    if (k === "hello") {
      return ok(schema("helloDevServer"), body) || ok(schema("helloPanel"), body);
    }
    if (k === "create_thread") {
      return ok(schema("createThread"), body);
    }
    // Client fixtures are WIRE messages (Rust's parse_client reads them, task 16.1): a panel
    // message is judged with or without 0058's `v`/`id` envelope.
    const bare: Record<string, unknown> = { ...body };
    delete bare.v;
    delete bare.id;
    return ok(schema("panelClientMsg"), body) || ok(schema("panelClientMsg"), bare);
  }
  const byKind: Record<string, Schema> = {
    created: schema("created"),
    project_open: schema("projectOpen"),
    project_closed: schema("projectClosed"),
    error: schema("v2Error", "errorMsg", "serverError", "error"),
  };
  const s = typeof k === "string" ? byKind[k] : undefined;
  return s !== undefined && ok(s, body);
}

describe("test/contract/v2 fixtures", () => {
  it("non-vacuous: every new message is covered, both sides, both verdicts", () => {
    const cv = load("client", "valid").map((f) => f.body);
    const ci = load("client", "invalid");
    const sv = load("server", "valid").map((f) => f.body);
    const si = load("server", "invalid");
    const clientKind = (b: Record<string, unknown>) =>
      (b.client as Record<string, unknown> | undefined)?.kind;
    expect(cv.some((b) => b.kind === "hello" && clientKind(b) === "dev_server")).toBe(true);
    expect(cv.some((b) => b.kind === "hello" && clientKind(b) === "panel")).toBe(true);
    expect(cv.some((b) => b.kind === "create_thread")).toBe(true);
    for (const kind of ["created", "project_open", "project_closed"]) {
      expect(
        sv.some((b) => b.kind === kind),
        kind,
      ).toBe(true);
    }
    for (const code of ["not_found", "project_closed", "agent_start_failed"]) {
      expect(
        sv.some((b) => b.kind === "error" && b.error === code),
        code,
      ).toBe(true);
    }
    // The G12 hostile half on the wire: a hello whose client kind is a typo.
    expect(
      ci.some(
        (f) =>
          f.body.kind === "hello" &&
          typeof clientKind(f.body) === "string" &&
          !["dev_server", "panel", "extension"].includes(clientKind(f.body) as string),
      ),
    ).toBe(true);
    // The amended URL rule on the wire, both halves: a Vite base path is valid, a query or a
    // fragment is not.
    const appUrl = (b: Record<string, unknown>) =>
      String((b.client as Record<string, unknown> | undefined)?.app_url ?? "");
    expect(
      cv.some((b) => clientKind(b) === "dev_server" && /^http:\/\/[^/]+\/.+/.test(appUrl(b))),
      "a valid dev_server hello whose app_url carries a base path",
    ).toBe(true);
    expect(
      ci.some((f) => clientKind(f.body) === "dev_server" && /[?#]/.test(appUrl(f.body))),
      "an invalid dev_server hello whose app_url carries a query or fragment",
    ).toBe(true);
    expect(ci.length).toBeGreaterThanOrEqual(4);
    expect(si.length).toBeGreaterThanOrEqual(1);
  });

  it("every invalid fixture names its expected error code in $expect", () => {
    for (const f of [...load("client", "invalid"), ...load("server", "invalid")]) {
      expect(typeof f.expected, f.name).toBe("string");
    }
  });

  it("valid fixtures are accepted and invalid ones refused, on both sides", () => {
    for (const side of ["client", "server"] as const) {
      for (const f of load(side, "valid")) {
        expect(judge(side, f.body), `${side}/valid/${f.name}`).toBe(true);
      }
      for (const f of load(side, "invalid")) {
        expect(judge(side, f.body), `${side}/invalid/${f.name}`).toBe(false);
      }
    }
  });
});

// ---- Refine v2 (2026-10-15): GOTCHA G14 and `created { id }` ----------------------------------

describe("G14: the URL rule is Rust's, on the raw string", () => {
  // Every input here is one WHATWG `URL` parses without complaint (or rewrites), so a zod check
  // built on `new URL(...)` accepts it and then disagrees with Rust in Task 16.1.
  const refused: [string, string][] = [
    ["an empty query", "http://localhost:5173/?"],
    ["an empty query after a base path", "http://localhost:5173/app/?"],
    ["an empty fragment", "http://localhost:5173/#"],
    ["an empty fragment after a base path", "http://localhost:5173/app/#"],
    ["port 0", "http://localhost:0"],
    ["port 0 with a path", "http://127.0.0.1:0/app/"],
    ["a tab in the host", "http://local\thost:5173"],
    ["a tab in the path", "http://localhost:5173/a\tb/"],
    ["a backslash as the path separator", "http://localhost:5173\\app"],
    ["a backslash in the path", "http://localhost:5173/app\\x"],
  ];

  it("hostile: an empty `?` or `#`, port 0, a tab and a backslash are refused", () => {
    for (const [what, url] of refused) {
      // The premise: WHATWG URL takes it, so only a raw-string rule refuses it.
      expect(() => new URL(url), `${what}: new URL parses it`).not.toThrow();
      expect(ok(schema("helloDevServer"), devHello({ app_url: url })), `app_url, ${what}`).toBe(
        false,
      );
      expect(ok(schema("helloDevServer"), devHello({ panel_url: url })), `panel_url, ${what}`).toBe(
        false,
      );
    }
  });

  it("hostile: other bytes a URL parser strips or rewrites are refused too (Rust's rule)", () => {
    for (const url of [
      "http://localhost:5173/a\nb/",
      "http://localhost:5173/a\rb/",
      "http://localhost:5173/a b/",
      " http://localhost:5173",
    ]) {
      expect(ok(schema("helloDevServer"), devHello({ app_url: url })), JSON.stringify(url)).toBe(
        false,
      );
    }
  });

  it("converse: an explicit :80, which new URL drops, is accepted", () => {
    for (const url of ["http://localhost:80", "http://localhost:80/", "http://[::1]:80/app/"]) {
      expect(new URL(url).port, `${url}: WHATWG drops the default port`).toBe("");
      expect(ok(schema("helloDevServer"), devHello({ app_url: url, panel_url: url })), url).toBe(
        true,
      );
    }
  });

  it("converse: the scheme and host compare case-insensitively, as in Rust", () => {
    for (const url of ["HTTP://LOCALHOST:5173/app/", "Http://LocalHost:5173"]) {
      expect(ok(schema("helloDevServer"), devHello({ app_url: url })), url).toBe(true);
    }
  });

  it("the port is digits only, 1 to 65535", () => {
    expect(ok(schema("helloDevServer"), devHello({ app_url: "http://localhost:65535" }))).toBe(
      true,
    );
    for (const url of ["http://localhost:65536", "http://localhost:+5173", "http://localhost:"]) {
      expect(ok(schema("helloDevServer"), devHello({ app_url: url })), url).toBe(false);
    }
  });
});

describe("created { id, thread } (8.1)", () => {
  it("hostile: created without an id, or with a non-string id, is refused", () => {
    expect(ok(schema("created"), { v: 2, kind: "created", thread })).toBe(false);
    expect(ok(schema("created"), { v: 2, kind: "created", id: 7, thread })).toBe(false);
  });

  it("benign: created with the request's id and a ThreadInfo is accepted", () => {
    expect(ok(schema("created"), { v: 2, kind: "created", id: "c1", thread })).toBe(true);
  });
});

describe("test/contract/v2 fixtures carry the G14 inputs (Task 16.1 reads them)", () => {
  const urls = (b: Record<string, unknown>) => {
    const client = b.client as Record<string, unknown> | undefined;
    return [client?.app_url, client?.panel_url].filter((u): u is string => typeof u === "string");
  };
  const isDevServer = (b: Record<string, unknown>) =>
    b.kind === "hello" && (b.client as Record<string, unknown> | undefined)?.kind === "dev_server";
  const g14Refused: [string, (u: string) => boolean][] = [
    ["an empty `?`", (u) => /\?(#|$)/.test(u)],
    ["an empty `#`", (u) => /#$/.test(u)],
    ["port 0", (u) => /^http:\/\/[^/]*:0+(\/|$)/i.test(u)],
    ["a tab", (u) => u.includes("\t")],
    ["a backslash", (u) => u.includes("\\")],
  ];

  it("hostile: one invalid dev_server hello per refused G14 input, each expecting bad_request", () => {
    const invalid = load("client", "invalid").filter((f) => isDevServer(f.body));
    for (const [what, matches] of g14Refused) {
      // Only a fixture carrying THIS input and none of the other four isolates the rule.
      const fixtures = invalid.filter(
        (f) =>
          urls(f.body).some(matches) &&
          g14Refused.filter(([, other]) => urls(f.body).some(other)).length === 1,
      );
      expect(fixtures.length, `an invalid fixture with ${what} alone`).toBeGreaterThanOrEqual(1);
      for (const f of fixtures) {
        expect(f.expected, `${f.name}: Rust answers bad_request`).toBe("bad_request");
      }
    }
  });

  it("converse: a valid dev_server hello whose URL carries an explicit :80", () => {
    const valid = load("client", "valid").map((f) => f.body);
    expect(
      valid.some((b) => isDevServer(b) && urls(b).some((u) => /^http:\/\/[^/]*:80(\/|$)/i.test(u))),
    ).toBe(true);
  });
});
