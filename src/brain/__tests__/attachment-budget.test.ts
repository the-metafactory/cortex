/**
 * `attachment-budget` unit tests (Bot Packs B-2; §12.5 — 4 MiB per-task cap).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  AttachmentBudget,
  attachmentByteSize,
  MAX_TASK_ATTACHMENT_BYTES,
} from "../attachment-budget";
import type { PostAttachment } from "../protocol";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "att-budget-"));
  dirs.push(d);
  return d;
}

describe("attachmentByteSize", () => {
  test("inline b64 charges the DECODED size, not the base64 envelope", () => {
    const decoded = Buffer.alloc(1000, 0x41);
    const att: PostAttachment = { filename: "a.bin", b64: decoded.toString("base64") };
    expect(attachmentByteSize(att)).toBe(1000);
  });

  test("scratch path charges the on-disk file size", () => {
    const dir = tmp();
    const file = join(dir, "out.png");
    writeFileSync(file, Buffer.alloc(2048, 0));
    const att: PostAttachment = { filename: "out.png", path: file };
    expect(attachmentByteSize(att, file)).toBe(2048);
  });

  test("a missing scratch file charges 0 (post fails downstream, not here)", () => {
    const att: PostAttachment = { filename: "gone.png", path: "/nope/missing.png" };
    expect(attachmentByteSize(att, "/nope/missing.png")).toBe(0);
  });
});

describe("AttachmentBudget", () => {
  test("charges accumulate and stay within the cap", () => {
    const b = new AttachmentBudget(1000);
    const att = (n: number): PostAttachment => ({
      filename: "x",
      b64: Buffer.alloc(n, 0).toString("base64"),
    });
    expect(b.charge(att(400)).ok).toBe(true);
    expect(b.charge(att(400)).ok).toBe(true);
    expect(b.totalBytes).toBe(800);
    expect(b.remainingBytes).toBe(200);
  });

  test("over-budget charge is refused and consumes NOTHING", () => {
    const b = new AttachmentBudget(1000);
    const att = (n: number): PostAttachment => ({
      filename: "x",
      b64: Buffer.alloc(n, 0).toString("base64"),
    });
    expect(b.charge(att(900)).ok).toBe(true);
    const refused = b.charge(att(200));
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.detail).toMatch(/budget exceeded/i);
    }
    // The refused bytes were NOT consumed — a smaller attachment still fits.
    expect(b.totalBytes).toBe(900);
    expect(b.charge(att(100)).ok).toBe(true);
  });

  test("default cap is 4 MiB", () => {
    expect(MAX_TASK_ATTACHMENT_BYTES).toBe(4 * 1024 * 1024);
    const b = new AttachmentBudget();
    const justUnder: PostAttachment = {
      filename: "x",
      // a path attachment lets us exceed the 256 KiB inline cap conceptually,
      // but here we just assert the cap value via a single over-cap inline-equiv
      // by charging a path-sized stat is covered elsewhere; use remaining.
      b64: "",
    };
    void justUnder;
    expect(b.remainingBytes).toBe(MAX_TASK_ATTACHMENT_BYTES);
  });
});
