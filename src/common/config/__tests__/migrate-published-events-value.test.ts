/**
 * XDG wave-5 (cortex#1902) AC2 — publishedEventsDir config VALUE migrator tests.
 *
 * Hermetic: a scratch `cortex.yaml` under `os.tmpdir()`; a scratch `home` for the
 * `$HOME`-expanded-legacy case. Proves the pinned value is MIGRATED (not
 * shadowed) to the new metafactory data root, that a CUSTOM value is left alone,
 * that the rewrite is idempotent, and that surrounding formatting/comments
 * survive the one-line edit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parse as parseYaml } from "yaml";

import { migratePublishedEventsDirValue } from "../migrate-published-events-value";

const NEW = "~/.local/share/metafactory/cortex/events/published";

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xdg1902-pev-"));
  cfg = join(dir, "cortex.yaml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const CONFIG = (pev: string) =>
  `# generated cortex.yaml
paths:
  publishedEventsDir: ${pev}
  logDir: ~/.config/cortex/logs
nats:
  url: nats://127.0.0.1:4222
`;

describe("migratePublishedEventsDirValue", () => {
  test("rewrites a pinned legacy default value to the new data root", () => {
    writeFileSync(cfg, CONFIG("~/.claude/events/published"));
    const res = migratePublishedEventsDirValue(cfg);
    expect(res.changed).toBe(true);
    expect(res.from).toBe("~/.claude/events/published");
    expect(res.to).toBe(NEW);

    const parsed = parseYaml(readFileSync(cfg, "utf-8")) as {
      paths: { publishedEventsDir: string; logDir: string };
    };
    expect(parsed.paths.publishedEventsDir).toBe(NEW);
    // Untouched siblings preserved.
    expect(parsed.paths.logDir).toBe("~/.config/cortex/logs");
  });

  test("preserves surrounding comments + other lines (targeted single-line edit)", () => {
    writeFileSync(cfg, CONFIG("~/.claude/events/published"));
    migratePublishedEventsDirValue(cfg);
    const out = readFileSync(cfg, "utf-8");
    expect(out).toContain("# generated cortex.yaml");
    expect(out).toContain("url: nats://127.0.0.1:4222");
    expect(out).toContain(`publishedEventsDir: ${NEW}`);
  });

  test("migrates the $HOME-expanded absolute legacy form too", () => {
    const home = join(dir, "home");
    writeFileSync(cfg, CONFIG(join(home, ".claude", "events", "published")));
    const res = migratePublishedEventsDirValue(cfg, { home });
    expect(res.changed).toBe(true);
    const parsed = parseYaml(readFileSync(cfg, "utf-8")) as {
      paths: { publishedEventsDir: string };
    };
    expect(parsed.paths.publishedEventsDir).toBe(NEW);
  });

  test("leaves a CUSTOM pinned value untouched (respects user intent)", () => {
    writeFileSync(cfg, CONFIG("/mnt/events/published"));
    const res = migratePublishedEventsDirValue(cfg);
    expect(res.changed).toBe(false);
    const parsed = parseYaml(readFileSync(cfg, "utf-8")) as {
      paths: { publishedEventsDir: string };
    };
    expect(parsed.paths.publishedEventsDir).toBe("/mnt/events/published");
  });

  test("idempotent — an already-migrated value is a no-op", () => {
    writeFileSync(cfg, CONFIG(NEW));
    const res = migratePublishedEventsDirValue(cfg);
    expect(res.changed).toBe(false);
    expect(parseYaml(readFileSync(cfg, "utf-8"))).toMatchObject({
      paths: { publishedEventsDir: NEW },
    });
  });

  test("handles a quoted legacy value, preserving the quotes", () => {
    writeFileSync(cfg, CONFIG('"~/.claude/events/published"'));
    const res = migratePublishedEventsDirValue(cfg);
    expect(res.changed).toBe(true);
    const out = readFileSync(cfg, "utf-8");
    expect(out).toContain(`publishedEventsDir: "${NEW}"`);
  });

  test("missing file is a safe no-op", () => {
    expect(migratePublishedEventsDirValue(join(dir, "nope.yaml")).changed).toBe(false);
  });
});
