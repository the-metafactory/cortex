/**
 * ML.2 — cockpit-refresh CLI: arg parsing + run wiring (deps injected).
 */
import { describe, it, expect } from "bun:test";
import {
  parseCockpitRefreshArgs,
  runCockpitRefresh,
  type CockpitRefreshDeps,
} from "../cockpit-refresh";
import type { RefreshCockpitOptions, RefreshResult } from "../../surface/mc/refresh";

describe("parseCockpitRefreshArgs (ML.2)", () => {
  it("parses --docs / --stack / --repo / --db", () => {
    const a = parseCockpitRefreshArgs(["--docs", "./docs", "--stack", "laptop", "--repo", "the-metafactory/cortex", "--db", "/tmp/mc.db"]);
    expect(a).toEqual({ docsDir: "./docs", stackId: "laptop", repo: { owner: "the-metafactory", repo: "cortex" }, dbPath: "/tmp/mc.db" });
  });

  it("requires --docs and --stack", () => {
    expect(parseCockpitRefreshArgs(["--stack", "x"])).toEqual({ error: "--docs <dir> is required" });
    expect(parseCockpitRefreshArgs(["--docs", "d"])).toEqual({ error: "--stack <id> is required" });
  });

  it("rejects a malformed --repo", () => {
    const r = parseCockpitRefreshArgs(["--docs", "d", "--stack", "s", "--repo", "justname"]);
    expect("error" in r && r.error).toContain("owner/name");
  });

  it("repo is optional", () => {
    expect(parseCockpitRefreshArgs(["--docs", "d", "--stack", "s"])).toEqual({
      docsDir: "d", stackId: "s", repo: undefined, dbPath: undefined,
    });
  });
});

describe("runCockpitRefresh (ML.2)", () => {
  const RESULT: RefreshResult = { plans: 2, workItems: 3, unsupportedProviders: 1, failedPlans: 0, attentionOpen: 1, notifiedOpened: 0, notifiedResolved: 0 };

  it("opens the db at the given path and threads parsed opts into refresh", async () => {
    const openedPaths: string[] = [];
    const calls: RefreshCockpitOptions[] = [];
    const deps: CockpitRefreshDeps = {
      openDb: (p) => { openedPaths.push(p); return {} as never; },
      refresh: async (_db, opts) => { calls.push(opts); return RESULT; },
    };
    const out = await runCockpitRefresh(["--docs", "/repo/docs", "--stack", "laptop", "--repo", "the-metafactory/cortex", "--db", "/tmp/x.db"], deps);
    expect(out.code).toBe(0);
    expect(out.result).toEqual(RESULT);
    expect(openedPaths).toEqual(["/tmp/x.db"]);
    const opts = calls[0];
    expect(opts?.docsDir).toBe("/repo/docs");
    expect(opts?.stackId).toBe("laptop");
    expect(opts?.defaultRepo).toEqual({ owner: "the-metafactory", repo: "cortex" });
    // urlForPath builds a github blob URL from the repo.
    expect(opts?.urlForPath?.("docs/plan-x.md")).toBe(
      "https://github.com/the-metafactory/cortex/blob/main/docs/plan-x.md"
    );
  });

  it("returns code 2 + error on a usage problem (no db opened, no refresh run)", async () => {
    let opened = false;
    const out = await runCockpitRefresh(["--stack", "x"], {
      openDb: () => { opened = true; return {} as never; },
      refresh: async () => RESULT,
    });
    expect(out.code).toBe(2);
    expect(out.error).toContain("--docs");
    expect(opened).toBe(false);
  });
});
