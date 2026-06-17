/**
 * Socket-auth probes for the production Bun Unix-socket transport
 * (`makeBunUnixTransport`) — finding 1, sage cortex#1035.
 *
 * The transport binds a real Unix socket and requires the FIRST line from the
 * connector to prove a per-spawn token before it resolves `connection` and
 * before any effect is routed. These probes drive a REAL socket: the transport
 * spawns a long-lived no-op process (so it does not reject on early exit) and
 * the TEST plays the brain by connecting to the socket directly via
 * `Bun.connect({ unix })`.
 *
 *   - wrong-token connector is rejected (connection never resolves)
 *   - no effect is accepted pre-auth (no data reaches the host's onData pump)
 *   - the correct token proceeds (connection resolves, post-auth bytes flow)
 *   - a second connector while one is live is rejected
 */

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { makeBunUnixTransport, SOCKET_AUTH_TIMEOUT_MS } from "../daemon-brain-host";
import type { DaemonBrainProcess } from "../daemon-brain-host";

/** A long-lived no-op argv so the transport does not reject on early exit. */
const SLEEP_ARGV = ["sleep", "30"];

let spawned: DaemonBrainProcess[] = [];

function startTransport(token: string): { proc: DaemonBrainProcess; socketPath: string } {
  const socketPath = join(
    tmpdir(),
    `cortex-brain-auth-test-${process.pid}-${crypto.randomUUID().slice(0, 8)}.sock`,
  );
  const proc = makeBunUnixTransport({
    argv: SLEEP_ARGV,
    env: {},
    cwd: tmpdir(),
    socketPath,
    socketToken: token,
  });
  spawned.push(proc);
  return { proc, socketPath };
}

/** Connect to the unix socket as a raw brain. */
async function connectRaw(socketPath: string): Promise<{
  write: (s: string) => void;
  received: () => string;
  close: () => void;
}> {
  let buf = "";
  const sock = await Bun.connect({
    unix: socketPath,
    socket: {
      data(_s, data: Uint8Array) {
        buf += new TextDecoder().decode(data);
      },
      error() {},
      close() {},
    },
  });
  return {
    write: (s: string) => void sock.write(s),
    received: () => buf,
    close: () => sock.end(),
  };
}

/** Wait until `cond()` or throw after `timeoutMs`. */
async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Race a promise against a timeout, resolving to a discriminated outcome. */
async function settleWithin<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ state: "resolved"; value: T } | { state: "rejected" } | { state: "pending" }> {
  return Promise.race([
    p.then(
      (value) => ({ state: "resolved" as const, value }),
      () => ({ state: "rejected" as const }),
    ),
    new Promise<{ state: "pending" }>((r) =>
      setTimeout(() => r({ state: "pending" }), ms),
    ),
  ]);
}

afterEach(() => {
  for (const p of spawned) {
    try {
      p.kill("SIGKILL");
    } catch {
      // already gone
    }
  }
  spawned = [];
});

describe("makeBunUnixTransport — socket auth (finding 1)", () => {
  test("the correct token proceeds: connection resolves and post-auth bytes reach onData", async () => {
    const token = crypto.randomUUID();
    const { proc, socketPath } = startTransport(token);
    const brain = await connectRaw(socketPath);

    // Send the auth proof, then a protocol line.
    brain.write(JSON.stringify({ v: 1, type: "auth", token }) + "\n");

    const conn = await proc.connection; // resolves only on a valid auth proof
    const seen: string[] = [];
    conn.onData((chunk) => {
      seen.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    });

    // A post-auth protocol line must flow to the host's pump.
    brain.write(JSON.stringify({ v: 1, type: "log", level: "info", text: "hi" }) + "\n");
    await until(() => seen.join("").includes("hi"));
    expect(seen.join("")).toContain("hi");
    brain.close();
  });

  test("a wrong-token connector is rejected: connection never resolves and no effect is accepted", async () => {
    const { proc, socketPath } = startTransport(crypto.randomUUID());
    const brain = await connectRaw(socketPath);

    let onDataFired = false;
    // Wire onData BEFORE auth would resolve — it must never fire pre-auth. Also
    // attach a rejection handler so the expected auth-failure rejection is not
    // reported as unhandled.
    void proc.connection.then(
      (conn) => {
        conn.onData(() => {
          onDataFired = true;
        });
      },
      () => {
        // Expected: auth failed → connection rejected. Swallowed here; the
        // assertion below verifies the rejection via settleWithin.
      },
    );

    // Wrong token, then an effect the host must NOT route.
    brain.write(JSON.stringify({ v: 1, type: "auth", token: "WRONG" }) + "\n");
    brain.write(JSON.stringify({ v: 1, type: "post", task_id: "t", text: "x" }) + "\n");

    const outcome = await settleWithin(proc.connection, 500);
    expect(outcome.state).toBe("rejected");
    expect(onDataFired).toBe(false);
    brain.close();
  });

  test("no auth line within the timeout rejects the connection", async () => {
    const { proc, socketPath } = startTransport(crypto.randomUUID());
    const brain = await connectRaw(socketPath);
    // Send nothing. The transport's auth deadline must reject.
    const outcome = await settleWithin(proc.connection, SOCKET_AUTH_TIMEOUT_MS + 1000);
    expect(outcome.state).toBe("rejected");
    brain.close();
  });

  test("a second connector while one is live is rejected", async () => {
    const token = crypto.randomUUID();
    const { proc, socketPath } = startTransport(token);

    // First connector authenticates and owns the connection.
    const first = await connectRaw(socketPath);
    first.write(JSON.stringify({ v: 1, type: "auth", token }) + "\n");
    await proc.connection;

    // A second connector — even with the correct token — must be closed; it
    // cannot race in as the brain. Its socket closes without ever taking over.
    let secondClosed = false;
    const second = await Bun.connect({
      unix: socketPath,
      socket: {
        data() {},
        error() {},
        close() {
          secondClosed = true;
        },
      },
    });
    second.write(JSON.stringify({ v: 1, type: "auth", token }) + "\n");
    await until(() => secondClosed, 2000);
    expect(secondClosed).toBe(true);

    first.close();
  });
});

// sage cortex#1035 round 2 — bytes in the SAME chunk as the auth line must
// reach the protocol layer once onData registers (no silent drop).
describe("round-2: post-auth bytes in the auth chunk", () => {
  test("protocol bytes appended to the auth line are delivered, not dropped", async () => {
    const token = crypto.randomUUID();
    const { proc, socketPath } = startTransport(token);
    const brain = await connectRaw(socketPath);
    // Auth line + a protocol line in ONE write (one socket chunk).
    brain.write(
      `{"v":1,"type":"auth","token":"${token}"}\n` +
        `{"v":1,"type":"log","level":"info","text":"same-chunk"}\n`,
    );
    const conn = await proc.connection;
    const received: string[] = [];
    conn.onData((chunk) =>
      received.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
    );
    await until(() => received.join("").includes("same-chunk"));
    brain.close();
  });
});
