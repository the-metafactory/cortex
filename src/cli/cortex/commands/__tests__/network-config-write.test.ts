/**
 * C-1349 — the SHARED guarded config-write (`writeNetworksGuarded`) used by both
 * the join adapter (Slice 1) and the `rotate-key` key store (Slice 2). Proves the
 * offer.ts write-guard invariants directly: round-trip, backup, chmod-600 on a
 * key-bearing file, and VALIDATE-before-write refusing a malformed K (file left
 * untouched). K is an obviously-FAKE all-zero 32-byte key; a wrong-length K is a
 * short base64 that must be REFUSED before any fs mutation.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { stringify } from "yaml";
import { readNetworksFromConfig, writeNetworksGuarded } from "../network-config-write";
import type { PolicyFederatedNetwork } from "../../../../common/types/cortex-config";

const FAKE_K = Buffer.alloc(32).toString("base64"); // 32 zero bytes — valid length.

function net(over: Partial<PolicyFederatedNetwork> = {}): PolicyFederatedNetwork {
  return {
    id: "metafactory",
    encryption: "enabled",
    payload_key: FAKE_K,
    payload_key_id: "metafactory/k2",
    peers: [],
    ...over,
  } as unknown as PolicyFederatedNetwork;
}

let tmp: string;
let path: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cfgwrite-"));
  path = join(tmp, "stack.yaml");
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("writeNetworksGuarded", () => {
  test("round-trips networks[] and clamps a key-bearing file to 0600", () => {
    writeFileSync(path, "policy:\n  federated:\n    networks: []\n");
    writeNetworksGuarded(path, [net()], { backupLabel: "rotate-key" });

    const read = readNetworksFromConfig(path);
    expect(read.length).toBe(1);
    expect(read[0]!.payload_key).toBe(FAKE_K);
    expect(read[0]!.payload_key_id).toBe("metafactory/k2");
    // Secret at rest → 0600.
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("writes a timestamped backup when the file already existed", () => {
    writeFileSync(path, "policy:\n  federated:\n    networks: []\n");
    writeNetworksGuarded(path, [net()], { backupLabel: "rotate-key" });
    const backups = readdirSync(tmp).filter((f) => f.includes(".pre-rotate-key-") && f.endsWith(".bak"));
    expect(backups.length).toBe(1);
  });

  test("a re-write's backup carries the file's actual mode (0600 once key-clamped), never a bare-default 0644", () => {
    writeFileSync(path, "policy:\n  federated:\n    networks: []\n");
    writeNetworksGuarded(path, [net()], { backupLabel: "rotate-key" }); // clamps to 0600 (key present)
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A second write (e.g. key rotation) — the file is ALREADY 0600 and
    // already carries a real payload_key; its backup is a snapshot of that
    // key-bearing file taken BEFORE this write, and must inherit the same
    // 0600, not the umask-default a bare `writeFileSync(backupPath, text)`
    // would otherwise leave it at.
    const rotated = net({ payload_key: Buffer.alloc(32, 1).toString("base64"), payload_key_id: "metafactory/k3" });
    writeNetworksGuarded(path, [rotated], { backupLabel: "rotate-key" });

    const backups = readdirSync(tmp).filter((f) => f.includes(".pre-rotate-key-") && f.endsWith(".bak"));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    for (const b of backups) {
      expect(statSync(join(tmp, b)).mode & 0o777).toBe(0o600);
    }
  });

  test("REFUSES a malformed (wrong-length) payload_key BEFORE any fs mutation", () => {
    const before = "policy:\n  federated:\n    networks: []\n";
    writeFileSync(path, before);
    const bad = net({ payload_key: "AAAA" }); // decodes to 3 bytes, not 32.
    expect(() => writeNetworksGuarded(path, [bad])).toThrow(/invalid payload_key/);
    // File untouched, no backup written.
    expect(readFileSync(path, "utf-8")).toBe(before);
    expect(readdirSync(tmp).filter((f) => f.endsWith(".bak")).length).toBe(0);
  });

  test("preserves comments in the surrounding config", () => {
    writeFileSync(path, "# DO NOT EDIT BY HAND\npolicy:\n  federated:\n    networks: []\n");
    writeNetworksGuarded(path, [net()]);
    expect(readFileSync(path, "utf-8")).toContain("# DO NOT EDIT BY HAND");
  });

  test("readNetworksFromConfig returns [] for a missing file", () => {
    expect(readNetworksFromConfig(join(tmp, "nope.yaml"))).toEqual([]);
    expect(existsSync(join(tmp, "nope.yaml"))).toBe(false);
  });
});

// FS-7 (cortex#1839) — whole-config validate-on-write via `validateComposePath`.
describe("writeNetworksGuarded — FS-7 whole-config validation", () => {
  let tmp2: string;
  let monolith: string;

  /** A complete, loadable single-file cortex config (monolith). */
  function validMonolith(): Record<string, unknown> {
    return {
      principal: { id: "jc", displayName: "JC", discordId: "555555555555555555" },
      agents: [
        { id: "ivy", displayName: "Ivy", persona: "./personas/ivy.md", roles: [], trust: [], presence: {} },
      ],
      claude: {},
    };
  }

  beforeEach(() => {
    tmp2 = mkdtempSync(join(tmpdir(), "cfgwrite-whole-"));
    monolith = join(tmp2, "cortex.yaml");
    // 0600 — the single-file loader enforces it (and the guard preserves the mode).
    writeFileSync(monolith, stringify(validMonolith()), { mode: 0o600 });
  });
  afterEach(() => rmSync(tmp2, { recursive: true, force: true }));

  test("rejects a write that composes to an INVALID whole config, leaving the file byte-identical", () => {
    const before = readFileSync(monolith, "utf-8");
    // Valid payload_key (passes the scoped guard) but an INVALID network id →
    // the payload_key + round-trip checks pass, yet `loadConfigWithAgents`
    // rejects the composed whole (the ADR-0001-class defence FS-7 adds).
    const badWhole = net({ id: "Bad Network!" });
    expect(() =>
      writeNetworksGuarded(monolith, [badWhole], { validateComposePath: monolith }),
    ).toThrow(/config write verification failed/);
    // Byte-identical: the guard restored the original.
    expect(readFileSync(monolith, "utf-8")).toBe(before);
    // 0600 preserved across the failed write.
    expect(statSync(monolith).mode & 0o777).toBe(0o600);
  });

  test("without validateComposePath, the scoped guard alone does NOT catch a whole-config violation", () => {
    // Regression guard for the FS-7 gap: the same bad-id write WITHOUT the compose
    // path passes (scoped guard only checks payload_key + round-trip) — proving the
    // new whole-config check is what closes the hole.
    const badWhole = net({ id: "Bad Network!" });
    expect(() => writeNetworksGuarded(monolith, [badWhole])).not.toThrow();
  });
});
