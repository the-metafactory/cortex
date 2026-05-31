/**
 * cortex#87 — shared chmod-600 gate.
 *
 * Two existing consumers — `account-signing-key.ts` and
 * `bus/nats/connection.ts` — both rely on this single helper. Each
 * has its own integration-shaped tests that exercise the gate through
 * its caller; this file pins the policy at the unit level so a future
 * change to the helper (loosening / tightening / Windows behaviour)
 * surfaces here, not in the consumer suites.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { enforceChmod600 } from "../file-permissions";

describe("enforceChmod600", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "file-permissions-"));
    file = join(dir, "secret");
    writeFileSync(file, "x", "utf8");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("accepts a file at chmod 600", () => {
    if (process.platform === "win32") return;
    chmodSync(file, 0o600);
    expect(() => enforceChmod600(file)).not.toThrow();
  });

  test("rejects chmod 644 with principal-readable error containing path + actual mode", () => {
    if (process.platform === "win32") return;
    chmodSync(file, 0o644);
    expect(() => enforceChmod600(file)).toThrow(
      new RegExp(`${file.replace(/[/\\.]/g, "\\$&")}.*must be chmod 600.*644`),
    );
  });

  test("rejects chmod 640 (group-readable)", () => {
    if (process.platform === "win32") return;
    chmodSync(file, 0o640);
    expect(() => enforceChmod600(file)).toThrow(/must be chmod 600.*640/);
  });

  test("rejects chmod 666 (world-writable)", () => {
    if (process.platform === "win32") return;
    chmodSync(file, 0o666);
    expect(() => enforceChmod600(file)).toThrow(/must be chmod 600.*666/);
  });

  test("rejects chmod 400 (read-only but not the policy)", () => {
    // We require 0600 specifically — daemon needs to read AND write.
    // 0400 usually means a principal ran `chmod a-w` by hand; that's
    // a different principal action and should fail loudly, not slip past.
    if (process.platform === "win32") return;
    chmodSync(file, 0o400);
    expect(() => enforceChmod600(file)).toThrow(/must be chmod 600.*400/);
  });

  test("rejects chmod 700 (owner-executable)", () => {
    if (process.platform === "win32") return;
    chmodSync(file, 0o700);
    expect(() => enforceChmod600(file)).toThrow(/must be chmod 600.*700/);
  });

  test("propagates ENOENT for missing file", () => {
    if (process.platform === "win32") return;
    const missing = join(dir, "does-not-exist");
    expect(() => enforceChmod600(missing)).toThrow(/ENOENT|no such file/i);
  });

  test("on win32 the gate is skipped (NTFS uses ACLs)", () => {
    if (process.platform !== "win32") return;
    // On Windows, even a "wrong" mode value doesn't throw — the gate
    // emits a stderr note and returns. Document the behaviour so a
    // future change to Windows handling (ACL probing, etc.) trips
    // this assertion.
    chmodSync(file, 0o644);
    expect(() => enforceChmod600(file)).not.toThrow();
  });
});
