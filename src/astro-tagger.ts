// The `.astro` tagger (story 052, R1.1–R1.6): in `vite dev`, every intrinsic HTML element of an
// Astro template gets the same `data-zeo-src` / `data-zeo-c` pair the JSX tagger writes, so the
// page picker reads both kinds of module the same way. Astro's compiler does not annotate
// sources itself, so the template is parsed here with the app's own `@astrojs/compiler-rs`,
// which the caller resolves and passes in: the plugin carries no runtime dependency on it.
import { posix } from "node:path";
import MagicString, { type SourceMap } from "magic-string";
import { COMPONENT_ATTR, SRC_ATTR, escapeAttr } from "./tagger.js";

/** The slice of `@astrojs/compiler-rs` this tagger uses. */
export interface AstroCompiler {
  parse(source: string): { ast: unknown; diagnostics: unknown[] };
}

interface AstroNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const isNode = (value: unknown): value is AstroNode =>
  typeof value === "object" && value !== null && typeof (value as AstroNode).type === "string";

/**
 * Never tagged and never walked: an attribute changes how Astro processes them (any attribute
 * makes a script inline), and their content is JavaScript or CSS, not template markup.
 */
const OPAQUE = new Set(["script", "style"]);

/**
 * Tagged, but their children are not walked: the browser shows the content of these elements as
 * text (raw text, escapable raw text, or a fallback parsed as text), while compiler-rs parses it
 * as markup and Astro writes it out verbatim. An attribute inserted inside would become visible
 * text — a textarea's default value, the tab title — so only the opening tag is walked.
 */
const RAW_TEXT = new Set([
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noscript",
  "noembed",
  "noframes",
  "plaintext",
]);

/** Never tagged, but walked: they render no element of their own, their children do. */
const UNRENDERED = new Set(["slot", "Fragment"]);

/** Severities that do not make a parse fail; anything else (or none) is treated as an error. */
const NON_ERROR = new Set(["warning", "information", "hint"]);

const isParseError = (diagnostic: unknown) =>
  !NON_ERROR.has(String((diagnostic as { severity?: unknown } | null)?.severity));

/** The template's top-level nodes, or `undefined` when the module did not parse cleanly. */
function parseTemplate(code: string, compiler: AstroCompiler): unknown[] | undefined {
  try {
    const { ast, diagnostics } = compiler.parse(code);
    if (Array.isArray(diagnostics) && diagnostics.some(isParseError)) {
      return undefined;
    }
    // The binding may hand the tree over as JSON text rather than an object.
    const root: unknown = typeof ast === "string" ? JSON.parse(ast) : ast;
    const body = (root as { body?: unknown } | null)?.body;
    return Array.isArray(body) ? body : undefined;
  } catch {
    // A crashing binding or unreadable JSON: leave the module to Astro, which reports it.
    return undefined;
  }
}

/** `é` is one string index but two UTF-8 bytes, so `<a>` starts at 1 only in string indices. */
const POSITION_PROBE = "é<a></a>";

/**
 * Whether `compiler` reports positions as string indices, the unit `locate()` turns into the
 * line and column the editor shows. `@astrojs/compiler-rs` before 0.4 reports UTF-8 byte
 * offsets, which would put every element after a non-ASCII character at a wrong column. Checked
 * by behaviour, not by version, so a wrapper that reports its own version still passes.
 */
export function astroCompilerUsesStringIndices(compiler: AstroCompiler): boolean {
  // Never throws: the answer is cached per server, so an exception here would fail every
  // `.astro` module of that server instead of rejecting one compiler copy.
  try {
    const element = parseTemplate(POSITION_PROBE, compiler)?.find(
      (node) => isNode(node) && node.type === "JSXElement",
    );
    return isNode(element) && element.start === 1;
  } catch {
    return false;
  }
}

/** 1-based line and column of string index `index`, from the sorted starts of every line. */
function locate(lineStarts: readonly number[], index: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (lineStarts[mid]! <= index) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { line: low + 1, column: index - lineStarts[low]! + 1 };
}

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = code.indexOf("\n"); i !== -1; i = code.indexOf("\n", i + 1)) {
    starts.push(i + 1);
  }
  return starts;
}

function hasAttribute(opening: AstroNode, name: string): boolean {
  const attributes = (opening.attributes as AstroNode[] | undefined) ?? [];
  return attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      (attr.name as AstroNode).type === "JSXIdentifier" &&
      (attr.name as AstroNode).name === name,
  );
}

/** What tagging one `.astro` module came to; the plugin logs only `parse_failed`. */
export type AstroTagOutcome =
  | { outcome: "tagged"; code: string; map: SourceMap }
  | { outcome: "nothing_to_tag" }
  | { outcome: "parse_failed" };

/**
 * Tags one `.astro` module, or returns `undefined` when its template holds nothing to tag or
 * the compiler reports an error (the caller logs that case; nothing is thrown).
 */
export function tagAstroModule(
  code: string,
  id: string,
  root: string,
  exclude: ReadonlySet<string>,
  compiler: AstroCompiler,
): { code: string; map: SourceMap } | undefined {
  const result = tagAstroModuleOutcome(code, id, root, exclude, compiler);
  return result.outcome === "tagged" ? { code: result.code, map: result.map } : undefined;
}

/**
 * {@link tagAstroModule}, telling a parse failure apart from a template with nothing to tag.
 *
 * Positions come from the compiler's `start`/`end`, which are JavaScript string (UTF-16)
 * indices although the binding's typings call them byte offsets: they index `code` directly.
 */
export function tagAstroModuleOutcome(
  code: string,
  id: string,
  root: string,
  exclude: ReadonlySet<string>,
  compiler: AstroCompiler,
): AstroTagOutcome {
  const template = parseTemplate(code, compiler);
  if (template === undefined) {
    return { outcome: "parse_failed" };
  }

  const rel = posix.relative(root, id);
  const component = posix.basename(id, ".astro");
  const lineStarts = lineStartsOf(code);
  const out = new MagicString(code);
  let edits = 0;

  // An explicit stack rather than recursion: a deeply nested template cannot overflow it.
  const pending: unknown[] = [...template];
  while (pending.length > 0) {
    const node = pending.pop();
    if (Array.isArray(node)) {
      pending.push(...(node as unknown[]));
      continue;
    }
    if (!isNode(node)) {
      continue;
    }
    if (node.type === "JSXElement") {
      const opening = node.openingElement as AstroNode;
      const name = opening.name as AstroNode;
      // A member expression (`Foo.Bar`, `ui.button`) is a component, never an HTML element.
      const tag = name.type === "JSXIdentifier" ? (name.name as string) : undefined;
      if (tag !== undefined && OPAQUE.has(tag)) {
        continue;
      }
      const intrinsic =
        tag !== undefined && /^[a-z]/.test(tag) && !UNRENDERED.has(tag) && !exclude.has(tag);
      if (intrinsic && !hasAttribute(opening, SRC_ATTR)) {
        const start = locate(lineStarts, node.start);
        // `end` is exclusive: the element's last character is the one before it.
        const endLine = locate(lineStarts, node.end - 1).line;
        const src = `${rel}:${start.line}:${start.column}-${endLine}`;
        out.appendLeft(
          name.end,
          ` ${SRC_ATTR}="${escapeAttr(src)}" ${COMPONENT_ATTR}="${escapeAttr(component)}"`,
        );
        edits += 1;
      }
      if (tag !== undefined && RAW_TEXT.has(tag)) {
        // The opening tag's attribute expressions are still template code; the content is text.
        pending.push(opening);
        continue;
      }
    }
    for (const value of Object.values(node)) {
      if (typeof value === "object" && value !== null) {
        pending.push(value);
      }
    }
  }

  if (edits === 0) {
    return { outcome: "nothing_to_tag" };
  }
  return {
    outcome: "tagged",
    code: out.toString(),
    map: out.generateMap({ hires: "boundary", source: id, includeContent: true }),
  };
}
