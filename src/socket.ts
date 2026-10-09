// The relay's client for Zeo's devtools bridge (story 033, design.md §A3): one NDJSON request
// and one NDJSON answer per connection over a per-user unix socket. It never rejects: every
// failure comes back as a `DevtoolsResult` the page can show.
import { Buffer } from "node:buffer";
import { createConnection } from "node:net";
import { isAbsolute, join } from "node:path";
import { devtoolsResult, type DevtoolsResult, type SelectionToZeo } from "./contract.js";

/** Linux `sun_path` holds 108 bytes including the terminating NUL. */
export const SUN_PATH_MAX_BYTES = 107;
const RESPONSE_MAX_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;

export const UNREACHABLE = "Zeo is not running, or its devtools bridge is off";
export const TIMEOUT = "Zeo did not answer within 10 seconds";
const UNREADABLE = "Zeo sent an answer this plugin cannot read";

const failure = (error: "unreachable" | "timeout" | "bad_request", message: string) =>
  ({ v: 1, ok: false, error, message }) as const satisfies DevtoolsResult;

/**
 * Where Zeo listens: the explicit option, else `$ZEO_DEVTOOLS_SOCKET`, else
 * `$XDG_RUNTIME_DIR/zeo/devtools.sock`. A missing or relative runtime dir is an error naming
 * it, never a guess.
 */
export function resolveSocketPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; path: string } | { ok: false; message: string } {
  const chosen = explicit ?? env.ZEO_DEVTOOLS_SOCKET;
  if (chosen !== undefined && chosen !== "") {
    return isAbsolute(chosen)
      ? { ok: true, path: chosen }
      : { ok: false, message: `Zeo's socket path must be absolute: ${chosen}` };
  }
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime === undefined || runtime === "") {
    return { ok: false, message: "XDG_RUNTIME_DIR is not set, so Zeo's socket cannot be found" };
  }
  if (!isAbsolute(runtime)) {
    return {
      ok: false,
      message: `XDG_RUNTIME_DIR is relative (${runtime}), so Zeo's socket cannot be found`,
    };
  }
  return { ok: true, path: join(runtime, "zeo", "devtools.sock") };
}

export function sendToZeo(
  socketPath: string,
  req: SelectionToZeo,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<DevtoolsResult> {
  if (Buffer.byteLength(socketPath) > SUN_PATH_MAX_BYTES) {
    return Promise.resolve(
      failure(
        "bad_request",
        `Zeo's socket path is longer than ${SUN_PATH_MAX_BYTES} bytes: ${socketPath}`,
      ),
    );
  }
  return new Promise((resolve) => {
    let settled = false;
    let received = Buffer.alloc(0);
    const socket = createConnection({ path: socketPath });
    const finish = (result: DevtoolsResult) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(failure("timeout", TIMEOUT)), timeoutMs);

    socket.on("connect", () => socket.write(`${JSON.stringify(req)}\n`));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(0x0a);
      if (newline === -1 ? received.length > RESPONSE_MAX_BYTES : newline > RESPONSE_MAX_BYTES) {
        finish(failure("bad_request", UNREADABLE));
        return;
      }
      if (newline === -1) {
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(received.subarray(0, newline).toString("utf8"));
      } catch {
        finish(failure("bad_request", UNREADABLE));
        return;
      }
      const answer = devtoolsResult.safeParse(parsed);
      finish(answer.success ? answer.data : failure("bad_request", UNREADABLE));
    });
    // ENOENT, ECONNREFUSED, a reset: Zeo is not there to answer.
    socket.on("error", () => finish(failure("unreachable", UNREACHABLE)));
    socket.on("close", () => finish(failure("unreachable", UNREACHABLE)));
  });
}
