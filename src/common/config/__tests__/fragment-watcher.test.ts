// F-2 — AgentsDirectoryWatcher tests.
//
// Drive the watcher against a tmp-dir fixture, drop/modify/remove fragment
// files, assert the handler receives the right events. Debounce overridden
// to 50ms for test speed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { AgentsDirectoryWatcher, type AgentsChangeEvent } from "../watcher";
import { loadAgentsDirectory } from "../loader";

// 50ms debounce, plus 80ms grace = ~130ms per assertion. Each test awaits a
// real fs.watch event, so don't tighten this further without measurement.
const DEBOUNCE_MS = 50;
const WAIT_AFTER_EVENT = 130;

/**
 * Poll `condition` every `intervalMs` until truthy or `timeoutMs` expires.
 * Returns true when satisfied, false on deadline. Replaces fixed-duration
 * sleeps that proved racy under loaded CI runners (cortex#699).
 */
async function pollUntil(
  condition: () => boolean,
  timeoutMs = 2000,
  intervalMs = 30,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise<void>((r) => setTimeout(r, intervalMs));
  }
  return condition();
}

let tmpAgentsDir: string;
let tmpPersonasDir: string;
let watcher: AgentsDirectoryWatcher | null = null;
let events: AgentsChangeEvent[] = [];

beforeEach(() => {
  tmpAgentsDir = mkdtempSync(join(tmpdir(), "agents-d-watcher-"));
  tmpPersonasDir = mkdtempSync(join(tmpdir(), "personas-"));
  // Seed two reusable personas.
  writeFileSync(join(tmpPersonasDir, "echo.md"), `---\ndisplayName: Echo\n---\n`);
  writeFileSync(join(tmpPersonasDir, "holly.md"), `---\ndisplayName: Holly\n---\n`);
  events = [];
});

afterEach(() => {
  if (watcher) {
    watcher.stop();
    watcher = null;
  }
  rmSync(tmpAgentsDir, { recursive: true, force: true });
  rmSync(tmpPersonasDir, { recursive: true, force: true });
});

async function startWatcher(
  initial: Awaited<ReturnType<typeof loadAgentsDirectory>> = [],
): Promise<void> {
  watcher = new AgentsDirectoryWatcher(
    tmpAgentsDir,
    initial,
    (event) => {
      events.push(event);
    },
    { debounceMs: DEBOUNCE_MS },
  );
  watcher.start();
  // Echo M4 — wait for fs.watch registration to bind before tests write
  // fixtures, eliminating the macOS FSEvents subscription race.
  await watcher.waitForReady();
}

function dropFragment(id: string, personaName = `${id}.md`, extra: Record<string, unknown> = {}): void {
  const personaPath = join(tmpPersonasDir, personaName);
  const fragment = {
    id,
    displayName: id.charAt(0).toUpperCase() + id.slice(1),
    persona: personaPath,
    roles: ["agent-restricted"],
    presence: {
      discord: {
        enabled: false,
        token: "t",
        guildId: "0",
        agentChannelId: "1",
        logChannelId: "2",
      },
    },
    ...extra,
  };
  writeFileSync(join(tmpAgentsDir, `${id}.yaml`), yamlStringify(fragment));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("AgentsDirectoryWatcher", () => {
  describe("file events", () => {
    test("drop a fragment → fires with agentsAdded", async () => {
      await startWatcher();
      dropFragment("echo");
      await sleep(WAIT_AFTER_EVENT);
      // macOS fs.watch sometimes fires duplicate events; assert there is AT
      // LEAST one event that captured the change. Each test asserts the
      // semantic-content event, not the last event.
      const significant = events.find((e) => e.agentsAdded.includes("echo"));
      expect(significant).toBeDefined();
      expect(significant!.failed).toBe(false);
      expect(significant!.source).toBe("watcher");
      expect(significant!.agentsRemoved).toEqual([]);
    });

    test("modify a fragment → fires with agentsChanged", async () => {
      dropFragment("echo");
      const initial = loadAgentsDirectory(tmpAgentsDir);
      await startWatcher(initial);
      // Modify: change the displayName by rewriting with extra field
      dropFragment("echo", "echo.md", { trust: ["holly"] });
      await sleep(WAIT_AFTER_EVENT);
      const significant = events.find((e) => e.agentsChanged.includes("echo"));
      expect(significant).toBeDefined();
      expect(significant!.failed).toBe(false);
      expect(significant!.agentsAdded).toEqual([]);
      expect(significant!.agentsRemoved).toEqual([]);
    });

    test("delete a fragment → fires with agentsRemoved", async () => {
      dropFragment("echo");
      const initial = loadAgentsDirectory(tmpAgentsDir);
      await startWatcher(initial);
      unlinkSync(join(tmpAgentsDir, "echo.yaml"));
      await sleep(WAIT_AFTER_EVENT);
      const significant = events.find((e) => e.agentsRemoved.includes("echo"));
      expect(significant).toBeDefined();
      expect(significant!.failed).toBe(false);
      expect(significant!.agentsAdded).toEqual([]);
    });

    test("rapid changes debounce to a single event", async () => {
      await startWatcher();
      // Three writes within the debounce window.
      dropFragment("echo");
      dropFragment("echo");
      dropFragment("echo");
      // Poll until at least one event fires (cortex#699 — fixed 130ms sleeps
      // proved racy: on a loaded CI runner the three synchronous writes could
      // have their fs.watch notifications delayed past WAIT_AFTER_EVENT, causing
      // the assertion to see 0 events instead of the expected 1).
      await pollUntil(() => events.length > 0);
      // Give an additional full debounce window for any trailing events to
      // coalesce, then assert exactly one event (not three).
      await sleep(DEBOUNCE_MS * 3);
      expect(events.length).toBe(1);
      expect(events[0]!.agentsAdded).toContain("echo");
    });

    test("ignores dotfile changes", async () => {
      await startWatcher();
      writeFileSync(join(tmpAgentsDir, ".hidden.yaml"), "id: hidden\n");
      await sleep(WAIT_AFTER_EVENT);
      // No reload should fire.
      expect(events).toEqual([]);
    });

    test("ignores non-yaml changes", async () => {
      await startWatcher();
      writeFileSync(join(tmpAgentsDir, "README.md"), "principal notes\n");
      await sleep(WAIT_AFTER_EVENT);
      expect(events).toEqual([]);
    });
  });

  describe("failure handling", () => {
    test("bad fragment mid-run → failed:true, prior state retained", async () => {
      dropFragment("echo");
      const initial = loadAgentsDirectory(tmpAgentsDir);
      await startWatcher(initial);
      // Drop a malformed fragment alongside the good one.
      writeFileSync(join(tmpAgentsDir, "broken.yaml"), `displayName: "missing closing quote\n`);
      // Poll until the watcher fires an error event (cortex#699).
      await pollUntil(() => events.some((e) => e.failed));
      const last = events[events.length - 1]!;
      expect(last.failed).toBe(true);
      expect(last.error?.file).toContain("broken.yaml");
      // The watcher kept the prior valid agent set alive.
      expect(last.agents.map((a) => a.id)).toContain("echo");
    });

    test("recovers when bad fragment is fixed", async () => {
      dropFragment("echo");
      const initial = loadAgentsDirectory(tmpAgentsDir);
      await startWatcher(initial);
      writeFileSync(join(tmpAgentsDir, "broken.yaml"), `displayName: "missing closing quote\n`);
      // Poll until the watcher fires a failure event (cortex#699).
      await pollUntil(() => events.some((e) => e.failed));
      // Now repair it
      unlinkSync(join(tmpAgentsDir, "broken.yaml"));
      dropFragment("holly", "holly.md");
      // Poll until the watcher fires a recovery event (non-failed with holly added).
      await pollUntil(() => events.some((e) => !e.failed && e.agentsAdded.includes("holly")));
      const last = events[events.length - 1]!;
      expect(last.failed).toBe(false);
      expect(last.agentsAdded).toContain("holly");
    });
  });

  describe("explicit triggerReload", () => {
    test("triggerReload(cli) emits source: cli", async () => {
      dropFragment("echo");
      await startWatcher();
      watcher!.triggerReload("cli");
      // Sync call — no debounce wait needed for explicit triggers.
      await sleep(20);
      const last = events[events.length - 1]!;
      expect(last.source).toBe("cli");
      expect(last.failed).toBe(false);
    });

    test("triggerReload(sighup) emits source: sighup", async () => {
      dropFragment("echo");
      await startWatcher();
      watcher!.triggerReload("sighup");
      await sleep(20);
      const last = events[events.length - 1]!;
      expect(last.source).toBe("sighup");
    });
  });

  describe("idle behaviour", () => {
    test("missing agents.d dir → watcher logs and idles", () => {
      const missingDir = join(tmpdir(), `agents-d-nonexistent-${Date.now()}`);
      const localWatcher = new AgentsDirectoryWatcher(
        missingDir,
        [],
        (event) => {
          events.push(event);
        },
        { debounceMs: DEBOUNCE_MS },
      );
      // Should not throw.
      localWatcher.start();
      localWatcher.stop();
      expect(events).toEqual([]);
    });

    test("getAgents() returns the last-good state", async () => {
      dropFragment("echo");
      const initial = loadAgentsDirectory(tmpAgentsDir);
      await startWatcher(initial);
      expect(watcher!.getAgents().map((a) => a.id)).toContain("echo");
      // After a failure, getAgents still returns the prior set.
      writeFileSync(join(tmpAgentsDir, "broken.yaml"), `displayName: "missing closing quote\n`);
      await sleep(WAIT_AFTER_EVENT);
      expect(watcher!.getAgents().map((a) => a.id)).toContain("echo");
    });
  });
});

// =============================================================================
// Helpers
// =============================================================================

/**
 * Trivial YAML stringifier — only covers the shapes our test fixtures need.
 * Avoids pulling `yaml` package's `stringify` into test code to keep the
 * dependency surface minimal. Maps nest one level; arrays of scalars only.
 */
function yamlStringify(obj: Record<string, unknown>, indent = 0): string {
  const pad = "  ".repeat(indent);
  let out = "";
  for (const [key, val] of Object.entries(obj)) {
    if (val === null || val === undefined) continue;
    if (Array.isArray(val)) {
      const inline = val.map((v) => (typeof v === "string" ? `"${v}"` : String(v))).join(", ");
      out += `${pad}${key}: [${inline}]\n`;
    } else if (typeof val === "object") {
      out += `${pad}${key}:\n`;
      out += yamlStringify(val as Record<string, unknown>, indent + 1);
    } else if (typeof val === "string") {
      out += `${pad}${key}: "${val}"\n`;
    } else {
      // Fallthrough — numbers/booleans/null. The `?? "null"` shields the
      // template literal from the no-base-to-string rule on object-typed
      // narrowings that Bun's `Record<string, unknown>` value union picks
      // up after the `typeof === "object"` branch lands.
      out += `${pad}${key}: ${val as number | boolean | null ?? "null"}\n`;
    }
  }
  return out;
}
