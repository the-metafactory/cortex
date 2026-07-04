/**
 * cortex#1498 (epic #1479 follow-up) — `cortex network authorize` CLI dispatch
 * tests.
 *
 * Drives `dispatchNetwork` end-to-end with an injected authorize-ports factory
 * + a real chmod-600 hub-admin seed file. Asserts: grammar validation, dry-run
 * default (no mutation), --apply wiring, --json shape.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createUser } from "nkeys.js";
import { dispatchNetwork, type AuthorizePortsFactory } from "../network";
import type { NetworkAuthorizePorts } from "../network-authorize-ports";

let tmp: string;
let seedPath: string;
// A valid 44-char base64 Ed25519 pubkey (32 bytes → 44 b64 chars, one '=' pad).
const MEMBER = btoa("A".repeat(32));

interface Calls {
  posted: string[];
}

function fakeFactory(opts: { admitted?: { request_id: string; principal_id: string } } = {}): {
  factory: AuthorizePortsFactory;
  calls: Calls;
} {
  const calls: Calls = { posted: [] };
  const ports: NetworkAuthorizePorts = {
    admission: { findAdmittedRow: async () => opts.admitted },
    delivery: {
      postAuthorize: async (requestId: string) => {
        calls.posted.push(requestId);
      },
    },
  };
  return { factory: () => ports, calls };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "authorize-cli-"));
  seedPath = join(tmp, "hub-admin.seed");
  const seed = new TextDecoder().decode(createUser().getSeed());
  writeFileSync(seedPath, seed, { mode: 0o600 });
  chmodSync(seedPath, 0o600);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function argv(...args: string[]): string[] {
  return args;
}

/** dispatchNetwork(argv, load, ping, provision, secret, makeLive, keyRotation, doctor, handoff, authorize). */
function runAuthorizeCli(args: string[], factory: AuthorizePortsFactory) {
  return dispatchNetwork(
    args,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    factory,
  );
}

describe("cortex network authorize — grammar", () => {
  test("missing --network → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(argv("authorize", MEMBER, "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--network");
  });

  test("bad --network grammar → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(argv("authorize", MEMBER, "--network", "BAD_CAPS", "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("lowercase");
  });

  test("missing member pubkey → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(argv("authorize", "--network", "metafactory", "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(2);
  });

  test("malformed member pubkey → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(argv("authorize", "not-a-pubkey", "--network", "metafactory", "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(2);
  });

  test("missing --admin-seed → usage error (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(argv("authorize", MEMBER, "--network", "metafactory"), factory);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("--admin-seed");
  });

  test("--apply and --dry-run are mutually exclusive (exit 2)", async () => {
    const { factory } = fakeFactory();
    const res = await runAuthorizeCli(
      argv("authorize", MEMBER, "--network", "metafactory", "--admin-seed", seedPath, "--apply", "--dry-run"),
      factory,
    );
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toContain("mutually exclusive");
  });
});

describe("cortex network authorize — dry-run default", () => {
  test("dry-run (default) resolves the row but posts NOTHING", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req-1", principal_id: "alice" } });
    const res = await runAuthorizeCli(argv("authorize", MEMBER, "--network", "metafactory", "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("dry-run");
    expect(calls.posted).toEqual([]);
  });

  test("no ADMITTED row → operational failure (exit 1), no mutation", async () => {
    const { factory, calls } = fakeFactory({});
    const res = await runAuthorizeCli(argv("authorize", MEMBER, "--network", "metafactory", "--admin-seed", seedPath), factory);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("no ADMITTED admission row");
    expect(calls.posted).toEqual([]);
  });
});

describe("cortex network authorize --apply", () => {
  test("--apply POSTs the authorize claim onto the resolved row", async () => {
    const { factory, calls } = fakeFactory({ admitted: { request_id: "req-1", principal_id: "alice" } });
    const res = await runAuthorizeCli(
      argv("authorize", MEMBER, "--network", "metafactory", "--admin-seed", seedPath, "--apply"),
      factory,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout).not.toContain("dry-run");
    expect(calls.posted).toEqual(["req-1"]);
  });

  test("--json emits the applied envelope", async () => {
    const { factory } = fakeFactory({ admitted: { request_id: "req-1", principal_id: "alice" } });
    const res = await runAuthorizeCli(
      argv("authorize", MEMBER, "--network", "metafactory", "--admin-seed", seedPath, "--apply", "--json"),
      factory,
    );
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { status: string; data: { applied: string; request_id: string } };
    expect(parsed.status).toBe("ok");
    expect(parsed.data.applied).toBe("true");
    expect(parsed.data.request_id).toBe("req-1");
  });
});
