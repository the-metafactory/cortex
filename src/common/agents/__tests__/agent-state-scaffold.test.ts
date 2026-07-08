/**
 * cortex#1720 S1 — unit tests for the AgentState scaffolder.
 *
 * Covers the two strategies + idempotency:
 *   - bundle-preferred: when the bundle script exists, the scaffolder spawns it
 *     with the correct CLI args + env (MF_AGENT_NAME / MF_HOST / MF_INSTANCE_DIR)
 *     and reports strategy "agent-state-bundle" on exit 0.
 *   - fallback-manual: when the bundle script is ABSENT, the scaffolder lays down
 *     the principal-facing skeleton itself (CLAUDE.md, dashboard.md, context/,
 *     retros/) WITHOUT a state.sqlite, and reports "fallback-manual".
 *   - fallback-on-nonzero: a present bundle that exits non-zero degrades to the
 *     manual fallback (principal not blocked).
 *   - idempotent: a second run over a scaffolded dir creates nothing.
 *
 * No real `bun` subprocess, no `~/.config` touch — every path is driven through
 * the `instanceDir` / `agentStateScript` / `spawn` test seams into a tmp dir.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import {
  isFullyScaffolded,
  resolveInstanceDir,
  scaffoldInstance,
  type ScaffoldSpawn,
} from "../agent-state-scaffold";

const AGENT = { id: "luna", displayName: "Luna" };

let root: string;
let instanceDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cortex-scaffold-"));
  instanceDir = join(root, "agents", "luna");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("scaffoldInstance — bundle-preferred path", () => {
  test("spawns the bundle script with correct args + env when it exists", () => {
    // A real (empty) file standing in for the installed bundle scaffold.ts.
    const bundleScript = join(root, "scaffold.ts");
    writeFileSync(bundleScript, "// stub bundle scaffold\n");

    const calls: {
      cmd: string;
      args: string[];
      env?: NodeJS.ProcessEnv;
    }[] = [];
    const spawn: ScaffoldSpawn = (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts.env });
      return { status: 0 };
    };

    const result = scaffoldInstance(AGENT, {
      instanceDir,
      agentStateScript: bundleScript,
      spawn,
      host: "cortex",
    });

    expect(result.strategy).toBe("agent-state-bundle");
    expect(result.instanceDir).toBe(instanceDir);

    // Exactly one spawn, invoking `bun <script> <instanceDir> --host=cortex --agent=luna`.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toBe("bun");
    expect(call.args[0]).toBe(bundleScript);
    expect(call.args).toContain(instanceDir);
    expect(call.args).toContain("--host=cortex");
    expect(call.args).toContain("--agent=luna");

    // Env carries the standard subprocess contract.
    expect(call.env?.MF_AGENT_NAME).toBe("luna");
    expect(call.env?.MF_HOST).toBe("cortex");
    expect(call.env?.MF_INSTANCE_DIR).toBe(instanceDir);
  });

  test("does NOT write manual skeleton when the bundle succeeds", () => {
    const bundleScript = join(root, "scaffold.ts");
    writeFileSync(bundleScript, "// stub\n");
    const spawn: ScaffoldSpawn = () => ({ status: 0 });

    scaffoldInstance(AGENT, { instanceDir, agentStateScript: bundleScript, spawn });

    // The bundle owns the skeleton; the host must not double-write it.
    expect(existsSync(join(instanceDir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(instanceDir, "dashboard.md"))).toBe(false);
    // But the instance dir itself is created up front so the bundle can land.
    expect(existsSync(instanceDir)).toBe(true);
  });

  test("falls back to manual scaffold when the bundle exits non-zero", () => {
    const bundleScript = join(root, "scaffold.ts");
    writeFileSync(bundleScript, "// stub\n");
    const spawn: ScaffoldSpawn = () => ({ status: 3, stderr: "boom" });

    const result = scaffoldInstance(AGENT, {
      instanceDir,
      agentStateScript: bundleScript,
      spawn,
    });

    expect(result.strategy).toBe("fallback-manual");
    // Manual skeleton is now present.
    expect(isFullyScaffolded(instanceDir)).toBe(true);
  });
});

describe("scaffoldInstance — fallback-manual path (bundle absent)", () => {
  test("lays down the principal skeleton without a state.sqlite", () => {
    // agentStateScript points at a path that does NOT exist → manual fallback.
    const missingScript = join(root, "does-not-exist", "scaffold.ts");

    const result = scaffoldInstance(AGENT, {
      instanceDir,
      agentStateScript: missingScript,
    });

    expect(result.strategy).toBe("fallback-manual");
    expect(isFullyScaffolded(instanceDir)).toBe(true);

    // CLAUDE.md + dashboard.md exist and name the agent.
    expect(readFileSync(join(instanceDir, "CLAUDE.md"), "utf8")).toContain("Luna");
    expect(existsSync(join(instanceDir, "dashboard.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "context", "repos.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "retros"))).toBe(true);

    // The host must NOT create state.sqlite — the bundle owns that schema.
    expect(existsSync(join(instanceDir, "state.sqlite"))).toBe(false);
  });

  test("forceFallback bypasses an existing bundle script", () => {
    const bundleScript = join(root, "scaffold.ts");
    writeFileSync(bundleScript, "// stub\n");
    let spawned = false;
    const spawn: ScaffoldSpawn = () => {
      spawned = true;
      return { status: 0 };
    };

    const result = scaffoldInstance(AGENT, {
      instanceDir,
      agentStateScript: bundleScript,
      forceFallback: true,
      spawn,
    });

    expect(spawned).toBe(false);
    expect(result.strategy).toBe("fallback-manual");
  });
});

describe("scaffoldInstance — idempotency", () => {
  test("a second manual run creates nothing new", () => {
    const missingScript = join(root, "nope", "scaffold.ts");
    const first = scaffoldInstance(AGENT, { instanceDir, agentStateScript: missingScript });
    expect(first.created.length).toBeGreaterThan(0);

    const second = scaffoldInstance(AGENT, { instanceDir, agentStateScript: missingScript });
    expect(second.created).toHaveLength(0);
    // Everything the second run saw was already there.
    expect(second.skipped.length).toBeGreaterThan(0);
  });
});

describe("resolveInstanceDir", () => {
  test("honors the ~/.config/<host>/agents/<id>/ convention", () => {
    const home = process.env.HOME ?? "";
    expect(resolveInstanceDir("luna")).toBe(join(home, ".config", "cortex", "agents", "luna"));
    expect(resolveInstanceDir("echo", "grove")).toBe(
      join(home, ".config", "grove", "agents", "echo"),
    );
  });
});
