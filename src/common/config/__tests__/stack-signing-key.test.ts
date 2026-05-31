/**
 * IAW Phase B.3 (cortex#114) — tests for `loadStackSigningKey`.
 *
 * Mirrors `account-signing-key.test.ts` deliberately — same load
 * discipline, different prefix gate:
 *   1. Valid `SU`-prefixed user seed at chmod 600 → succeeds.
 *   2. chmod 644 → throws "must be chmod 600".
 *   3. Wrong prefix (`SA`, `SO`) → throws "expected SU...".
 *   4. Missing file → throws ENOENT.
 *
 * Plus a public-key round-trip cross-check (loaded keypair's pubkey
 * matches a fresh `fromSeed()` on the same bytes — i.e. no silent
 * read/trim mangling).
 *
 * Seeds are generated fresh per-test via `createUser()` so no real
 * key material lands in the repo.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createAccount, createOperator, createUser, fromSeed } from "nkeys.js";
import { loadStackSigningKey } from "../stack-signing-key";

let testDir: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `cortex-stack-signing-key-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

function writeSeedFile(
  filename: string,
  seed: string,
  mode: number,
): { path: string; seed: string } {
  const path = join(testDir, filename);
  writeFileSync(path, seed);
  chmodSync(path, mode);
  return { path, seed };
}

function newUserSeed(): string {
  return new TextDecoder().decode(createUser().getSeed());
}

function newAccountSeed(): string {
  return new TextDecoder().decode(createAccount().getSeed());
}

function newOperatorSeed(): string {
  return new TextDecoder().decode(createOperator().getSeed());
}

describe("loadStackSigningKey", () => {
  test("loads a valid SU-prefixed user seed at chmod 600", async () => {
    const seed = newUserSeed();
    const { path } = writeSeedFile("stack.nk", seed, 0o600);

    const kp = await loadStackSigningKey(path);
    expect(kp).toBeDefined();
    expect(kp.getPublicKey()).toMatch(/^U[A-Z2-7]{55}$/);
  });

  test("rejects chmod 644 (the gate is exact)", async () => {
    const seed = newUserSeed();
    const { path } = writeSeedFile("stack.nk", seed, 0o644);

    // The shared `enforceChmod600` helper throws with "must be chmod 600"
    // (or equivalent platform-aware language). The exact wording is
    // owned by file-permissions.ts; we assert on the operator-actionable
    // fragment "chmod 600".
    await expect(loadStackSigningKey(path)).rejects.toThrow(/chmod 600/);
  });

  test("rejects SA-prefixed (account) seed with a clear error", async () => {
    const seed = newAccountSeed();
    const { path } = writeSeedFile("wrong-prefix.nk", seed, 0o600);

    await expect(loadStackSigningKey(path)).rejects.toThrow(/expected stack signing key/);
    await expect(loadStackSigningKey(path)).rejects.toThrow(/SA\.\.\./);
  });

  test("rejects SO-prefixed (operator) seed with a clear error", async () => {
    const seed = newOperatorSeed();
    const { path } = writeSeedFile("wrong-prefix.nk", seed, 0o600);

    await expect(loadStackSigningKey(path)).rejects.toThrow(/expected stack signing key/);
    await expect(loadStackSigningKey(path)).rejects.toThrow(/SO\.\.\./);
  });

  test("throws ENOENT on missing file", async () => {
    const missingPath = join(testDir, "does-not-exist.nk");
    await expect(loadStackSigningKey(missingPath)).rejects.toThrow(/ENOENT|no such file/);
  });

  test("trimming preserves the seed identity (no silent mangling)", async () => {
    const seed = newUserSeed();
    // Operators commonly leave a trailing newline (`nsc ... > stack.nk`).
    // The loader must trim without changing which pubkey gets derived.
    const { path } = writeSeedFile("with-newline.nk", seed + "\n", 0o600);

    const loaded = await loadStackSigningKey(path);
    const reference = fromSeed(new TextEncoder().encode(seed));
    expect(loaded.getPublicKey()).toBe(reference.getPublicKey());
  });
});
