/**
 * XDG wave-1 (cortex#1908, EPIC cortex#1867 X-03) — CORTEX_EVENTS_DIR seam.
 *
 * Proves the two contract halves:
 *   - UNSET  ⇒ byte-identical to the previous inline
 *     `join(<home>, ".claude", "events")` at every call site.
 *   - SET    ⇒ the events buffer (root / raw / published) resolves ENTIRELY
 *     inside the override, winning over the `home` source — so a hermetic
 *     guard (#1870) can point the hook→relay→MC pipeline at a scratch dir.
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

describe("events-path — CORTEX_EVENTS_DIR seam (XDG wave-1 cortex#1908)", () => {
  let scratch: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env.CORTEX_EVENTS_DIR;
    delete process.env.CORTEX_EVENTS_DIR; // known-unset baseline
    scratch = mkdtempSync(join(tmpdir(), "x1908-ev-"));
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CORTEX_EVENTS_DIR;
    else process.env.CORTEX_EVENTS_DIR = savedEnv;
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("unset ⇒ byte-identical to <home>/.claude/events", () => {
    test("root/raw/published derive from the passed home", () => {
      expect(eventsDirOverride()).toBeUndefined();
      expect(eventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events"));
      expect(rawEventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events", "raw"));
      expect(publishedEventsDir(FAKE_HOME)).toBe(
        join(FAKE_HOME, ".claude", "events", "published"),
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

  describe("set ⇒ resolves inside CORTEX_EVENTS_DIR (hermetic)", () => {
    test("override wins over home for root/raw/published", () => {
      process.env.CORTEX_EVENTS_DIR = scratch;
      expect(eventsDirOverride()).toBe(scratch);
      expect(eventsDir(FAKE_HOME)).toBe(scratch);
      expect(rawEventsDir(FAKE_HOME)).toBe(join(scratch, "raw"));
      expect(publishedEventsDir(FAKE_HOME)).toBe(join(scratch, "published"));
      expect(rawEventsDir(FAKE_HOME).startsWith(scratch)).toBe(true);
      expect(publishedEventsDir(FAKE_HOME).startsWith(scratch)).toBe(true);
    });

    test("empty CORTEX_EVENTS_DIR is treated as unset (not '/')", () => {
      process.env.CORTEX_EVENTS_DIR = "";
      expect(eventsDirOverride()).toBeUndefined();
      expect(eventsDir(FAKE_HOME)).toBe(join(FAKE_HOME, ".claude", "events"));
    });
  });
});
