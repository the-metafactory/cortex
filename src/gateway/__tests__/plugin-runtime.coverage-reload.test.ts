/**
 * cortex#2504 — the ADR-0024 §OQ9 coverage floor must be re-enforced on
 * runtime mutation, not only at boot.
 *
 * ## The gap these tests close
 *
 * `assertRuntimeSystemCoverage` runs once, at boot. ADR-0024 D8 then reversed
 * "renderers are static across hot-reload", so a live stack can drop below the
 * floor without ever restarting: detach the only `paging` renderer and what is
 * left is an inert `local-projection` that delivers nothing. The daemon keeps
 * running and reports healthy while silently unable to page — the *silent
 * no-page* failure §OQ9 ratified moving away from, re-entering through the
 * reload door rather than the boot door.
 *
 * ## Refuse the mutation, do not kill the daemon
 *
 * Boot hard-fails because there is no prior good state to keep. At runtime
 * there is one — the config currently serving the principal — so the mutation
 * is rejected and the live set is left untouched. Killing a running daemon
 * over a mistyped unload would trade a monitoring gap for an outage.
 */

import { describe, expect, test } from "bun:test";
import {
  unloadLivePlugin,
  type PluginRuntimeDeps,
  type RendererHandle,
} from "../plugin-runtime";

const SYS = ["local.{principal}.system.>"];
const CTX = { principal: "andreas" } as const;

function handle(kind: string, subscribe: readonly string[] = SYS): RendererHandle {
  return {
    renderer: {
      kind,
      // eslint-disable-next-line @typescript-eslint/require-await
      stop: async () => {},
    } as unknown as RendererHandle["renderer"],
    unregister: () => {},
    bundleName: "in-tree",
    rendererKind: kind,
    config: { kind, subscribe },
  };
}

function deps(handles: Record<string, RendererHandle>): PluginRuntimeDeps {
  return {
    adapters: [],
    rendererHandles: new Map(Object.entries(handles)),
    router: { register: () => ({ unregister: () => {} }) },
    skippedRendererConfigs: new Map(),
    registry: { listRenderers: () => [] } as unknown as PluginRuntimeDeps["registry"],
    pluginSigning: "off" as PluginRuntimeDeps["pluginSigning"],
    pluginTrustedSigners: [],
    coverageCtx: CTX,
  } as unknown as PluginRuntimeDeps;
}

describe("unload re-enforces the §OQ9 coverage floor (cortex#2504)", () => {
  test("detaching the only paging sink is REFUSED", () => {
    // The scenario the rule names verbatim: a principal hot-removes the only
    // `paging` renderer, leaving an inert `local-projection`.
    const d = deps({ dashboard: handle("dashboard"), pagerduty: handle("pagerduty") });
    return unloadLivePlugin(d, "pagerduty").then((res) => {
      expect(res.ok).toBe(false);
      expect(res.detail).toContain("refused");
      expect(res.detail).toContain("§OQ9");
      // And the live set is genuinely untouched — not detached-then-reported.
      expect(d.rendererHandles.has("pagerduty")).toBe(true);
      expect(d.rendererHandles.size).toBe(2);
    });
  });

  test("the refusal says the daemon kept running and how to proceed", () => {
    const d = deps({ dashboard: handle("dashboard"), pagerduty: handle("pagerduty") });
    return unloadLivePlugin(d, "pagerduty").then((res) => {
      expect(res.detail).toContain("live configuration is unchanged");
      expect(res.detail).toContain("Attach a replacement sink");
    });
  });

  test("detaching a redundant sink is ALLOWED", () => {
    // Three sinks, two classes remain after the removal → still covered.
    const d = deps({
      dashboard: handle("dashboard"),
      pagerduty: handle("pagerduty"),
      spare: handle("opsgenie"),
    });
    return unloadLivePlugin(d, "spare").then((res) => {
      expect(res.ok).toBe(true);
      expect(d.rendererHandles.has("spare")).toBe(false);
    });
  });

  test("a renderer that does not cover system.> can always be detached", () => {
    // Out of scope for the rule — removing it cannot affect system coverage.
    const d = deps({
      dashboard: handle("dashboard"),
      pagerduty: handle("pagerduty"),
      reviews: handle("webhook-out", ["local.{principal}.review.>"]),
    });
    return unloadLivePlugin(d, "reviews").then((res) => {
      expect(res.ok).toBe(true);
    });
  });

  test("a stack that never opted into system alerting is unaffected", () => {
    // No system-covering renderer at all ⇒ out of scope ⇒ unload proceeds.
    const d = deps({ a: handle("dashboard", ["local.{principal}.review.>"]) });
    return unloadLivePlugin(d, "a").then((res) => {
      expect(res.ok).toBe(true);
    });
  });

  test("without a coverageCtx it degrades to the old behaviour, loudly", () => {
    // A caller that never wired the context must not crash — but the skipped
    // check has to be visible, not look like a passing one.
    const d = deps({ dashboard: handle("dashboard"), pagerduty: handle("pagerduty") });
    delete (d as { coverageCtx?: unknown }).coverageCtx;
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
    return unloadLivePlugin(d, "pagerduty")
      .then((res) => {
        expect(res.ok).toBe(true); // pre-#2504 behaviour
        expect(warnings.join("\n")).toContain("cortex#2504");
      })
      .finally(() => {
        console.warn = orig;
      });
  });
});
