/**
 * cortex#1598 (epic #1595 slice 2) — the live {@link ScopedUserMintPort} adapter
 * (`buildScopedUserMintAdapter`) that shells `arc nats add-federated-user`.
 *
 * The real arc/nsc are NEVER invoked — a fake {@link ArcScopedMintRunner} drives
 * the success / error envelopes and (on success) writes a fake creds file to the
 * `--output` path the adapter passes, exactly as real arc does. The tests assert:
 *   - the argv shape (dotted user, `--account`, `--output` tmp, `--json`),
 *   - the creds TEXT is read back from the tmp file and returned,
 *   - the tmp creds file is REMOVED after the call (no plaintext residue),
 *   - error mapping: ARC_TOO_OLD (exit 127 / bad schema / spawn throw),
 *     USER_NOT_SCOPED (passed through), OTHER (any other arc error code).
 */

import { describe, test, expect } from "bun:test";
import { existsSync, writeFileSync } from "fs";

import {
  buildScopedUserMintAdapter,
  type ArcScopedMintRunner,
  type ArcScopedMintRunResult,
} from "../network-secret-adapters";

// Clearly-fake creds material — never a real JWT/seed.
const FAKE_CREDS =
  "-----BEGIN NATS USER JWT-----\n" +
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n" +
  "------END NATS USER JWT------\n" +
  "-----BEGIN USER NKEY SEED-----\n" +
  "SUAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n" +
  "------END USER NKEY SEED------\n";

const FAKE_USER_PUB = "U" + "A".repeat(55);
const FAKE_SK_PUB = "A" + "B".repeat(55);

/** Extract the value following `flag` in an argv array. */
function argOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * A fake arc runner that, on success, writes {@link FAKE_CREDS} to the
 * `--output` path (as real arc does) and returns the `arc.nats.federated-user.v1`
 * success envelope. Captures the argv + output path it saw for assertions.
 */
function successRunner(
  overrides: Partial<{ scopeAlreadyPresent: boolean; userAlreadyPresent: boolean }> = {},
): { runner: ArcScopedMintRunner; seen: { argv?: readonly string[]; outPath?: string } } {
  const seen: { argv?: readonly string[]; outPath?: string } = {};
  const runner: ArcScopedMintRunner = (argv) => {
    seen.argv = argv;
    const outPath = argOf(argv, "--output");
    seen.outPath = outPath;
    if (outPath !== undefined) writeFileSync(outPath, FAKE_CREDS);
    const envelope = {
      schema: "arc.nats.federated-user.v1",
      ok: true,
      account: argOf(argv, "--account"),
      accountPubKey: "A" + "D".repeat(55),
      user: argv[2],
      userPubKey: FAKE_USER_PUB,
      signingKeyPubKey: FAKE_SK_PUB,
      scopeCreated: !(overrides.scopeAlreadyPresent ?? false),
      scopeAlreadyPresent: overrides.scopeAlreadyPresent ?? false,
      userCreated: !(overrides.userAlreadyPresent ?? false),
      userAlreadyPresent: overrides.userAlreadyPresent ?? false,
      credsPath: outPath,
      jwt: "AAAA",
      subTemplate: "federated.{{name()}}.>,_INBOX.>",
      pubTemplate: "federated.>,_INBOX.>",
    };
    return Promise.resolve({ stdout: JSON.stringify(envelope) + "\n", stderr: "", exitCode: 0 });
  };
  return { runner, seen };
}

function errorRunner(code: string, message = "boom"): ArcScopedMintRunner {
  return () =>
    Promise.resolve({
      stdout: JSON.stringify({ schema: "arc.nats.federated-user.v1", ok: false, error: { code, message } }) + "\n",
      stderr: "",
      exitCode: 1,
    } satisfies ArcScopedMintRunResult);
}

const INPUT = { hubFedAccount: "FEDERATION", natsUser: "jc.default", networkId: "metafactory" };

describe("buildScopedUserMintAdapter", () => {
  test("passes the pinned argv (dotted user, --account, --output tmp, --json)", async () => {
    const { runner, seen } = successRunner();
    const port = buildScopedUserMintAdapter(runner);
    await port.mintScopedUser(INPUT);

    expect(seen.argv?.slice(0, 3)).toEqual(["nats", "add-federated-user", "jc.default"]);
    expect(argOf(seen.argv ?? [], "--account")).toBe("FEDERATION");
    expect(seen.argv).toContain("--json");
    // --output points at a tmp path ending in the dotted user's .creds file.
    expect(seen.outPath).toMatch(/cortex-scoped-.*\/jc\.default\.creds$/);
  });

  test("returns the creds TEXT read back from the tmp file + fingerprint fields", async () => {
    const { runner } = successRunner({ scopeAlreadyPresent: true, userAlreadyPresent: false });
    const port = buildScopedUserMintAdapter(runner);
    const res = await port.mintScopedUser(INPUT);

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.creds).toBe(FAKE_CREDS);
    expect(res.userPubKey).toBe(FAKE_USER_PUB);
    expect(res.signingKeyPubKey).toBe(FAKE_SK_PUB);
    expect(res.scopeAlreadyPresent).toBe(true);
    expect(res.userAlreadyPresent).toBe(false);
  });

  test("removes the tmp creds file after the call (no plaintext residue)", async () => {
    const { runner, seen } = successRunner();
    const port = buildScopedUserMintAdapter(runner);
    await port.mintScopedUser(INPUT);

    expect(seen.outPath).toBeDefined();
    expect(existsSync(seen.outPath!)).toBe(false);
  });

  test("reports userAlreadyPresent on a re-export (idempotency surfaced, C2)", async () => {
    const { runner } = successRunner({ userAlreadyPresent: true });
    const res = await buildScopedUserMintAdapter(runner).mintScopedUser(INPUT);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.userAlreadyPresent).toBe(true);
  });

  test("maps exit 127 / no JSON envelope to ARC_TOO_OLD", async () => {
    const runner: ArcScopedMintRunner = () =>
      Promise.resolve({ stdout: "", stderr: "arc: command not found", exitCode: 127 });
    const res = await buildScopedUserMintAdapter(runner).mintScopedUser(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("ARC_TOO_OLD");
    expect(res.reason).toContain("arc upgrade");
  });

  test("maps an unknown-command / wrong schema to ARC_TOO_OLD", async () => {
    const runner: ArcScopedMintRunner = () =>
      Promise.resolve({
        stdout: JSON.stringify({ schema: "arc.nats.v1", ok: true }) + "\n",
        stderr: "",
        exitCode: 0,
      });
    const res = await buildScopedUserMintAdapter(runner).mintScopedUser(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("ARC_TOO_OLD");
  });

  test("passes USER_NOT_SCOPED through distinctly", async () => {
    const res = await buildScopedUserMintAdapter(errorRunner("USER_NOT_SCOPED")).mintScopedUser(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("USER_NOT_SCOPED");
    expect(res.reason).toContain("USER_NOT_SCOPED");
  });

  test("maps any other arc error code to OTHER", async () => {
    const res = await buildScopedUserMintAdapter(errorRunner("ACCOUNT_NOT_FOUND")).mintScopedUser(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("OTHER");
  });

  test("a spawn throw (missing arc binary) maps to ARC_TOO_OLD", async () => {
    const runner: ArcScopedMintRunner = () => Promise.reject(new Error("ENOENT: arc not found"));
    const res = await buildScopedUserMintAdapter(runner).mintScopedUser(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("ARC_TOO_OLD");
  });
});

// cortex#1599 — reissue (rotate) + revoke federated-user adapter methods.

const FAKE_NEW_PUB = "U" + "C".repeat(55);
const FAKE_REVOKED_PUB = "U" + "A".repeat(55);

/** A fake arc runner for reissue: writes creds to --output + returns the reissue envelope. */
function reissueRunner(): { runner: ArcScopedMintRunner; seen: { argv?: readonly string[]; outPath?: string } } {
  const seen: { argv?: readonly string[]; outPath?: string } = {};
  const runner: ArcScopedMintRunner = (argv) => {
    seen.argv = argv;
    const outPath = argOf(argv, "--output");
    seen.outPath = outPath;
    if (outPath !== undefined) writeFileSync(outPath, FAKE_CREDS);
    const env = {
      schema: "arc.nats.federated-user.v1",
      ok: true,
      account: "FEDERATION",
      accountPubKey: "A" + "D".repeat(55),
      user: argv[2],
      newPubKey: FAKE_NEW_PUB,
      revokedPubKey: FAKE_REVOKED_PUB,
      signingKeyPubKey: FAKE_SK_PUB,
      scopeAlreadyPresent: true,
      credsPath: outPath,
      jwt: "AAAA",
      subTemplate: "federated.{{name()}}.>,_INBOX.>",
      pubTemplate: "federated.>,_INBOX.>",
    };
    return Promise.resolve({ stdout: JSON.stringify(env) + "\n", stderr: "", exitCode: 0 });
  };
  return { runner, seen };
}

describe("buildScopedUserMintAdapter — reissueScopedUser (rotate)", () => {
  test("passes the reissue argv + returns the NEW creds and revoked/new pubkeys; tmp removed", async () => {
    const { runner, seen } = reissueRunner();
    const port = buildScopedUserMintAdapter(runner);
    const res = await port.reissueScopedUser!(INPUT);

    expect(seen.argv?.slice(0, 3)).toEqual(["nats", "reissue-federated-user", "jc.default"]);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.creds).toBe(FAKE_CREDS);
    expect(res.userPubKey).toBe(FAKE_NEW_PUB); // arc's newPubKey → the port's userPubKey
    expect(res.revokedPubKey).toBe(FAKE_REVOKED_PUB);
    expect(res.userPubKey).not.toBe(res.revokedPubKey);
    expect(existsSync(seen.outPath!)).toBe(false);
  });

  test("maps a PUSH_FAILED arc error through distinctly", async () => {
    const res = await buildScopedUserMintAdapter(errorRunner("PUSH_FAILED")).reissueScopedUser!(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("PUSH_FAILED");
  });
});

describe("buildScopedUserMintAdapter — revokeScopedUser", () => {
  test("passes the revoke argv (no --output) + returns the revoked pubkey", async () => {
    let seenArgv: readonly string[] | undefined;
    const runner: ArcScopedMintRunner = (argv) => {
      seenArgv = argv;
      const env = { schema: "arc.nats.federated-user.v1", ok: true, account: "FEDERATION", user: argv[2], revokedPubKey: FAKE_REVOKED_PUB };
      return Promise.resolve({ stdout: JSON.stringify(env) + "\n", stderr: "", exitCode: 0 });
    };
    const res = await buildScopedUserMintAdapter(runner).revokeScopedUser!(INPUT);

    expect(seenArgv?.slice(0, 3)).toEqual(["nats", "revoke-federated-user", "jc.default"]);
    expect(seenArgv).not.toContain("--output"); // revoke exports nothing
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    expect(res.revokedPubKey).toBe(FAKE_REVOKED_PUB);
  });

  test("maps USER_NOT_FOUND + PUSH_FAILED distinctly", async () => {
    const nf = await buildScopedUserMintAdapter(errorRunner("USER_NOT_FOUND")).revokeScopedUser!(INPUT);
    expect(nf.ok).toBe(false);
    if (nf.ok) throw new Error("expected failure");
    expect(nf.code).toBe("USER_NOT_FOUND");

    const pf = await buildScopedUserMintAdapter(errorRunner("PUSH_FAILED")).revokeScopedUser!(INPUT);
    expect(pf.ok).toBe(false);
    if (pf.ok) throw new Error("expected failure");
    expect(pf.code).toBe("PUSH_FAILED");
  });

  test("a verb-less arc (bad schema) maps to ARC_TOO_OLD", async () => {
    const runner: ArcScopedMintRunner = () => Promise.resolve({ stdout: JSON.stringify({ schema: "arc.nats.v1", ok: true }) + "\n", stderr: "", exitCode: 0 });
    const res = await buildScopedUserMintAdapter(runner).revokeScopedUser!(INPUT);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected failure");
    expect(res.code).toBe("ARC_TOO_OLD");
  });
});
