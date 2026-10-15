// The source tagger (story 033, design.md §A1): in `vite dev`, every intrinsic JSX element of
// the project's own modules gets `data-zeo-src="<rel>:<line>:<col>-<endLine>"` and, inside a
// component, `data-zeo-c="<Component>"`. The page picker reads them back; React 19 no longer
// exposes `_debugSource`, so an attribute written at transform time is the only carrier.
import { parse } from "@babel/parser";
import MagicString, { type SourceMap } from "magic-string";

/** react-three-fiber intrinsics: lowercase, yet they reject unknown props. */
export const DEFAULT_EXCLUDE: readonly string[] = [
  "mesh",
  "group",
  "primitive",
  "ambientLight",
  "pointLight",
  "directionalLight",
  "boxGeometry",
  "meshStandardMaterial",
  "perspectiveCamera",
];

export const SRC_ATTR = "data-zeo-src";
export const COMPONENT_ATTR = "data-zeo-c";

interface Position {
  line: number;
  column: number;
}
interface BabelNode {
  type: string;
  start: number;
  end: number;
  loc: { start: Position; end: Position };
  [key: string]: unknown;
}

const isNode = (value: unknown): value is BabelNode =>
  typeof value === "object" && value !== null && typeof (value as BabelNode).type === "string";

export const escapeAttr = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

const isComponentName = (name: unknown): name is string =>
  typeof name === "string" && /^[A-Z]/.test(name);

const isFunctionNode = (node: BabelNode | null | undefined) =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

/** `memo(…)`, `forwardRef(…)`, `React.memo(…)`: the wrappers a component is commonly declared in. */
function isComponentWrapper(node: BabelNode | null | undefined): boolean {
  if (node?.type !== "CallExpression") {
    return false;
  }
  const callee = node.callee as BabelNode;
  const name =
    callee.type === "Identifier"
      ? callee.name
      : callee.type === "MemberExpression"
        ? (callee.property as BabelNode).name
        : undefined;
  const [first] = (node.arguments as BabelNode[] | undefined) ?? [];
  return (name === "memo" || name === "forwardRef") && isFunctionNode(first);
}

/**
 * The component a node declares, if it declares one: `function Card`, `class Card`,
 * `const Card = () => …`, or `const Card = memo(() => …)`.
 */
function declaredComponent(node: BabelNode): string | undefined {
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ClassDeclaration" ||
    node.type === "ClassExpression"
  ) {
    const id = node.id as BabelNode | null | undefined;
    if (id && isComponentName(id.name)) {
      return id.name;
    }
  }
  if (node.type === "VariableDeclarator") {
    const id = node.id as BabelNode | undefined;
    const init = node.init as BabelNode | null | undefined;
    const declaresComponent = isFunctionNode(init) || isComponentWrapper(init);
    if (declaresComponent && id?.type === "Identifier" && isComponentName(id.name)) {
      return id.name;
    }
  }
  return undefined;
}

function hasAttribute(opening: BabelNode, name: string): boolean {
  const attributes = (opening.attributes as BabelNode[] | undefined) ?? [];
  return attributes.some(
    (attr) =>
      attr.type === "JSXAttribute" &&
      (attr.name as BabelNode).type === "JSXIdentifier" &&
      (attr.name as BabelNode).name === name,
  );
}

/**
 * Tags one module, or returns `null` when it is not the project's own JSX, holds nothing to
 * tag, or does not parse — a syntax error is left for the real compiler to report.
 */
export function tagModule(
  code: string,
  id: string,
  root: string,
  exclude: ReadonlySet<string>,
): { code: string; map: SourceMap } | null {
  const rootPrefix = root.endsWith("/") ? root : `${root}/`;
  const isTsx = id.endsWith(".tsx");
  if (
    !id.startsWith(rootPrefix) ||
    id.includes("/node_modules/") ||
    !(isTsx || id.endsWith(".jsx")) ||
    !code.includes("<")
  ) {
    return null;
  }

  let program: BabelNode;
  try {
    program = parse(code, {
      sourceType: "module",
      plugins: isTsx ? ["jsx", "typescript"] : ["jsx"],
      errorRecovery: false,
    }) as unknown as BabelNode;
  } catch {
    return null;
  }

  const rel = id.slice(rootPrefix.length);
  const out = new MagicString(code);
  let edits = 0;

  const visit = (node: BabelNode, component: string | undefined) => {
    const own = declaredComponent(node) ?? component;
    if (node.type === "JSXElement") {
      const opening = node.openingElement as BabelNode;
      const name = opening.name as BabelNode;
      const tag = name.type === "JSXIdentifier" ? (name.name as string) : undefined;
      const intrinsic = tag !== undefined && /^[a-z]/.test(tag) && !exclude.has(tag);
      if (intrinsic && !hasAttribute(opening, SRC_ATTR)) {
        const { line, column } = node.loc.start;
        // Babel columns are 0-based; the wire and every editor count from 1.
        let attrs = ` ${SRC_ATTR}="${escapeAttr(`${rel}:${line}:${column + 1}-${node.loc.end.line}`)}"`;
        if (own !== undefined) {
          attrs += ` ${COMPONENT_ATTR}="${escapeAttr(own)}"`;
        }
        // After the type arguments of a TSX element (`<div<T> …>`), or the output stops parsing.
        const typeArgs = (opening.typeArguments ?? opening.typeParameters) as BabelNode | undefined;
        out.appendLeft(typeArgs?.end ?? name.end, attrs);
        edits += 1;
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "loc" || key === "leadingComments" || key === "trailingComments") {
        continue;
      }
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) {
          if (isNode(child)) {
            visit(child, own);
          }
        }
      } else if (isNode(value)) {
        visit(value, own);
      }
    }
  };
  try {
    visit(program, undefined);
  } catch {
    // A walk that cannot finish (stack depth) leaves the module to the compiler untouched.
    return null;
  }

  if (edits === 0) {
    return null;
  }
  return {
    code: out.toString(),
    map: out.generateMap({ hires: true, source: id, includeContent: true }),
  };
}
