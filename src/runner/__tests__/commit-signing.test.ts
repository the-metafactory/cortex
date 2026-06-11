/**
 * W5.0 (cortex#924) — signed-commit enforcement tests.
 *
 * The loop's commits MUST be signed; signing is NEVER disabled. These tests
 * assert the pure policy core:
 *   - `parseSignatureTrust` reads `git log --format=%G?` output → per-commit
 *     trust levels.
 *   - `verifyCommitsSigned` PASSES iff every commit's trust is `G` (a good
 *     signature); ANYTHING short (`N` unsigned, `B` bad, `E` cannot-check,
 *     `U`/`X`/`Y`/`R` lower trust) → FAIL, fail-closed.
 *   - `assertSigningEnabled` refuses an env/config where signing is off or
 *     where a `--no-gpg-sign` style override is present.
 */
import { describe, expect, test } from "bun:test";
import {
  parseSignatureTrust,
  verifyCommitsSigned,
  assertSigningConfig,
  SigningDisabledError,
} from "../commit-signing";

describe("parseSignatureTrust", () => {
  test("parses one trust char per line", () => {
    expect(parseSignatureTrust("G\nG\nG\n")).toEqual(["G", "G", "G"]);
  });

  test("trims blank trailing lines", () => {
    expect(parseSignatureTrust("G\n\n")).toEqual(["G"]);
  });

  test("an unsigned commit surfaces as N", () => {
    expect(parseSignatureTrust("G\nN\nG")).toEqual(["G", "N", "G"]);
  });

  test("empty output → empty list", () => {
    expect(parseSignatureTrust("")).toEqual([]);
    expect(parseSignatureTrust("   \n")).toEqual([]);
  });
});

describe("verifyCommitsSigned — every commit must be G", () => {
  test("all G → ok", () => {
    const r = verifyCommitsSigned(["G", "G", "G"]);
    expect(r.ok).toBe(true);
  });

  test("any N (unsigned) → fail, names the bad trust levels", () => {
    const r = verifyCommitsSigned(["G", "N", "G"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/N/);
      expect(r.badCount).toBe(1);
    }
  });

  test("B (bad signature) → fail", () => {
    const r = verifyCommitsSigned(["B"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.badCount).toBe(1);
  });

  test("E (cannot check) → fail (fail-closed — unknown is not good)", () => {
    const r = verifyCommitsSigned(["E"]);
    expect(r.ok).toBe(false);
  });

  test("U / X / Y / R (good-but-lower trust) → fail (we require full G)", () => {
    for (const t of ["U", "X", "Y", "R"]) {
      const r = verifyCommitsSigned([t]);
      expect(r.ok).toBe(false);
    }
  });

  test("empty commit set → fail-closed (nothing verified is not 'all signed')", () => {
    const r = verifyCommitsSigned([]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no commits/i);
  });
});

describe("assertSigningConfig — never run with signing disabled", () => {
  test("commit.gpgsign true + format + key + agent socket → ok", () => {
    expect(() =>
      assertSigningConfig({
        gpgSign: "true",
        gpgFormat: "ssh",
        signingKey: "/Users/x/.ssh/id_ed25519.pub",
        sshAuthSock: "/private/tmp/agent.sock",
      }),
    ).not.toThrow();
  });

  test("commit.gpgsign false → throws SigningDisabledError", () => {
    expect(() =>
      assertSigningConfig({
        gpgSign: "false",
        gpgFormat: "ssh",
        signingKey: "/k.pub",
        sshAuthSock: "/s.sock",
      }),
    ).toThrow(SigningDisabledError);
  });

  test("missing signing key → throws", () => {
    expect(() =>
      assertSigningConfig({
        gpgSign: "true",
        gpgFormat: "ssh",
        signingKey: undefined,
        sshAuthSock: "/s.sock",
      }),
    ).toThrow(SigningDisabledError);
  });

  test("ssh format but no SSH_AUTH_SOCK (key not loaded — apple-load-keychain not run) → throws", () => {
    expect(() =>
      assertSigningConfig({
        gpgSign: "true",
        gpgFormat: "ssh",
        signingKey: "/k.pub",
        sshAuthSock: undefined,
      }),
    ).toThrow(SigningDisabledError);
  });

  test("gpg (non-ssh) format does NOT require SSH_AUTH_SOCK", () => {
    expect(() =>
      assertSigningConfig({
        gpgSign: "true",
        gpgFormat: "openpgp",
        signingKey: "ABCD1234",
        sshAuthSock: undefined,
      }),
    ).not.toThrow();
  });

  test("error message names the disabled knob (no empty catch, surfaceable)", () => {
    try {
      assertSigningConfig({
        gpgSign: "false",
        gpgFormat: "ssh",
        signingKey: "/k.pub",
        sshAuthSock: "/s.sock",
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SigningDisabledError);
      expect((err as Error).message).toMatch(/commit\.gpgsign/);
    }
  });
});
