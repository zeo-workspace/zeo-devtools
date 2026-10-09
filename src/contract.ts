// The wire contract between the page, the relay and Zeo's devtools bridge (story 033,
// design.md §Data Models). Zeo's Rust validator is held to the same fixture files under
// test/contract/, so a limit changed here must change there too.
//
// This module is imported by the page client as well as by the relay, so it uses no Node API.
import { z } from "zod";

export const MAX_ITEMS = 20;
export const DOM_SUMMARY_MAX_BYTES = 4096;
export const SCREENSHOT_MAX_EDGE = 1568;
/** Decoded bytes; as base64 it is about 5.4 MiB, inside the bridge's 8 MiB line cap. */
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024;

/** Attribute names a DOM summary may carry: `role`, `aria-*`, `href`, `type`, `name`, `alt`. */
export const ATTR_ALLOWLIST = /^(role|aria-[a-z-]+|href|type|name|alt)$/;

/** The computed styles a DOM summary may carry, in the order the client reads them. */
export const STYLE_KEYS = [
  "display",
  "position",
  "box-sizing",
  "width",
  "height",
  "margin",
  "padding",
  "border",
  "border-radius",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "text-align",
  "gap",
  "flex-direction",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "opacity",
  "z-index",
  "overflow",
] as const;

export const DEVTOOLS_ERRORS = [
  "no_window",
  "no_agent_panel",
  "ai_disabled",
  "bad_request",
  "too_large",
  "outside_project",
  "unsupported_version",
  "unreachable",
  "timeout",
] as const;
export type DevtoolsError = (typeof DEVTOOLS_ERRORS)[number];

const utf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Code points, not UTF-16 units: Zeo counts Rust `char`s, and both sides must agree. */
const maxChars = (max: number) =>
  z.string().refine((s) => [...s].length <= max, { message: `longer than ${max} characters` });

const domSummary = z
  .strictObject({
    tag: z.string().min(1).max(64),
    id: z.string().max(128).nullable(),
    classes: z.array(z.string().max(128)).max(32),
    text: maxChars(500),
    attrs: z.record(z.string().regex(ATTR_ALLOWLIST), z.string().max(200)),
    styles: z.partialRecord(z.enum(STYLE_KEYS), z.string().max(200)),
    rect: z.strictObject({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
  })
  .refine((dom) => utf8Bytes(dom) <= DOM_SUMMARY_MAX_BYTES, {
    message: `DOM summary is larger than ${DOM_SUMMARY_MAX_BYTES} bytes`,
  });
export type DomSummary = z.infer<typeof domSummary>;

const position = { line: z.int().min(1), column: z.int().min(1), end_line: z.int().min(1) };

const relativeFile = z
  .string()
  .min(1)
  .max(4096)
  .refine((f) => !f.startsWith("/"), { message: "a page path must be project-relative" });
const absoluteFile = z
  .string()
  .min(2)
  .max(4096)
  .refine((f) => f.startsWith("/"), { message: "a socket path must be absolute" });

const item = (file: z.ZodType<string>) =>
  z.strictObject({
    src: z.strictObject({ file, ...position }),
    component: z.string().max(128).nullable(),
    dom: domSummary,
  });

const screenshot = z
  .strictObject({
    mime: z.literal("image/png"),
    // 4 MiB decoded is at most 4/3 of that in base64.
    data_b64: z
      .string()
      .min(1)
      .max(Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4),
    w: z.int().min(1).max(SCREENSHOT_MAX_EDGE),
    h: z.int().min(1).max(SCREENSHOT_MAX_EDGE),
  })
  .nullable();

const common = {
  v: z.literal(1),
  page_url: z.string().max(2048),
  screenshot,
};

/** What the page sends over HMR: paths relative to the Vite root, no project root. */
export const selectionFromPage = z.strictObject({
  ...common,
  items: z.array(item(relativeFile)).min(1).max(MAX_ITEMS),
});
export type SelectionFromPage = z.infer<typeof selectionFromPage>;

/** Lexical POSIX normalization (no file system), so `a/../b` and `a/./b` compare as `b`. */
export function normalizePosix(path: string): string {
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return `/${out.join("/")}`;
}

/** Whether `file` lies strictly under `root`, comparing whole path components. */
export function isUnder(file: string, root: string): boolean {
  const r = normalizePosix(root);
  const f = normalizePosix(file);
  return f.startsWith(r === "/" ? "/" : `${r}/`) && f !== r;
}

const OUTSIDE_PROJECT = "outside_project";

/** What the relay writes to Zeo's socket: absolute paths, all under `project_root`. */
export const selectionToZeo = z
  .strictObject({
    ...common,
    project_root: absoluteFile,
    items: z.array(item(absoluteFile)).min(1).max(MAX_ITEMS),
  })
  .superRefine((req, ctx) => {
    req.items.forEach((it, index) => {
      if (!isUnder(it.src.file, req.project_root)) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "src", "file"],
          message: "file is outside the project root",
          params: { devtools: OUTSIDE_PROJECT },
        });
      }
    });
  });
export type SelectionToZeo = z.infer<typeof selectionToZeo>;

export const IMAGE_STATES = ["included", "skipped_unsupported", "none", "pending"] as const;
export type ImageState = (typeof IMAGE_STATES)[number];

export const devtoolsResult = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(1),
    ok: z.literal(true),
    outcome: z.enum(["inserted", "opened_new_thread"]),
    items: z.int().min(0).max(MAX_ITEMS),
    image: z.enum(IMAGE_STATES),
  }),
  z.strictObject({
    v: z.literal(1),
    ok: z.literal(false),
    error: z.enum(DEVTOOLS_ERRORS),
    message: z.string().min(1).max(500),
  }),
]);
export type DevtoolsResult = z.infer<typeof devtoolsResult>;
export type DevtoolsFailure = Extract<DevtoolsResult, { ok: false }>;

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; error: DevtoolsError; message: string };

/**
 * Validates `input` and answers in the contract's own terms instead of throwing. The version
 * is checked first, as Zeo does, so `v: 2` is `unsupported_version` whatever else is wrong.
 */
export function parseSelection<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  if (typeof input === "object" && input !== null && "v" in input && input.v !== 1) {
    return {
      ok: false,
      error: "unsupported_version",
      message: `Unsupported protocol version ${JSON.stringify(input.v)}; this plugin speaks version 1`,
    };
  }
  const result = schema.safeParse(input);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  const outside = result.error.issues.some(
    (issue) =>
      issue.code === "custom" &&
      (issue as { params?: { devtools?: string } }).params?.devtools === OUTSIDE_PROJECT,
  );
  if (outside) {
    return {
      ok: false,
      error: "outside_project",
      message: "A selected file is outside this project",
    };
  }
  const first = result.error.issues[0];
  const where = first ? first.path.join(".") || "request" : "request";
  return {
    ok: false,
    error: "bad_request",
    message: `Invalid selection at ${where}: ${first?.message ?? "malformed"}`,
  };
}
