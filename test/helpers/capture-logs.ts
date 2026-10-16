// Story 055 — captures every line the process writes through `console.*` or straight to
// stdout/stderr, whatever logger the code under test chose (Vite's logger, console, a stream).
// Test support only.
import { vi } from "vitest";

export interface Captured {
  lines: string[];
  /** Lines starting with `zeo-devtools event=` (after any prefix such as Vite's timestamp). */
  events(): string[];
  text(): string;
  restore(): void;
}

const stringify = (args: unknown[]) =>
  args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

export function captureLogs(): Captured {
  const lines: string[] = [];
  const push = (s: string) => {
    for (const l of s.split("\n")) {
      if (l.trim() !== "") {
        lines.push(l);
      }
    }
  };
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => push(stringify(args))),
  );
  const out = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  });
  return {
    lines,
    events: () => lines.filter((l) => /zeo-devtools event=\S+/.test(l)),
    text: () => lines.join("\n"),
    restore() {
      for (const s of spies) {
        s.mockRestore();
      }
      out.mockRestore();
      err.mockRestore();
    },
  };
}

/** Parses the `key=value` pairs of one log line (values may be double-quoted). */
export function keyValues(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z_]+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  for (const m of line.matchAll(re)) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? (JSON.parse(raw) as string) : raw;
  }
  return out;
}
