/**
 * S1 (#735) — NetworkCache unit tests (DD-10 disk fallback).
 *
 * Direct tests of the cache primitive: store/load round-trip, corrupt-file
 * resilience, wrong-network rejection, and the no-file case. These complement
 * the client-level cache tests in `network-client.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
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
});
