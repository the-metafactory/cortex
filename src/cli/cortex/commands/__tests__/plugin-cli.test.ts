/**
 * cortex#1793 (S8) — `cortex plugin` CLI dispatcher tests.
 *
 * Covers the parts of the surface that don't require a live daemon +
 * NATS connection: help/usage/unknown-subcommand dispatch, and the pure
 * rendering/parsing helpers in `plugin-lib.ts`. The live round-trip
 * (`sendPluginControlRequest`) is exercised end-to-end by
 * `src/gateway/__tests__/plugin-runtime.test.ts` at the domain-logic layer
 * and by manual verification against a running dev stack (see the S8
 * completion report) — a real NATS server is out of scope for a unit test
 * here, matching this repo's existing `network ping`/`network status` test
 * posture (those also unit-test the pure layer and fake the bus port).
 */

import { describe, test, expect } from "bun:test";
import { dispatchPlugin } from "../plugin";
import {
  renderPluginList,
  renderMutationPreview,
  renderLoadPreview,
  resolvePrincipalIdForCli,
} from "../plugin-lib";
import type { SystemPluginControlListRow } from "../../../../bus/system-events";

// =============================================================================
// dispatch / usage / help
// =============================================================================

describe("dispatchPlugin — dispatch/usage/help", () => {
  test("no subcommand: usage error, exit 2", async () => {
    const result = await dispatchPlugin([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("no subcommand specified");
  });

  test("unknown subcommand: usage error, exit 2", async () => {
    const result = await dispatchPlugin(["frobnicate"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('unknown subcommand "frobnicate"');
  });

  test("--help: exit 0, prints usage", async () => {
    const result = await dispatchPlugin(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("cortex plugin");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("unload");
    expect(result.stdout).toContain("reload");
    expect(result.stdout).toContain("load");
  });

  test("unload with no instance-id: missing-positional usage error", async () => {
    const result = await dispatchPlugin(["unload"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing required positional argument");
  });

  test("load with no bundle-name: missing-positional usage error", async () => {
    const result = await dispatchPlugin(["load"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("missing required positional argument");
  });

  test("unknown flag: usage error, exit 2", async () => {
    const result = await dispatchPlugin(["list", "--bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unknown flag");
  });
});

// =============================================================================
// dry-run preview (no --apply, no network) — unload/reload/load never send a
// mutating request without --apply; these paths DO reach sendPluginControlRequest
// for a read-only "list" precheck, so they're exercised via the pure preview
// renderers directly rather than dispatchPlugin (which would need a live daemon).
// =============================================================================

describe("dry-run preview renderers (plugin-lib.ts)", () => {
  const rows: SystemPluginControlListRow[] = [
    { kind: "renderer", platformOrKind: "pagerduty", instanceId: "pagerduty", bundleName: "acme-pagerduty", running: true },
  ];

  test("renderMutationPreview: names the real instance found in rows", () => {
    const preview = renderMutationPreview("unload", "pagerduty", rows);
    expect(preview).toContain("would unload renderer");
    expect(preview).toContain("pagerduty");
    expect(preview).toContain("acme-pagerduty");
    expect(preview).toContain("--apply");
  });

  test("renderMutationPreview: absent instance is called out, not silently accepted", () => {
    const preview = renderMutationPreview("reload", "ghost", rows);
    expect(preview).toContain('no live instance "ghost" found');
    expect(preview).toContain("would be refused");
  });

  test("renderLoadPreview: states intent without needing a live check", () => {
    const preview = renderLoadPreview("acme-bundle");
    expect(preview).toContain('load renderer bundle "acme-bundle"');
    expect(preview).toContain("--apply");
  });

  test("renderPluginList: empty rows", () => {
    expect(renderPluginList([])).toContain("no live adapter or renderer instances");
  });

  test("renderPluginList: aligned columns, all fields present", () => {
    const out = renderPluginList([
      { kind: "adapter", platformOrKind: "discord", instanceId: "discord:g1", bundleName: "in-tree", running: true },
      { kind: "renderer", platformOrKind: "pagerduty", instanceId: "pagerduty", bundleName: "acme-pagerduty", running: true },
    ]);
    expect(out).toContain("KIND");
    expect(out).toContain("discord");
    expect(out).toContain("discord:g1");
    expect(out).toContain("pagerduty");
    expect(out).toContain("acme-pagerduty");
  });
});

// =============================================================================
// resolvePrincipalIdForCli
// =============================================================================

describe("resolvePrincipalIdForCli", () => {
  test("returns the principal id when present", () => {
    expect(resolvePrincipalIdForCli({ id: "meta-factory" })).toBe("meta-factory");
  });

  test("throws a clear error when principal.id is missing (mirrors the daemon's own resolvePrincipalId)", () => {
    expect(() => resolvePrincipalIdForCli(undefined)).toThrow(/principal\.id/);
    expect(() => resolvePrincipalIdForCli({ id: "" })).toThrow(/principal\.id/);
  });
});
