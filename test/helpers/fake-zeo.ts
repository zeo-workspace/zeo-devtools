// A fake Zeo devtools bridge: a real `net.Server` on a temp unix socket that records every
// request line and answers with whatever the test sets. Shared by the socket, relay and
// E2E tests (story 033). Test support only — never imported by `src/`.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Reply =
  | { kind: "json"; value: unknown }
  | { kind: "raw"; text: string }
  | { kind: "silent" }
  | { kind: "close" };

export interface FakeZeo {
  path: string;
  dir: string;
  /** Every complete request line received, parsed as JSON (or the raw text if unparsable). */
  requests: unknown[];
  /** Times (ms since epoch) at which each request line completed. */
  receivedAt: number[];
  /** Server-side sockets that have closed. */
  closed: number;
  reply: Reply;
  stop(): Promise<void>;
  restart(): Promise<void>;
  dispose(): Promise<void>;
}

export const okInserted = (
  items: number,
  image: "included" | "skipped_unsupported" | "none" = "none",
) => ({
  v: 1,
  ok: true,
  outcome: "inserted",
  items,
  image,
});

export async function startFakeZeo(socketPath?: string): Promise<FakeZeo> {
  const dir = await mkdtemp(join(tmpdir(), "zeo-fake-"));
  const path = socketPath ?? join(dir, "devtools.sock");
  let server: Server | undefined;
  const sockets = new Set<Socket>();

  const fake: FakeZeo = {
    path,
    dir,
    requests: [],
    receivedAt: [],
    closed: 0,
    reply: { kind: "json", value: okInserted(1) },
    async stop() {
      for (const s of sockets) {
        s.destroy();
      }
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    },
    async restart() {
      await fake.stop();
      await listen();
    },
    async dispose() {
      await fake.stop();
      await rm(dir, { recursive: true, force: true });
    },
  };

  const listen = () =>
    new Promise<void>((resolve, reject) => {
      const s = createServer((socket) => {
        sockets.add(socket);
        let buffer = "";
        socket.on("close", () => {
          sockets.delete(socket);
          fake.closed += 1;
        });
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          const nl = buffer.indexOf("\n");
          if (nl < 0) {
            return;
          }
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          try {
            fake.requests.push(JSON.parse(line));
          } catch {
            fake.requests.push(line);
          }
          fake.receivedAt.push(Date.now());
          const r = fake.reply;
          if (r.kind === "json") {
            socket.end(JSON.stringify(r.value) + "\n");
          } else if (r.kind === "raw") {
            socket.end(r.text);
          } else if (r.kind === "close") {
            socket.destroy();
          }
          // "silent": hold the connection open and never answer.
        });
      });
      s.once("error", reject);
      s.listen(path, () => {
        server = s;
        resolve();
      });
    });

  await listen();
  return fake;
}
