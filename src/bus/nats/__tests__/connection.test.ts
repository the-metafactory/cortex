/**
 * G-1100.A: NATS connection primitive tests.
 *
 * Uses the `connectImpl` test seam to inject a fake nats.js connection
 * without standing up a real NATS server.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import type { ConnectionOptions, MsgHdrs, NatsConnection } from "nats";
import { Events } from "nats";
import { NatsLink } from "../connection";

// Synthetic .creds file content modelled on `nsc generate creds` output.
// Real value isn't validated by the loader (NATS does that at connect-time);
// the loader only enforces existence + chmod 600 before handing bytes to
// `credsAuthenticator`. Test seam never actually authenticates, so the
// content can be any non-empty UTF-8.
const FAKE_CREDS_CONTENT = `-----BEGIN NATS USER JWT-----
eyJ0eXAiOiJKV1QiLCJhbGciOiJlZDI1NTE5LW5rZXkifQ.eyJqdGkiOiJURVNUIn0.fake
------END NATS USER JWT------

************************* IMPORTANT *************************
NKEY Seed printed below can be used to sign and prove identity.
NKEYs are sensitive and should be treated as secrets.

-----BEGIN USER NKEY SEED-----
SUFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAK
------END USER NKEY SEED------

*************************************************************
`;

function makeFakeConnection() {
  const statusEvents: { type: string; data: unknown }[] = [];
  const publishes: {
    subject: string;
    payload: string | Uint8Array;
    // cortex#2016: the `Nats-Msg-Id` header the caller attached (JetStream
    // dedup key), or undefined when the publish carried no header.
    msgId: string | undefined;
  }[] = [];
  // Promise the test awaits to know an event has been observed by the status
  // loop. Avoids real-time setTimeout sleeps in tests.
  let observed: Promise<void> = Promise.resolve();
  let pushStatus: ((s: { type: string; data: unknown }) => void) | null = null;
  let closeStatus: (() => void) | null = null;

  const statusIterator = (async function* () {
    while (true) {
      const next = await new Promise<{ type: string; data: unknown } | null>((resolve) => {
        pushStatus = resolve;
        closeStatus = () => resolve(null);
      });
      if (next === null) return;
      yield next;
    }
  })();

  const drain = mock(async () => {
    if (closeStatus) closeStatus();
  });

  const publish = mock(
    (
      subject: string,
      payload: string | Uint8Array,
      options?: { headers?: MsgHdrs },
    ) => {
      // `MsgHdrs.get` returns "" for an absent key; normalize to undefined.
      const msgId = options?.headers?.get("Nats-Msg-Id") || undefined;
      publishes.push({ subject, payload, msgId });
    },
  );

  const fakeNc = {
    status: () => statusIterator,
    drain,
    publish,
  } as unknown as NatsConnection;

  return {
    nc: fakeNc,
    publishes,
    publish,
    /**
     * Push a status event AND return a promise that resolves once the
     * NatsLink status loop has had a chance to observe it. Tests await this
     * instead of sleeping, so they're deterministic on loaded CI.
     */
    push: async (status: { type: string; data: unknown }) => {
      observed = new Promise<void>((resolve) => {
        // Schedule resolution AFTER the iterator yields the value the loop
        // will observe — two microtask flushes is enough for the event to
        // hop from `resolve(next)` → loop body → console.* call.
        queueMicrotask(() => queueMicrotask(resolve));
      });
      pushStatus?.(status);
      statusEvents.push(status);
      await observed;
    },
    drain,
    statusEvents,
  };
}

describe("NatsLink", () => {
  let consoleSpy: {
    info: ReturnType<typeof mock>;
    warn: ReturnType<typeof mock>;
    error: ReturnType<typeof mock>;
    debug: ReturnType<typeof mock>;
  };
  let originalConsole: {
    info: typeof console.info;
    warn: typeof console.warn;
    error: typeof console.error;
    debug: typeof console.debug;
  };

  beforeEach(() => {
    originalConsole = {
      info: console.info,
      warn: console.warn,
      error: console.error,
      debug: console.debug,
    };
    consoleSpy = {
      info: mock(() => {}),
      warn: mock(() => {}),
      error: mock(() => {}),
      debug: mock(() => {}),
    };
    console.info = consoleSpy.info;
    console.warn = consoleSpy.warn;
    console.error = consoleSpy.error;
    console.debug = consoleSpy.debug;
  });

  afterEach(() => {
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    console.debug = originalConsole.debug;
  });

  test("requires a url", async () => {
    await expect(NatsLink.connect({ url: "" })).rejects.toThrow(/url is required/);
  });

  test("connects via injected impl and exposes raw + name", async () => {
    const fake = makeFakeConnection();
    const capturedOpts: unknown[] = [];
    const connectImpl = mock(async (opts: unknown) => {
      capturedOpts.push(opts);
      return fake.nc;
    });
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "test-link",
      connectImpl,
    });
    expect(link.name).toBe("test-link");
    expect(link.raw).toBe(fake.nc);
    expect(connectImpl).toHaveBeenCalledTimes(1);
    expect(capturedOpts[0]).toMatchObject({
      servers: ["nats://localhost:4222"],
      name: "test-link",
      reconnect: true,
    });
    await link.close();
  });

  test("defaults name to cortex", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    expect(link.name).toBe("cortex");
    await link.close();
  });

  test("close() drains exactly once (idempotent)", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    await link.close();
    await link.close();
    expect(fake.drain).toHaveBeenCalledTimes(1);
  });

  test("logs disconnect events as warn", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "warn-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Disconnect, data: "nats://localhost:4222" });
    expect(consoleSpy.warn).toHaveBeenCalled();
    const msg = String(consoleSpy.warn.mock.calls[0]?.[0]);
    expect(msg).toContain("warn-test");
    expect(msg).toContain("disconnected");
    await link.close();
  });

  test("logs reconnect events as info", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "info-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Reconnect, data: "nats://localhost:4222" });
    expect(consoleSpy.info).toHaveBeenCalled();
    const msg = String(consoleSpy.info.mock.calls[0]?.[0]);
    expect(msg).toContain("info-test");
    expect(msg).toContain("reconnected");
    await link.close();
  });

  test("logs error events as error", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      name: "err-test",
      connectImpl: async () => fake.nc,
    });
    await fake.push({ type: Events.Error, data: new Error("boom") });
    expect(consoleSpy.error).toHaveBeenCalled();
    const msg = String(consoleSpy.error.mock.calls[0]?.[0]);
    expect(msg).toContain("err-test");
    expect(msg).toContain("error");
    await link.close();
  });

  test("propagates underlying connect errors", async () => {
    const failing = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(
      NatsLink.connect({ url: "nats://nowhere", connectImpl: failing }),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  test("module is import-safe (no side effects on import)", () => {
    // The mere act of importing nats-connection should not connect, log, or
    // throw — verified implicitly by the test runner having loaded the module
    // already without an active NATS server. Make it explicit:
    expect(typeof NatsLink.connect).toBe("function");
  });

  test("publish() forwards subject + string payload to the underlying connection", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    link.publish("local.metafactory.system.adapter.degraded", '{"id":"abc"}');
    expect(fake.publish).toHaveBeenCalledTimes(1);
    expect(fake.publishes[0]).toEqual({
      subject: "local.metafactory.system.adapter.degraded",
      payload: '{"id":"abc"}',
      msgId: undefined,
    });
    await link.close();
  });

  test("publish() forwards Uint8Array payloads unchanged", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    const bytes = new TextEncoder().encode('{"id":"abc"}');
    link.publish("local.metafactory.test", bytes);
    expect(fake.publishes[0]?.subject).toBe("local.metafactory.test");
    expect(fake.publishes[0]?.payload).toBe(bytes);
    await link.close();
  });

  test("publish() with a msgId attaches it as the Nats-Msg-Id header (RFC-0007 §6.3, cortex#2016)", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    const id = "11111111-1111-4111-8111-111111111111";
    link.publish("local.metafactory.default.tasks.code-review.typescript", "{}", id);
    // JetStream deduplicates stored messages by this header within the
    // stream's duplicate_window — the id is the dedup key.
    expect(fake.publishes[0]?.msgId).toBe(id);
    await link.close();
  });

  test("publish() without a msgId sends NO header (byte-identical to pre-#2016)", async () => {
    const fake = makeFakeConnection();
    const link = await NatsLink.connect({
      url: "nats://localhost:4222",
      connectImpl: async () => fake.nc,
    });
    link.publish("local.metafactory.system.adapter.degraded", "{}");
    // An empty string is treated as "no id" too — no header rides the publish.
    link.publish("local.metafactory.system.adapter.degraded", "{}", "");
    expect(fake.publishes[0]?.msgId).toBeUndefined();
    expect(fake.publishes[1]?.msgId).toBeUndefined();
    await link.close();
  });

  // ─────────────────────────────────────────────────────────────────────
  // cortex#86: credsPath / credsAuthenticator wiring for operator-mode NATS.
  //
  // These tests exercise the loader + connectImpl handoff using a synthetic
  // .creds file on disk. They DO NOT validate the JWT/seed content (NATS
  // does that at the server) — they verify that:
  //   - `credsPath` set → connectImpl receives `authenticator` (not token)
  //   - chmod gate refuses anything looser than 600
  //   - principal-readable error on missing file
  //   - `token` + `credsPath` together: credsPath wins, warn logged
  //   - leading `~/` expands to $HOME (production cortex.yaml uses this)
  // ─────────────────────────────────────────────────────────────────────
  describe("creds-auth (cortex#86)", () => {
    let tmpDir: string;
    let credsFile: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "natslink-creds-"));
      credsFile = join(tmpDir, "test.creds");
      writeFileSync(credsFile, FAKE_CREDS_CONTENT, "utf8");
      chmodSync(credsFile, 0o600);
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("credsPath set → connectImpl receives authenticator, not token", async () => {
      const fake = makeFakeConnection();
      const capturedOpts: ConnectionOptions[] = [];
      const connectImpl = mock(async (opts: ConnectionOptions) => {
        capturedOpts.push(opts);
        return fake.nc;
      });
      const link = await NatsLink.connect({
        url: "nats://localhost:4222",
        credsPath: credsFile,
        connectImpl,
      });
      const opts = capturedOpts[0]!;
      expect(typeof opts.authenticator).toBe("function");
      expect(opts.token).toBeUndefined();
      await link.close();
    });

    test("credsPath rejects chmod 644 with principal-readable error", async () => {
      // POSIX-only: NTFS chmod is meaningless and the loader skips the gate.
      if (process.platform === "win32") return;
      chmodSync(credsFile, 0o644);
      await expect(
        NatsLink.connect({
          url: "nats://localhost:4222",
          credsPath: credsFile,
          connectImpl: async () => makeFakeConnection().nc,
        }),
      ).rejects.toThrow(/chmod 600.*644/);
    });

    test("credsPath ENOENT bubbles up a clear error including the path", async () => {
      const missing = join(tmpDir, "does-not-exist.creds");
      await expect(
        NatsLink.connect({
          url: "nats://localhost:4222",
          credsPath: missing,
          connectImpl: async () => makeFakeConnection().nc,
        }),
      ).rejects.toThrow(/does-not-exist\.creds|ENOENT/);
    });

    test("credsPath + token → credsPath wins, warn logged about precedence", async () => {
      const fake = makeFakeConnection();
      const capturedOpts: ConnectionOptions[] = [];
      const connectImpl = mock(async (opts: ConnectionOptions) => {
        capturedOpts.push(opts);
        return fake.nc;
      });
      const link = await NatsLink.connect({
        url: "nats://localhost:4222",
        name: "creds-vs-token",
        token: "ignored-token-value",
        credsPath: credsFile,
        connectImpl,
      });
      expect(consoleSpy.warn).toHaveBeenCalled();
      const warnMsg = String(consoleSpy.warn.mock.calls[0]?.[0] ?? "");
      expect(warnMsg).toMatch(/credsPath|precedence|token/i);
      const opts = capturedOpts[0]!;
      expect(typeof opts.authenticator).toBe("function");
      expect(opts.token).toBeUndefined();
      await link.close();
    });

    // (skip — bounded-statusLoop tests below)
    test.skip("__bounded-statusLoop-tests-placeholder__", async () => {});
  });

  describe("bounded statusLoop (cortex#317)", () => {
    // Builds a fake where drain() succeeds but the status iterator NEVER
    // closes — simulates the pilot#129 root cause where nats.js
    // `for await (... status())` doesn't end promptly under
    // `reconnect: true`. Pre-fix `close()` would await statusLoop forever;
    // post-fix it bounds with statusTimeoutMs and emits a stderr warning.
    function makeHungStatusConnection() {
      const statusIterator = (async function* () {
        // Hang on a promise that never resolves — mimics the unresponsive
        // status iterator from pilot#129's diagnostic trace.
        await new Promise<never>(() => {});
        yield { type: "x", data: null };
      })();
      const drain = mock(async () => {
        // Drain itself succeeds — only statusLoop is hung.
      });
      const publish = mock(() => {});
      const fakeNc = {
        status: () => statusIterator,
        drain,
        publish,
      } as unknown as NatsConnection;
      return { nc: fakeNc, drain };
    }

    test("close() resolves within statusTimeoutMs when status loop hangs", async () => {
      const fake = makeHungStatusConnection();
      const link = await NatsLink.connect({
        url: "nats://localhost:4222",
        connectImpl: async () => fake.nc,
      });
      const stderrWrites: string[] = [];
      const originalStderrWrite = process.stderr.write;
      process.stderr.write = (chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
      };
      try {
        const start = Date.now();
        await link.close(/* drainTimeoutMs */ 100, /* statusTimeoutMs */ 100);
        const elapsed = Date.now() - start;
        // Drain returns immediately (mock resolves sync); status loop is
        // bounded at 100ms. Total budget: ~100ms + slack. Pre-fix this
        // would hang forever — we assert <500ms to leave generous CI slack.
        expect(elapsed).toBeLessThan(500);
      } finally {
        process.stderr.write = originalStderrWrite;
      }
      // Warning emitted on stderr with principal-actionable text.
      const warning = stderrWrites.find((w) =>
        w.includes("status loop exceeded"),
      );
      expect(warning).toBeDefined();
      expect(warning).toContain("WARNING");
      expect(warning).toContain("continuing in background");
    });

    test("close() is fast (no warning) when status loop drains promptly", async () => {
      // Healthy case: makeFakeConnection's drain calls closeStatus(), which
      // makes the iterator return null → statusLoop completes immediately.
      // This is the 99% path — we verify the new bounded-race doesn't add
      // a perceptible delay or spurious warning.
      const fake = makeFakeConnection();
      const link = await NatsLink.connect({
        url: "nats://localhost:4222",
        connectImpl: async () => fake.nc,
      });
      const stderrWrites: string[] = [];
      const originalStderrWrite = process.stderr.write;
      process.stderr.write = (chunk: unknown) => {
        stderrWrites.push(String(chunk));
        return true;
      };
      try {
        const start = Date.now();
        await link.close();
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(100);
      } finally {
        process.stderr.write = originalStderrWrite;
      }
      // Zero stderr warnings on the healthy path.
      const warnings = stderrWrites.filter((w) =>
        w.includes("status loop exceeded"),
      );
      expect(warnings).toEqual([]);
    });
  });

  describe("creds-auth tilde (re-opened, was nested in creds-auth block above)", () => {
    let tmpDir: string;
    let credsFile: string;
    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), "natslink-creds-bound-"));
      credsFile = join(tmpDir, "user.creds");
      writeFileSync(credsFile, FAKE_CREDS_CONTENT, "utf8");
      chmodSync(credsFile, 0o600);
    });
    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    test("leading ~ in credsPath expands to homedir", async () => {
      // Place a creds file directly under $HOME so the ~-relative path
      // resolves to a real existing file. Cleanup at teardown.
      const homeCredsFile = join(homedir(), `.natslink-creds-test-${process.pid}.creds`);
      writeFileSync(homeCredsFile, FAKE_CREDS_CONTENT, "utf8");
      chmodSync(homeCredsFile, 0o600);
      try {
        const tildePath = `~/${homeCredsFile.slice(homedir().length + 1)}`;
        const fake = makeFakeConnection();
        const capturedOpts: ConnectionOptions[] = [];
        const link = await NatsLink.connect({
          url: "nats://localhost:4222",
          credsPath: tildePath,
          connectImpl: async (opts) => {
            capturedOpts.push(opts);
            return fake.nc;
          },
        });
        expect(typeof capturedOpts[0]?.authenticator).toBe("function");
        await link.close();
      } finally {
        rmSync(homeCredsFile, { force: true });
      }
    });
  });
});
