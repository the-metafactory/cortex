import { afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Install a fresh HOME for each test and restore even an originally unset HOME. */
export function useTemporaryHome(): () => string {
  let home: string;
  let original: string | undefined;
  beforeEach(() => {
    original = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "cortex-fixture-home-"));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
    rmSync(home, { recursive: true, force: true });
  });
  return () => home;
}
