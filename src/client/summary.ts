// The DOM summary of one picked element (story 033, design.md §Data Models `dom`): what was
// actually rendered, so the agent sees runtime state the source alone cannot show.
import { ATTR_ALLOWLIST, DOM_SUMMARY_MAX_BYTES, STYLE_KEYS, type DomSummary } from "../contract.js";

const TEXT_MAX_CHARS = 500;
/**
 * Subtrees whose text is never read: form controls hold what the user typed or picked
 * (R4.3), and the rest is not visible text.
 */
const SKIPPED = new Set(["input", "textarea", "select", "option", "script", "style", "template"]);

const utf8Bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
const cutChars = (text: string, max: number) => [...text].slice(0, max).join("");

/** The element's text, skipping form-control subtrees even when an ancestor is picked. */
function visibleText(el: Element): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }
    const element = node as Element;
    if (SKIPPED.has(element.tagName.toLowerCase()) || element.hasAttribute("hidden")) {
      return;
    }
    for (const child of Array.from(element.childNodes)) {
      walk(child);
      // Block boundaries become spaces, like innerText's line breaks after the collapse.
      parts.push(" ");
    }
  };
  walk(el);
  return cutChars(parts.join("").replace(/\s+/g, " ").trim(), TEXT_MAX_CHARS);
}

function allowedAttrs(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const { name, value } of Array.from(el.attributes)) {
    // `value` is not on the allowlist, so a form field's typed or initial value never leaves.
    if (ATTR_ALLOWLIST.test(name)) {
      attrs[name] = cutChars(value, 200);
    }
  }
  return attrs;
}

function computedStyles(el: Element, win: Window): DomSummary["styles"] {
  const computed = win.getComputedStyle(el);
  const styles: DomSummary["styles"] = {};
  for (const key of STYLE_KEYS) {
    const value = computed.getPropertyValue(key);
    if (value !== "") {
      styles[key] = cutChars(value, 200);
    }
  }
  return styles;
}

/**
 * Builds the `dom` object of one item, at most `DOM_SUMMARY_MAX_BYTES` UTF-8 bytes once
 * serialized. Over the cap it gives up text first, then classes from the end, then styles,
 * then attributes from the end.
 */
export function summarize(el: Element, win: Window): DomSummary {
  const rect = el.getBoundingClientRect();
  const summary: DomSummary = {
    // Cut by code points: a UTF-16 slice can leave half a surrogate pair, which Zeo refuses.
    tag: cutChars(el.tagName.toLowerCase(), 64),
    id: el.id === "" ? null : cutChars(el.id, 128),
    classes: Array.from(el.classList)
      .slice(0, 32)
      .map((c) => cutChars(c, 128)),
    text: visibleText(el),
    attrs: allowedAttrs(el),
    styles: computedStyles(el, win),
    rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
  };

  if (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && summary.text !== "") {
    // Largest prefix of the text that fits (binary search over code points).
    const chars = [...summary.text];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      summary.text = chars.slice(0, mid).join("");
      if (utf8Bytes(summary) <= DOM_SUMMARY_MAX_BYTES) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    summary.text = chars.slice(0, lo).join("");
  }
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && summary.classes.length > 0) {
    summary.classes.pop();
  }
  const styleKeys = Object.keys(summary.styles) as Array<keyof DomSummary["styles"]>;
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && styleKeys.length > 0) {
    delete summary.styles[styleKeys.pop()!];
  }
  const attrKeys = Object.keys(summary.attrs);
  while (utf8Bytes(summary) > DOM_SUMMARY_MAX_BYTES && attrKeys.length > 0) {
    delete summary.attrs[attrKeys.pop()!];
  }
  return summary;
}
