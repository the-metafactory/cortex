/**
 * XDG wave-2 (cortex#1870) — shared env plumbing unit tests.
 *
 * Pins the three primitives the seams share:
 *   - readDirEnv: trim + empty/whitespace ⇒ unset (PR#1920 nit a+b).
 *   - xdgStrict: truthy-value parse of CORTEX_XDG_STRICT.
 *   - noteXdgFallback: emits the ONE structured line ONLY under strict.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  XDG_FALLBACK_PREFIX,
  noteXdgFallback,
  readDirEnv,
  xdgStrict,
} from "../xdg";

const VARS = ["CORTEX_CONFIG_DIR", "CORTEX_EVENTS_DIR", "CORTEX_XDG_STRICT", "X_DIR_TEST"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) {
    saved[v] = process.env[v];
    Reflect.deleteProperty(process.env, v);
  }
});
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) Reflect.deleteProperty(process.env, v);
    else process.env[v] = saved[v];
  }
});

describe("readDirEnv — trimmed dir-override read", () => {
  test("unset ⇒ undefined", () => {
    expect(readDirEnv("X_DIR_TEST")).toBeUndefined();
  });
  test("empty ⇒ undefined (not '/')", () => {
    process.env.X_DIR_TEST = "";
    expect(readDirEnv("X_DIR_TEST")).toBeUndefined();
  });
  test("whitespace-only ⇒ undefined (PR#1920 nit a — never a literal relative dir)", () => {
    process.env.X_DIR_TEST = "   ";
    expect(readDirEnv("X_DIR_TEST")).toBeUndefined();
  });
  test("real value ⇒ trimmed value", () => {
    process.env.X_DIR_TEST = "  /tmp/scratch  ";
    expect(readDirEnv("X_DIR_TEST")).toBe("/tmp/scratch");
  });
});

describe("xdgStrict — CORTEX_XDG_STRICT parse", () => {
  test("unset ⇒ false", () => {
    expect(xdgStrict()).toBe(false);
  });
  test.each(["1", "true", "TRUE", "yes", " Yes "])("%p ⇒ true", (v) => {
    process.env.CORTEX_XDG_STRICT = v;
    expect(xdgStrict()).toBe(true);
  });
  test.each(["0", "false", "no", ""])("%p ⇒ false", (v) => {
    process.env.CORTEX_XDG_STRICT = v;
    expect(xdgStrict()).toBe(false);
  });
});

describe("noteXdgFallback — strict-gated structured line", () => {
  let written: string[];
  let restore: () => void;

  beforeEach(() => {
    written = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    };
    restore = () => {
      process.stderr.write = orig;
    };
  });
  afterEach(() => restore());

  test("non-strict ⇒ SILENT (byte-identical production behavior)", () => {
    noteXdgFallback("config", "cli.yaml from grove");
    expect(written).toEqual([]);
  });

  test("strict ⇒ emits exactly one xdg-fallback: line with site + detail", () => {
    process.env.CORTEX_XDG_STRICT = "1";
    noteXdgFallback("config", "cli.yaml from grove");
    expect(written.length).toBe(1);
    expect(written[0]).toStartWith(XDG_FALLBACK_PREFIX);
    expect(written[0]).toContain("config");
    expect(written[0]).toContain("cli.yaml from grove");
    expect(written[0]!.endsWith("\n")).toBe(true);
  });
});
