/**
 * G-1113.D.5b — GitHub WorkItemSource adapter: sub-issue → WorkItem
 * normalization, phase mapping, and honest no-ops, with an injected `gh` fake.
 */
import { describe, it, expect } from "bun:test";
import { GithubWorkItemSource } from "../adapters/github/work-items";
import type { GhSpawnFn } from "../adapters/github/fetch";
import type { Plan, PlanPhase } from "../types";
import type { WorkItemSourceContext as Ctx } from "../adapters/work-item-source";

function fakeSpawn(stdout: string, code = 0, stderr = ""): GhSpawnFn {
  return () => ({
    stdout: new Response(stdout).body as ReadableStream<Uint8Array>,
    stderr: new Response(stderr).body as ReadableStream<Uint8Array>,
    exited: Promise.resolve(code),
    kill: () => {},
  });
}

const plan = (over: Partial<Plan> = {}): Plan => ({
  id: "plan-mission-control-cockpit",
  title: "Cockpit",
  kind: "design",
  sourceDocumentUrl: null,
  provider: "internal",
  externalId: null,
  umbrellaWorkItemId: "the-metafactory/cortex#354",
  status: "active",
  ...over,
});

const phases: PlanPhase[] = [
  { id: "plan-mission-control-cockpit-phase-c", planId: "plan-mission-control-cockpit", title: "C", order: 2, status: "done" },
  { id: "plan-mission-control-cockpit-phase-d", planId: "plan-mission-control-cockpit", title: "D", order: 3, status: "active" },
];

function ctx(p: Plan): Ctx {
  return { plan: p, phases };
}

describe("GithubWorkItemSource (D.5b)", () => {
  it("normalizes sub-issues → WorkItems with phase mapping + open/closed status", async () => {
    const subIssuesJson = JSON.stringify([
      { number: 581, title: "G-1113.D.4 — Phase detail view", state: "open", html_url: "https://github.com/the-metafactory/cortex/issues/581", labels: [{ name: "feature" }] },
      { number: 556, title: "G-1113.C.3 — PRs + reviews", state: "closed", html_url: "https://github.com/the-metafactory/cortex/issues/556", labels: ["feature"] },
      { number: 999, title: "Untagged work with no phase token", state: "open", html_url: "https://github.com/the-metafactory/cortex/issues/999", labels: [] },
    ]);
    const src = new GithubWorkItemSource({ spawn: fakeSpawn(subIssuesJson) });
    const items = await src.fetchWorkItems(ctx(plan()));

    expect(items.map((w) => [w.id, w.phaseId, w.status])).toEqual([
      ["the-metafactory/cortex#581", "plan-mission-control-cockpit-phase-d", "open"],
      ["the-metafactory/cortex#556", "plan-mission-control-cockpit-phase-c", "closed"],
      ["the-metafactory/cortex#999", null, "open"], // no phase token → unphased (no guess)
    ]);
    // externalId == id (owner/repo#N bijection); provider github; url passthrough.
    expect(items[0]?.externalId).toBe("the-metafactory/cortex#581");
    expect(items[0]?.provider).toBe("github");
    expect(items[0]?.url).toBe("https://github.com/the-metafactory/cortex/issues/581");
    expect(items.every((w) => w.planId === "plan-mission-control-cockpit")).toBe(true);
  });

  it("phase mapping is strict: incidental prose letters don't mis-file (false-positive guard)", async () => {
    const json = JSON.stringify([
      // Incidental ' c ' in prose must NOT pull this into phase C — the slice
      // token .D.4 wins, and the bare 'c' is ignored.
      { number: 1, title: "G-1113.D.4 — fix the c compiler warning", state: "open", html_url: "https://x/1" },
      // Bare letter in prose, no slice token, no "Phase X" → unphased (not phase C).
      { number: 2, title: "Refactor the c module", state: "open", html_url: "https://x/2" },
      // Explicit prose form maps.
      { number: 3, title: "Phase C cleanup", state: "open", html_url: "https://x/3" },
    ]);
    const src = new GithubWorkItemSource({ spawn: fakeSpawn(json) });
    const items = await src.fetchWorkItems(ctx(plan()));
    expect(items.map((w) => [w.id, w.phaseId])).toEqual([
      ["the-metafactory/cortex#1", "plan-mission-control-cockpit-phase-d"], // .D.4 wins, not ' c '
      ["the-metafactory/cortex#2", null], // incidental 'c' ignored
      ["the-metafactory/cortex#3", "plan-mission-control-cockpit-phase-c"], // prose "Phase C"
    ]);
  });

  it("ambiguous title citing two phases → unphased (null), never first-wins", async () => {
    const json = JSON.stringify([
      { number: 9, title: "G-1113.C.3 follow-up rolled into G-1113.D.4", state: "open", html_url: "https://x/9" },
    ]);
    const src = new GithubWorkItemSource({ spawn: fakeSpawn(json) });
    const items = await src.fetchWorkItems(ctx(plan()));
    expect(items[0]?.phaseId).toBeNull();
  });

  it("no umbrella link → honest empty (never guesses)", async () => {
    const src = new GithubWorkItemSource({ spawn: fakeSpawn("[]") });
    expect(await src.fetchWorkItems(ctx(plan({ umbrellaWorkItemId: null })))).toEqual([]);
  });

  it("unparseable umbrella link → empty", async () => {
    const src = new GithubWorkItemSource({ spawn: fakeSpawn("[]") });
    expect(await src.fetchWorkItems(ctx(plan({ umbrellaWorkItemId: "not a ref" })))).toEqual([]);
  });

  it("gh fetch error → empty (best-effort, persists nothing)", async () => {
    const src = new GithubWorkItemSource({ spawn: fakeSpawn("", 1, "HTTP 404: Not Found") });
    expect(await src.fetchWorkItems(ctx(plan()))).toEqual([]);
  });

  it("skips malformed sub-issue rows rather than failing the batch", async () => {
    const json = JSON.stringify([
      { number: 1, title: "G-1113.D.1 — ok", state: "open", html_url: "https://x/1" },
      { title: "missing number" },
      { number: 2 }, // missing title/state/url
    ]);
    const src = new GithubWorkItemSource({ spawn: fakeSpawn(json) });
    const items = await src.fetchWorkItems(ctx(plan()));
    expect(items.map((w) => w.id)).toEqual(["the-metafactory/cortex#1"]);
  });
});
