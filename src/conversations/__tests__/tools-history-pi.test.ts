import { expect, test } from "bun:test";
import { join } from "node:path";
import { discoverPi, piTurns } from "../pi";
import { DECISION_KIND } from "../types";
import { openHost, scratchHosts } from "./fixtures/scratch";
import { toolProvider } from "./fixtures/tool-provider";

const { dirs, hosts } = scratchHosts("history-installed-pi-");
const pi = discoverPi();

test.skipIf(!pi)("installed Pi retrieves a cited decision without local-policy title, snippet or count leaks", async () => {
  const dir = await dirs.make();
  const provider = await toolProvider(dir, pi!);
  const host = await openHost(hosts, { dir: join(dir, "store"), stack: "test", label: "test", expectedLabel: "test", lanes: { cloud: { provider: "synthetic", model: "cloud" }, local: { provider: "synthetic", model: "local" } }, turns: piTurns(provider.settings) });
  const principal = "synthetic-principal";
  const start = (title: string, policy: "local" | "cloud") => host.create({ title, policy, links: [], origin: { kind: "web" } }, principal);
  try {
    const allowed = await start("Authorized synthetic probe", "cloud");
    const hidden = await start("INACCESSIBLE_PROBE_TITLE", "local");
    const date = "2026-11-02T12:00:00.000Z";
    await host.record(allowed.id, "decision", DECISION_KIND, { text: "earlier decision: choose blue", at: date });
    await host.record(hidden.id, "decision", DECISION_KIND, { text: "earlier decision: INACCESSIBLE_PROBE_EVIDENCE", at: date });
    const entry = await host.latestEntryId(allowed.id);
    const original = await host.entries(allowed.id, 100, undefined);
    const reader = await start("Synthetic history reader", "cloud");
    provider.steps.push([{ id: "find", name: "conversation_search", input: { query: "earlier decision" } }], [{ id: "read", name: "conversation_read", input: { conversation: allowed.id, entry } }], "The earlier decision chose blue.");
    await host.submit(reader.id, { inputId: "probe", transport: "web", text: "Find the earlier decision and cite it.", mode: "queue" });
    await host.waitForIdle(reader.id);
    expect(await host.input(reader.id, "probe")).toMatchObject({ status: "done", answer: "The earlier decision chose blue." });
    const activities = (await host.entries(reader.id, 100, undefined)).entries.filter(e => e.kind === "cortex.tool-activity").map(e => e.data) as { tool: string; outcome: string; result: string }[];
    const search = activities.find(e => e.tool === "conversation_search");
    expect(search?.outcome).toBe("done");
    const parsed = JSON.parse(search!.result.split("\n").slice(1, -2).join("\n"));
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.next).toBeNull();
    expect(parsed.matches[0].entry).toEqual({ id: String(entry), kind: DECISION_KIND, at: date, url: `/api/conversations/${allowed.id}/entries/${entry}` });
    expect(activities.find(e => e.tool === "conversation_read")).toMatchObject({ outcome: "done", result: expect.stringContaining("choose blue") });
    expect(JSON.stringify(provider.requests)).not.toContain("INACCESSIBLE_PROBE");
    expect(JSON.stringify(activities)).not.toContain(hidden.id);
    expect(await host.entries(allowed.id, 100, undefined)).toEqual(original);
    await host.organize(allowed.id, { state: "archived" });
    await host.organize(hidden.id, { state: "archived" });
    await host.organize(reader.id, { state: "archived" });
    expect((await host.list()).every(c => c.state === "archived")).toBe(true);
  } finally {
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    await provider.close();
  }
}, 60_000);
