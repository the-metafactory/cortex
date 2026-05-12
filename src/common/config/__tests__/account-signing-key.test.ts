/**
 * C-108 (Prereq B for cortex#67): tests for the operator account signing
 * key loader.
 *
 * Coverage maps to the four spec bullets:
 *   1. Valid SA-prefixed seed at chmod 600 → succeeds, returns KeyPair.
 *   2. chmod 644 → throws "must be chmod 600".
 *   3. Wrong prefix (SO / SU / SP) → throws "expected SA...".
 *   4. Missing file → throws ENOENT.
 *
 * Plus one cross-check: the loaded KeyPair's `getPublicKey()` matches what
 * a fresh `fromSeed()` on the same bytes produces — i.e. we didn't silently
 * mangle the seed during read/trim.
 *
 * Test seeds are generated fresh per-suite via `createAccount()` so we don't
 * commit real-looking key material into the repo. The tmpdir is wiped in
 * `afterEach` so successive runs (and parallel test runs) don't collide.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createAccount, createOperator, createUser, fromSeed } from "nkeys.js";
import { loadAccountSigningKey } from "../account-signing-key";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `cortex-asknk-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

/**
 * Write a fresh seed file at the given mode. Returns `{ path, seed }` so
 * tests can both load the file *and* assert against the originating seed
 * (for the public-key round-trip check).
 */
function writeSeedFile(filename: string, seed: string, mode: number): { path: string; seed: string } {
  const path = join(testDir, filename);
  writeFileSync(path, seed);
  chmodSync(path, mode);
  return { path, seed };
}

function newAccountSeed(): string {
  // `getSeed()` returns the seed bytes (ASCII base32); decode to string for
  // file writing. NATS nkey seeds are always pure ASCII so UTF-8 decode is
  // lossless.
  const kp = createAccount();
  return new TextDecoder().decode(kp.getSeed());
}

function newOperatorSeed(): string {
  return new TextDecoder().decode(createOperator().getSeed());
}

function newUserSeed(): string {
  return new TextDecoder().decode(createUser().getSeed());
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("loadAccountSigningKey — happy path", () => {
  test("loads valid SA-prefixed seed at chmod 600", async () => {
    const seed = newAccountSeed();
    expect(seed.startsWith("SA")).toBe(true); // sanity: helper produced an account seed

    const { path } = writeSeedFile("account.nk", seed, 0o600);
    const kp = await loadAccountSigningKey(path);

    // KeyPair is the duck-typed interface from nkeys.js; the public-account
    // prefix on the *public key* side is `A` (Prefix.Account encodes to A...).
    expect(kp.getPublicKey().startsWith("A")).toBe(true);
  });

  test("trims trailing newline before parsing", async () => {
    // Real-world: `nsc generate nkey -a > account.nk` leaves a trailing \n.
    // If the loader doesn't trim, `fromSeed` rejects the bytes.
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed + "\n", 0o600);
    const kp = await loadAccountSigningKey(path);
    expect(kp.getPublicKey().startsWith("A")).toBe(true);
  });

  test("loaded KeyPair public key matches direct fromSeed()", async () => {
    // Cross-check: the path through the loader must be observationally
    // identical to calling fromSeed() on the same bytes. Catches a class
    // of bugs where the loader subtly mutates the seed (e.g. trims more
    // than whitespace) and silently produces a different KeyPair.
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed, 0o600);
    const loaded = await loadAccountSigningKey(path);
    const direct = fromSeed(new TextEncoder().encode(seed));
    expect(loaded.getPublicKey()).toBe(direct.getPublicKey());
  });
});

// ---------------------------------------------------------------------------
// chmod gate
// ---------------------------------------------------------------------------

describe("loadAccountSigningKey — chmod gate", () => {
  test("throws clear error when mode is 0644", async () => {
    if (process.platform === "win32") return; // gate doesn't run on Windows
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed, 0o644);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/must be chmod 600/);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/644/);
  });

  test("throws when mode is 0640 (group readable)", async () => {
    if (process.platform === "win32") return;
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed, 0o640);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/must be chmod 600/);
  });

  test("throws when mode is 0666 (world writable)", async () => {
    if (process.platform === "win32") return;
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed, 0o666);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/must be chmod 600/);
  });

  test("throws when mode is 0700 (owner-executable, still wrong)", async () => {
    // 0700 is too permissive in the "executable" axis even though group/world
    // see nothing. We want exactly 0600 — anything else is a typo.
    if (process.platform === "win32") return;
    const seed = newAccountSeed();
    const { path } = writeSeedFile("account.nk", seed, 0o700);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/must be chmod 600/);
  });
});

// ---------------------------------------------------------------------------
// Prefix gate
// ---------------------------------------------------------------------------

describe("loadAccountSigningKey — prefix gate", () => {
  test("rejects operator seed (SO prefix)", async () => {
    const seed = newOperatorSeed();
    expect(seed.startsWith("SO")).toBe(true);
    const { path } = writeSeedFile("operator.nk", seed, 0o600);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/expected account signing key/);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/SA\.\.\./);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/SO\.\.\./);
  });

  test("rejects user seed (SU prefix)", async () => {
    const seed = newUserSeed();
    expect(seed.startsWith("SU")).toBe(true);
    const { path } = writeSeedFile("user.nk", seed, 0o600);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/expected account signing key/);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/SU\.\.\./);
  });

  test("rejects garbage seed (SP-shaped placeholder)", async () => {
    // A made-up "SP..." string the loader should reject *before* it hits
    // nkeys.fromSeed (the prefix gate runs first).
    const { path } = writeSeedFile("garbage.nk", "SPAAAAAAAAAAAAAAAAAAAAAA", 0o600);
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/expected account signing key/);
  });
});

// ---------------------------------------------------------------------------
// Missing file
// ---------------------------------------------------------------------------

describe("loadAccountSigningKey — missing file", () => {
  test("throws ENOENT-flavored error", async () => {
    const path = join(testDir, "does-not-exist.nk");
    await expect(loadAccountSigningKey(path)).rejects.toThrow(/ENOENT|no such file/i);
  });
});
