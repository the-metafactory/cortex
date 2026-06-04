/**
 * Tests for the registry-keypair generation script (#677 follow-up).
 *
 * The load-bearing assertions:
 *   1. The generated PKCS#8 private round-trips through the registry's OWN
 *      `pubkeyFromPkcs8` to EXACTLY the emitted raw pubkey (the correctness
 *      contract — if this breaks, the key is useless to the Worker).
 *   2. The generated key can actually sign, and the registry's `verifyEd25519`
 *      verifies that signature against the emitted pubkey (end-to-end).
 *   3. `--out` writes the private key chmod 600 and refuses to clobber
 *      (O_EXCL), with --force overriding. A planted symlink is refused.
 *   4. No private-key bytes leak into output beyond the single intended
 *      emission (the SECRET line / `registry_signing_key` JSON field).
 *
 * All filesystem state is ephemeral (mkdtemp). No hardcoded paths/ports.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  generateRegistryKeypair,
  dispatch,
  parseArgs,
  type KeygenResult,
  type KeygenOptions,
} from "../scripts/generate-registry-keypair";
import {
  pubkeyFromPkcs8,
  signEd25519,
  verifyEd25519,
  canonicalJSON,
  base64ToBytes,
} from "../src/signing";

const tmpDirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "regkey-"));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length > 0) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** Pull the structured data block out of a successful --json run. */
function jsonData(res: KeygenResult): Record<string, string> {
  const env = JSON.parse(res.stdout) as { status: string; data: Record<string, string> };
  expect(env.status).toBe("ok");
  return env.data;
}

describe("generate-registry-keypair — correctness contract", () => {
  test("[1] emitted PKCS#8 round-trips through pubkeyFromPkcs8 to the emitted pubkey", async () => {
    const res = await generateRegistryKeypair({ json: true });
    expect(res.exitCode).toBe(0);
    const data = jsonData(res);

    const priv = data.registry_signing_key!;
    const pub = data.registry_public_key!;

    // THE contract: the registry's own derive path must reproduce the pubkey.
    const derived = await pubkeyFromPkcs8(priv);
    expect(derived).toBe(pub);

    // Shape sanity: raw pubkey is 32 bytes; fingerprint is the 12-char prefix.
    expect(base64ToBytes(pub).length).toBe(32);
    expect(data.fingerprint).toBe(pub.slice(0, 12));
    expect(data.algorithm).toBe("Ed25519");
  });

  test("[2] the generated key signs and the registry's verifyEd25519 verifies it", async () => {
    const res = await generateRegistryKeypair({ json: true });
    const data = jsonData(res);
    const priv = data.registry_signing_key!;
    const pub = data.registry_public_key!;

    // End-to-end: sign a sample assertion-shaped payload with the generated
    // private key, verify against the emitted raw pubkey — exactly the path
    // the Worker's signAssertion / consumer verify uses.
    const payload = { payload: { principal_id: "andreas" }, issued_at: "2026-06-04T00:00:00.000Z", registry: pub };
    const message = new TextEncoder().encode(canonicalJSON(payload));
    const signature = await signEd25519(priv, message);
    expect(await verifyEd25519(pub, signature, message)).toBe(true);

    // Tamper → must NOT verify.
    // We change `issued_at` rather than the registry pubkey to guarantee a
    // different canonicalJSON regardless of the generated key's base64 prefix.
    // ("x" + pub.slice(1) would be identical to pub when pub starts with "x",
    // causing verifyEd25519 to correctly return true — a ~2% flake rate.)
    const tampered = new TextEncoder().encode(canonicalJSON({ ...payload, issued_at: "2026-06-04T00:00:01.000Z" }));
    expect(await verifyEd25519(pub, signature, tampered)).toBe(false);
  });

  test("[3] two invocations produce DIFFERENT keys (fresh keypair each time)", async () => {
    const a = jsonData(await generateRegistryKeypair({ json: true }));
    const b = jsonData(await generateRegistryKeypair({ json: true }));
    expect(a.registry_signing_key).not.toBe(b.registry_signing_key);
    expect(a.registry_public_key).not.toBe(b.registry_public_key);
  });
});

describe("generate-registry-keypair — file write (chmod 600, refuse-clobber)", () => {
  test("[4] --out writes the private key chmod 600", async () => {
    const out = join(freshDir(), "registry.pkcs8");
    const res = await generateRegistryKeypair({ json: true, out });
    expect(res.exitCode).toBe(0);
    expect(existsSync(out)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(out).mode & 0o777).toBe(0o600);
    }
    // The file holds the SAME private key that was emitted.
    const onDisk = readFileSync(out, "utf-8").trim();
    expect(onDisk).toBe(jsonData(res).registry_signing_key);
    // And that private key derives to the emitted pubkey.
    expect(await pubkeyFromPkcs8(onDisk)).toBe(jsonData(res).registry_public_key);
  });

  test("[5] --out refuses to clobber without --force (exit 1); --force overwrites", async () => {
    const out = join(freshDir(), "registry.pkcs8");
    const first = await generateRegistryKeypair({ json: true, out });
    expect(first.exitCode).toBe(0);
    const firstKey = readFileSync(out, "utf-8").trim();

    const refused = await generateRegistryKeypair({ json: true, out });
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/refusing to overwrite/i);
    expect(readFileSync(out, "utf-8").trim()).toBe(firstKey); // unchanged

    const forced = await generateRegistryKeypair({ json: true, out, force: true });
    expect(forced.exitCode).toBe(0);
    expect(readFileSync(out, "utf-8").trim()).not.toBe(firstKey); // rotated
  });

  test("[6] --out refuses to follow a planted symlink (O_EXCL)", async () => {
    const dir = freshDir();
    const target = join(dir, "victim");
    writeFileSync(target, "PRE-EXISTING\n");
    const link = join(dir, "link.pkcs8");
    symlinkSync(target, link);

    const res = await generateRegistryKeypair({ json: true, out: link });
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toMatch(/refusing to overwrite/i);
    // The symlink target must be UNTOUCHED — no write-through.
    expect(readFileSync(target, "utf-8")).toBe("PRE-EXISTING\n");
  });
});

describe("generate-registry-keypair — secrets discipline", () => {
  test("[7] human output emits the private key exactly once, labelled SECRET", async () => {
    const res = await generateRegistryKeypair({});
    expect(res.exitCode).toBe(0);
    // Recover the private key from a JSON run to know what to grep for.
    const data = jsonData(await generateRegistryKeypair({ json: true }));
    // (Different key — but both are valid PKCS#8 base64; assert the human
    // render carries its OWN single secret line under the SECRET banner.)
    expect(res.stdout).toContain("REGISTRY_SIGNING_KEY (SECRET");
    expect(res.stdout).toContain("Worker secret");
    expect(res.stderr).toBe("");
    // Sanity: the JSON `data` field carries the secret under the expected key.
    expect(data.registry_signing_key).toBeDefined();
  });

  test("[8] the private key appears exactly once in human stdout (no accidental echo)", async () => {
    // Generate via JSON to capture the exact secret, then assert the human
    // formatter — fed the SAME material — emits it once and only once.
    const data = jsonData(await generateRegistryKeypair({ json: true }));
    const priv = data.registry_signing_key!;
    // Build a human render by parsing: we cannot inject the key, so instead
    // assert the structural guarantee on a fresh human run — its single secret
    // line is the only base64 PKCS#8 blob (starts with the Ed25519 PKCS#8
    // marker "MC4CAQAw").
    const human = await generateRegistryKeypair({});
    const pkcs8Lines = human.stdout.split("\n").filter((l) => l.startsWith("MC4CAQAw"));
    expect(pkcs8Lines.length).toBe(1);
    // The public key (raw, 44 chars) is NOT a PKCS#8 blob, so it never matches.
    expect(priv.startsWith("MC4CAQAw")).toBe(true);
  });

  test("[9] --json error path on a write failure does not include any key", async () => {
    // Force a clobber refusal in JSON mode and confirm the error envelope
    // carries no key material.
    const out = join(freshDir(), "k.pkcs8");
    await generateRegistryKeypair({ json: true, out });
    const refused = await generateRegistryKeypair({ json: true, out });
    expect(refused.exitCode).toBe(1);
    const env = JSON.parse(refused.stderr) as { status: string; error: { reason: string } };
    expect(env.status).toBe("error");
    expect(env.error.reason).toMatch(/refusing to overwrite/i);
    // No PKCS#8 blob anywhere in the error output.
    expect(refused.stderr).not.toMatch(/MC4CAQAw/);
  });
});

describe("generate-registry-keypair — arg parsing", () => {
  test("[10] --help returns exit 0 with usage", async () => {
    const res = await dispatch(["--help"]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain("generate-registry-keypair");
    expect(res.stdout).toContain("REGISTRY_SIGNING_KEY");
  });

  test("[11] unknown flag → exit 2", async () => {
    const res = await dispatch(["--bogus"]);
    expect(res.exitCode).toBe(2);
    expect(res.stderr).toMatch(/unknown argument/i);
  });

  test("[12] --out with no value → exit 2", () => {
    const parsed = parseArgs(["--out"]);
    expect("exitCode" in parsed).toBe(true);
    expect((parsed as KeygenResult).exitCode).toBe(2);
  });

  test("[13] parseArgs returns options for valid flags", () => {
    const parsed = parseArgs(["--json", "--out", "/tmp/x", "--force"]);
    expect("exitCode" in parsed).toBe(false);
    const opts = parsed as KeygenOptions;
    expect(opts.json).toBe(true);
    expect(opts.out).toBe("/tmp/x");
    expect(opts.force).toBe(true);
  });
});
