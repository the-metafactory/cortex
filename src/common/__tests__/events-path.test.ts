/**
 * XDG wave-1 (cortex#1908, EPIC cortex#1867 X-03) — CORTEX_EVENTS_DIR seam.
 *
 * Proves the RAW contract halves (unchanged by #1902):
 *   - UNSET  ⇒ raw byte-identical to the previous inline
 *     `join(<home>, ".claude", "events")` at every call site.
 *   - SET    ⇒ the RAW buffer (root / raw) resolves ENTIRELY inside
 *     `$CORTEX_EVENTS_DIR`, winning over the `home` source — so a hermetic guard
 *     (#1870) can point the hook→relay→MC RAW pipeline at a scratch dir.
 *
 * XDG wave-5 (#1902): `publishedEventsDir()` is now app-private DATA and resolves
 * under the metafactory data root (`~/.local/share/metafactory/cortex/events/
 * published`, or `$CORTEX_DATA_DIR`) — it NO LONGER shares a root with raw and
 * NO LONGER honors `$CORTEX_EVENTS_DIR`. That split is asserted below.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  eventsDir,
  eventsDirOverride,
  publishedEventsDir,
  rawEventsDir,
} from "../events-path";

const FAKE_HOME = "/fake/home";
/** The metafactory data-root published dir for a given home (XDG wave-5). */
const dataPublished = (home: string) =>
  join(home, ".local", "share", "metafactory", "cortex", "events", "published");

describe("events-path — CORTEX_EVENTS_DIR seam (XDG wave-1 cortex#1908)", () => {
  let scratch: string;
  let savedEnv: string | undefined;
  let savedDataEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CORTEX_EVENTS_DIR;
    savedDataEnv = process.env.CORTEX_DATA_DIR;
    delete process.env.CORTEX_EVENTS_DIR; // known-unset baseline
    delete process.env.CORTEX_DATA_DIR; // published now derives from this seam
    scratch = mkdtempSync(join(tmpdir(), "x1908-ev-"));
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CORTEX_EVENTS_DIR;
    else process.env.CORTEX_EVENTS_DIR = savedEnv;
    if (savedDataEnv === undefined) delete process.env.CORTEX_DATA_DIR;
    else process.env.CORTEX_DATA_DIR = savedDataEnv;
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("unset ⇒ raw byte-identical to <home>/.claude/events; published under the data root", () => {
    test("root/raw derive from the passed home; published moves to the data root (#1902)", () => {
      expect(eventsDirOverride()).toBeUndefined();
      expect(eventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events"));
      expect(rawEventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events", "raw"));
      // XDG wave-5: published is DATA — under the metafactory data root, NOT ~/.claude.
      expect(publishedEventsDir(FAKE_HOME)).toBe(dataPublished(FAKE_HOME));
      // The split: raw and published NO LONGER share a parent.
      expect(join(rawEventsDir(FAKE_HOME), "..")).not.toBe(
        join(publishedEventsDir(FAKE_HOME), ".."),
      );
    });

    test("no home arg ⇒ defaults to process.env.HOME (the hook/relay spelling)", () => {
      const savedHome = process.env.HOME;
      process.env.HOME = "/env/home";
      try {
        expect(eventsDir()).toBe(join("/env/home", ".claude", "events"));
      } finally {
        if (savedHome === undefined) delete process.env.HOME;
        else process.env.HOME = savedHome;
      }
    });
  });

  describe("set ⇒ RAW resolves inside CORTEX_EVENTS_DIR (hermetic)", () => {
    test("override wins over home for root/raw; published is UNAFFECTED (data seam)", () => {
      process.env.CORTEX_EVENTS_DIR = scratch;
      expect(eventsDirOverride()).toBe(scratch);
      expect(eventsDir(FAKE_HOME)).toBe(scratch);
      expect(rawEventsDir(FAKE_HOME)).toBe(join(scratch, "raw"));
      expect(rawEventsDir(FAKE_HOME).startsWith(scratch)).toBe(true);
      // XDG wave-5: CORTEX_EVENTS_DIR does NOT move published — it's on the data
      // seam ($CORTEX_DATA_DIR / metafactory data root), not the events seam.
      expect(publishedEventsDir(FAKE_HOME)).toBe(dataPublished(FAKE_HOME));
    });

    test("CORTEX_DATA_DIR relocates published (the data seam) but NOT raw", () => {
      process.env.CORTEX_DATA_DIR = scratch;
      expect(publishedEventsDir(FAKE_HOME)).toBe(join(scratch, "events", "published"));
      // raw is unmoved by the data seam.
      expect(rawEventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events", "raw"));
    });

    test("empty CORTEX_EVENTS_DIR is treated as unset (not '/')", () => {
      process.env.CORTEX_EVENTS_DIR = "";
      expect(eventsDirOverride()).toBeUndefined();
      expect(eventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events"));
    });
  });
});
