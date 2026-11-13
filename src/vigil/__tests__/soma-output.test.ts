// glossary-ignore: node, path
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSomaFile, readSomaOutputTitle } from "../soma-output";

const REF = "soma:outputs/weekly.md";
let home: string;
let restores: (() => void)[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "vigil-soma-output-"));
  mkdirSync(join(home, "outputs"));
  writeFileSync(join(home, "outputs", "weekly.md"), "# Weekly title\nPrivate file contents");
  restores = [];
});

afterEach(() => {
  for (const restore of restores) restore();
  rmSync(home, { recursive: true, force: true });
});

async function failingHandleMethods(): Promise<void> {
  const probe = await open(join(home, "outputs", "weekly.md"));
  const prototype = Object.getPrototypeOf(probe) as Record<string, (...args: unknown[]) => unknown>;
  await probe.close();
  for (const method of ["read", "readFile"]) {
    const spy = spyOn(prototype, method).mockImplementation(() => {
      throw new Error(`injected ${method} failure`);
    });
    restores.push(() => spy.mockRestore());
  }
}

test("a failed prefix read falls back to the reference without rejecting", async () => {
  await failingHandleMethods();
  await expect(readSomaOutputTitle(REF, home)).resolves.toBeNull();
});

test("a failed full read falls back to the reference without rejecting", async () => {
  await failingHandleMethods();
  await expect(readSomaFile(REF, "outputs", home)).resolves.toBeNull();
});

test("readers recover once the handle reads succeed again", async () => {
  await failingHandleMethods();
  await expect(readSomaOutputTitle(REF, home)).resolves.toBeNull();
  for (const restore of restores) restore();
  await expect(readSomaOutputTitle(REF, home)).resolves.toBe("Weekly title");
  await expect(readSomaFile(REF, "outputs", home)).resolves.toBe("# Weekly title\nPrivate file contents");
});
