/**
 * S1 (#735) — NetworkCache unit tests (DD-10 disk fallback).
 *
 * Direct tests of the cache primitive: store/load round-trip, corrupt-file
 * resilience, wrong-network rejection, and the no-file case. These complement
 * the client-level cache tests in `network-client.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { NetworkCache } from "../network-cache";
import type { NetworkDescriptor, NetworkRosterResult } from "../types";

const noopLog = (): void => {
  /* swallow */
};

let tmp: string;
let cache: NetworkCache;

const descriptor: NetworkDescriptor = {
  network_id: "iaw",
  hub_url: "tls://hub.meta-factory.ai:7422",
  leaf_port: 7422,
  members: ["andreas", "jc"],
};
const roster: NetworkRosterResult = {
  network_id: "iaw",
  members: [{ principal_id: "andreas", principal_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }],
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "cortex-cache-unit-"));
  cache = new NetworkCache({ cacheDir: tmp, logError: noopLog });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("NetworkCache", () => {
  test("store then load round-trips a verified pair", () => {
    expect(cache.store("iaw", descriptor, roster)).toBe(true);
    const loaded = cache.load("iaw");
    expect(loaded?.descriptor).toEqual(descriptor);
    expect(loaded?.roster).toEqual(roster);
    expect(typeof loaded?.cached_at).toBe("string");
  });

  test("load returns undefined when no cache file exists", () => {
    expect(cache.load("absent")).toBeUndefined();
  });

  test("load returns undefined on a corrupt (non-JSON) cache file", () => {
    writeFileSync(join(tmp, "iaw.json"), "{ not valid json", { encoding: "utf8" });
    expect(cache.load("iaw")).toBeUndefined();
  });

  test("load rejects a file whose cached network_id does not match", () => {
    // A descriptor for a DIFFERENT network written under the iaw filename.
    cache.store("other", { ...descriptor, network_id: "other" }, { ...roster, network_id: "other" });
    // Hand-place the 'other' content under the 'iaw' filename to simulate a
    // swapped/corrupt file.
    const otherContent = cache.load("other");
    expect(otherContent).toBeDefined();
    writeFileSync(
      join(tmp, "iaw.json"),
      JSON.stringify({
        schema_version: 1,
        cached_at: new Date().toISOString(),
        descriptor: { ...descriptor, network_id: "other" },
        roster: { ...roster, network_id: "other" },
      }),
      { encoding: "utf8" },
    );
    expect(cache.load("iaw")).toBeUndefined();
  });

  test("load rejects an unknown schema_version", () => {
    writeFileSync(
      join(tmp, "iaw.json"),
      JSON.stringify({ schema_version: 999, cached_at: "x", descriptor, roster }),
      { encoding: "utf8" },
    );
    expect(cache.load("iaw")).toBeUndefined();
  });

  // C-850 — list() enumerates every cached record for `cortex network status`.
  describe("list", () => {
    test("returns [] when the cache dir does not exist", () => {
      const absent = new NetworkCache({
        cacheDir: join(tmp, "does-not-exist"),
        logError: noopLog,
      });
      expect(absent.list()).toEqual([]);
    });

    test("returns [] when the cache dir is empty", () => {
      expect(cache.list()).toEqual([]);
    });

    test("enumerates every valid cached record", () => {
      cache.store("iaw", descriptor, roster);
      cache.store(
        "metafactory-community",
        { ...descriptor, network_id: "metafactory-community" },
        { ...roster, network_id: "metafactory-community" },
      );
      const ids = cache.list().map((r) => r.descriptor.network_id).sort();
      expect(ids).toEqual(["iaw", "metafactory-community"]);
    });

    test("skips corrupt / non-JSON files but returns the valid ones", () => {
      cache.store("iaw", descriptor, roster);
      writeFileSync(join(tmp, "broken.json"), "{ not valid json", {
        encoding: "utf8",
      });
      const ids = cache.list().map((r) => r.descriptor.network_id);
      expect(ids).toEqual(["iaw"]);
    });

    test("ignores non-.json files in the cache dir", () => {
      cache.store("iaw", descriptor, roster);
      writeFileSync(join(tmp, "README.txt"), "not a cache file", {
        encoding: "utf8",
      });
      expect(cache.list().length).toBe(1);
    });
  });

  // G-28 / epic X-02 — store() must be atomic (write → fsync → rename) so a
  // crash or daemon respawn mid-write can never land a truncated file at the
  // live path, where load() would swallow the parse error and silently lose
  // the DD-10 last-known-good roster.
  describe("atomic store (G-28 / X-02)", () => {
    const bigRoster = (n: number): NetworkRosterResult => ({
      network_id: "iaw",
      members: Array.from({ length: n }, (_, i) => ({
        principal_id: `p${i}`,
        principal_pubkey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      })),
    });

    test("store lands a complete, valid JSON file and leaves no .tmp residue", () => {
      // A large record makes a non-atomic single writeFileSync span multiple
      // write syscalls — the window this fix closes.
      expect(cache.store("iaw", descriptor, bigRoster(5000))).toBe(true);
      const raw = readFileSync(join(tmp, "iaw.json"), { encoding: "utf8" });
      // The live file is always complete, parseable JSON.
      expect(() => JSON.parse(raw)).not.toThrow();
      expect(cache.load("iaw")?.roster.members.length).toBe(5000);
      // The temp file was renamed away, not left beside the live file.
      expect(readdirSync(tmp).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    });

    test("a truncated .tmp left by a crashed write is never observable at the live path", () => {
      // Simulate a crash mid-write: a truncated temp file, no live file yet.
      writeFileSync(join(tmp, "iaw.json.tmp"), '{"schema_version":1,"cached', {
        encoding: "utf8",
      });
      // load() reads only the live path — the partial tmp is invisible.
      expect(cache.load("iaw")).toBeUndefined();
      // list() skips non-.json files, so the tmp never surfaces there either.
      expect(cache.list()).toEqual([]);
      // A subsequent successful store lands a complete, valid live record. It
      // does NOT sweep the foreign tmp: with unique per-pid tmp names a live
      // writer never touches another process's tmp, so a dead pid's leftover
      // is deliberately left as bounded, inert residue.
      expect(cache.store("iaw", descriptor, roster)).toBe(true);
      expect(cache.load("iaw")?.roster).toEqual(roster);
      // The foreign tmp is still on disk (not swept) yet remains inert —
      // absent from both load() (checked above) and list().
      expect(readdirSync(tmp)).toContain("iaw.json.tmp");
      expect(cache.list().map((r) => r.descriptor.network_id)).toEqual(["iaw"]);
    });

    test("documents interleaved store/load intent (sync fs cannot preempt mid-write — the guarantee is pinned by the truncated-.tmp test above)", async () => {
      const big = bigRoster(3000);
      // Seed one good record so every reader has something to read.
      expect(cache.store("iaw", descriptor, big)).toBe(true);

      const rounds = 40;
      const writers = Array.from({ length: rounds }, () =>
        Promise.resolve().then(() => cache.store("iaw", descriptor, big)),
      );
      const readers = Array.from({ length: rounds }, () =>
        Promise.resolve().then(() => {
          // The reader must never see a truncated file at the live path: the
          // raw bytes always parse, and load() returns the full record.
          const raw = readFileSync(join(tmp, "iaw.json"), { encoding: "utf8" });
          expect(() => JSON.parse(raw)).not.toThrow();
          expect(cache.load("iaw")?.roster.members.length).toBe(3000);
        }),
      );
      await Promise.all([...writers, ...readers]);
    });
  });
});
