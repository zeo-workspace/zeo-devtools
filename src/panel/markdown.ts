// Model output → HTML for the panel transcript (story 055, design.md §A3, R6.6). Moved unchanged
// from zeo-browser/src/sidebar/markdown.ts (D6), so the rendering rules 045 audited still hold.
// This is the only module that produces an HTML string: raw HTML in the Markdown is escaped
// (`html: false`), an image becomes a link (an <img> would be fetched, which is an exfiltration
// channel), and a link keeps its href only for http:, https: and mailto:, always opening in a new
// tab with `rel="noopener noreferrer"`.
import MarkdownIt from "markdown-it";

const SAFE_SCHEME = /^(https?:|mailto:)/i;

const isSafeHref = (href: string | number | null): href is string =>
  typeof href === "string" && SAFE_SCHEME.test(href.trim());

const md = new MarkdownIt({ html: false, linkify: false, typographer: false });

// The token type as the renderer hands it over, whichever typings package supplies it.
type Token = Parameters<NonNullable<typeof md.renderer.rules.image>>[0][number];

// Let every link reach the renderer, so an unsafe one is dropped to its text below instead of
// being printed back as literal "[text](javascript:…)" by the parser.
md.validateLink = () => true;

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  const token = tokens[idx] as Token;
  if (!isSafeHref(token.attrGet("href"))) {
    token.meta = { ...token.meta, dropped: true };
    return "";
  }
  token.attrSet("target", "_blank");
  token.attrSet("rel", "noopener noreferrer");
  return self.renderToken(tokens, idx, options);
};

// The nearest link_open before `idx` that no link_close has closed yet, or null.
function openLinkBefore(tokens: Token[], idx: number): Token | null {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i] as Token;
    if (t.type === "link_close") {
      depth++;
    } else if (t.type === "link_open") {
      if (depth === 0) {
        return t;
      }
      depth--;
    }
  }
  return null;
}

md.renderer.rules.link_close = (tokens, idx, options, _env, self) => {
  const open = openLinkBefore(tokens, idx);
  return open?.meta?.dropped ? "" : self.renderToken(tokens, idx, options);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx] as Token;
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  const label = md.utils.escapeHtml(`image: ${alt}`);
  const src = token.attrGet("src");
  // Inside a link that is kept, a second <a> would be split off by the HTML parser and steal the
  // outer link's text (the badge pattern [![CI](img)](target)), so the image is its label only.
  const outer = openLinkBefore(tokens, idx);
  if (!isSafeHref(src) || (outer !== null && !outer.meta?.dropped)) {
    return label;
  }
  const href = md.utils.escapeHtml(src);
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
};

export function renderMarkdown(source: string): string {
  return md.render(source);
}

/**
 * `renderMarkdown`'s output as nodes ready to append, so no other module handles markup. It is
 * parsed by `DOMParser` into a separate, inert document (nothing in it runs or loads), then
 * adopted into `doc`.
 */
export function markdownFragment(source: string, doc: Document = document): DocumentFragment {
  const parsed = new DOMParser().parseFromString(renderMarkdown(source), "text/html");
  const fragment = doc.createDocumentFragment();
  for (const node of [...parsed.body.childNodes]) {
    fragment.append(doc.adoptNode(node));
  }
  return fragment;
}
