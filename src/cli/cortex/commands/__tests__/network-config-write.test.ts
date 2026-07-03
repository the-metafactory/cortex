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
