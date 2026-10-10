// @vitest-environment happy-dom
// Story 033, task 4.1 — regressions from the tech review of the DOM summary (2026-10-09).
import { describe, expect, it } from "vitest";
import { summarize } from "../../src/client/summary.js";
import { DOM_SUMMARY_MAX_BYTES, selectionFromPage } from "../../src/contract.js";

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;
const sendable = (dom: unknown) =>
  selectionFromPage.safeParse({
    v: 1,
    page_url: "http://localhost/",
    items: [{ src: { file: "a.tsx", line: 1, column: 1, end_line: 1 }, component: null, dom }],
    screenshot: null,
  }).success;

describe("summary review regressions", () => {
  it("many long aria-* attributes still fit in 4 KiB and stay sendable", () => {
    const div = document.createElement("div");
    for (let i = 0; i < 30; i++) {
      div.setAttribute(`aria-x${String.fromCharCode(97 + (i % 26))}${i}`, "v".repeat(200));
    }
    document.body.replaceChildren(div);
    const s = summarize(div, window);
    expect(bytes(s)).toBeLessThanOrEqual(DOM_SUMMARY_MAX_BYTES);
    expect(sendable(s)).toBe(true);
  });

  it("replaces lone surrogates from the DOM, so the summary stays sendable (task 9.1)", () => {
    const div = document.createElement("div");
    div.id = "a\uD800b";
    div.className = "\uDC00c";
    div.setAttribute("aria-label", "x\uDFFF");
    div.textContent = "hi \uD83D there";
    document.body.replaceChildren(div);
    const s = summarize(div, window);
    expect(
      [s.id!, s.classes[0]!, s.attrs["aria-label"]!, s.text].every((v) => v.isWellFormed()),
    ).toBe(true);
    expect(s.id).toBe("a\uFFFDb");
    expect(s.text).toBe("hi \uFFFD there");
    expect(sendable(s)).toBe(true);
  });

  it("never cuts an id or a class inside a surrogate pair", () => {
    const div = document.createElement("div");
    div.id = `${"a".repeat(127)}😀`;
    div.className = `${"c".repeat(127)}😀`;
    document.body.replaceChildren(div);
    const s = summarize(div, window);
    expect(s.id!.isWellFormed()).toBe(true);
    expect(s.classes[0]!.isWellFormed()).toBe(true);
  });

  it("hostile: picking an ancestor never leaks textarea, select or option text", () => {
    const div = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = "Note";
    const area = document.createElement("textarea");
    area.textContent = "SECRET-TA";
    const select = document.createElement("select");
    for (const text of ["OPT-A", "OPT-B"]) {
      const option = document.createElement("option");
      option.textContent = text;
      select.appendChild(option);
    }
    div.append(label, area, select);
    document.body.replaceChildren(div);
    const text = summarize(div, window).text;
    expect(text).toContain("Note");
    expect(text).not.toMatch(/SECRET|OPT-/);
  });
});
