import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { openConversationHost } from "../../../conversations/host";
import { answering, scratchHosts } from "../../../conversations/__tests__/fixtures/scratch";
import { fixtureOwner } from "../../../conversations/__tests__/fixtures/owner";
import type { Capability, CreationView, ProposalView } from "../../../conversations/creation";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { CreationSection } from "../dashboard-v2/components/desk-conversation-create";
import { DEFAULT_CHECKPOINT, prefillFields } from "../dashboard-v2/components/desk-conversation-graph-fields";
import { CREATION_CATALOG } from "../../../conversations/catalog";

const LABEL = "ai.meta-factory.cortex.creation-test";
const OTHER = { "cf-access-authenticated-user-email": "someone-else@example.invalid" };
const { dirs, hosts } = scratchHosts("conversation-creation-");

const guard = (): MutationGuardContext => ({ isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() });
async function rig(balance = false) {
  const owner = fixtureOwner();
  const status = await openConversationHost({ dir: await dirs.make(), stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(() => "ok") });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  await status.host.attachSources({ resolvers: {}, readbacks: {}, writers: { "graph-node": owner.writer, routine: owner.writer, ...(balance ? { "balance-task": owner.writer } : {}) } });
  const raw = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard(), () => status);
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Reply }> => {
    const res = await raw(method, path, body, headers);
    return { status: res.status, body: await res.json() as Reply };
  };
  const { body } = await call("POST", "/api/conversations", { title: "Synthetic creation probe", origin: { kind: "web" } });
  return { owner, call, id: body.conversation?.id ?? "" };
}
const node = { repository: "example/synthetic", parent: "1", title: "Synthetic node", checkpoint: "synthetic" };
interface Reply extends Partial<CreationView> { conversation?: { id: string }; proposal?: ProposalView; types?: Capability[]; grant?: { revokedAt?: string }; error?: string }

describe("conversation creation API", () => {
  test("proposal, edit and confirmation run through the gated routes with one fixture effect per operation", async () => {
    const { owner, call, id } = await rig();
    const caps = await call("GET", "/api/conversations/capabilities");
    expect(caps.status).toBe(200);
    expect(caps.body.types?.find(t => t.type === "graph-node")?.status).toBe("ready");
    expect(caps.body.types?.find(t => t.type === "balance-task")?.status).toBe("blocked:3030");
    const proposalId = randomUUID();
    const made = await call("POST", `/api/conversations/${id}/proposals`, { proposalId, type: "graph-node", fields: { ...node, title: "Draft" } });
    expect(made.status).toBe(201);
    expect((await call("POST", `/api/conversations/${id}/proposals`, { proposalId, type: "graph-node", fields: { ...node, title: "Draft" } })).status).toBe(200);
    expect((await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "settings" })).status).toBe(409);
    expect((await call("POST", `/api/conversations/${id}/proposals`, { proposalId: "nope" })).status).toBe(400);
    const edited = await call("PATCH", `/api/conversations/${id}/proposals/${proposalId}`, { revision: 1, fields: node });
    expect(edited.body.proposal?.proposal.revision).toBe(2);
    expect((await call("PATCH", `/api/conversations/${id}/proposals/${proposalId}`, { revision: 1, fields: node })).status).toBe(409);
    const confirmation = { revision: 2, digest: edited.body.proposal?.digest };
    expect((await call("POST", `/api/conversations/${id}/proposals/${proposalId}/confirm`, confirmation, OTHER)).status).toBe(403);
    expect((await call("POST", `/api/conversations/${id}/proposals/${proposalId}/confirm`, confirmation, { host: "rebound.example:8767" })).status).toBe(403);
    expect((await call("POST", `/api/conversations/${id}/proposals/${proposalId}/confirm`, { revision: 2, digest: made.body.proposal?.digest })).status).toBe(409);
    const done = await call("POST", `/api/conversations/${id}/proposals/${proposalId}/confirm`, { ...confirmation, grant: {} });
    expect(done.status).toBe(200);
    expect(done.body.proposal?.operation).toMatchObject({ state: "created", canonicalId: "fixture-1" });
    const again = await call("POST", `/api/conversations/${id}/proposals/${proposalId}/confirm`, confirmation);
    expect(again.body.proposal?.operation).toEqual(done.body.proposal?.operation);
    expect(owner.effects).toHaveLength(1);
    const grants = await call("GET", "/api/conversations/grants");
    expect(grants.body.grants).toEqual([expect.objectContaining({ scope: "conversation" })]);
    const grantId = grants.body.grants?.[0]?.grantId ?? "";
    expect((await call("DELETE", `/api/conversations/grants/${grantId}`, undefined, OTHER)).status).toBe(403);
    expect((await call("DELETE", `/api/conversations/grants/${grantId}`)).body.grant?.revokedAt).toBeString();
    expect((await call("GET", `/api/conversations/${id}/proposals`, undefined, OTHER)).status).toBe(403);
    const listed = await call("GET", `/api/conversations/${id}/proposals`);
    expect(listed.body.proposals?.map(p => p.feedback)).toEqual(["created"]);
    expect(listed.body.grants?.[0]?.revokedAt).toBeString();
  });

  test("workspace A renders an editable proposal card, unavailable types and revocable grants", async () => {
    const { call, id } = await rig();
    const { body: caps } = await call("GET", "/api/conversations/capabilities");
    const routine = await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "routine", fields: { name: "Weekly prep", target: "t", schedule: "weekly", timezone: "Europe/Zurich" } });
    await call("POST", `/api/conversations/${id}/proposals/${routine.body.proposal?.proposal.proposalId}/confirm`, { revision: 1, digest: routine.body.proposal?.digest, grant: { scope: "global" } });
    await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "flow", fields: { name: "Prep flow" } });
    await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "graph-node", fields: { title: "Prepare a practical workshop exercise" } });
    await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), intent: "card", fields: { title: "Workshop idea" } });
    const { body: view } = await call("GET", `/api/conversations/${id}/proposals`);
    const html = renderToStaticMarkup(<CreationSection id={id} archived={false} types={caps.types ?? []} view={{ proposals: view.proposals ?? [], grants: view.grants ?? [] }} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
    expect(html).toContain("Routine · created");
    expect(html).toContain("Created paused. Resuming it is a separate decision.");
    expect(html).toContain("Proposed Flow · unavailable here");
    expect(html).toContain("No Pulse writer is connected on this stack yet.");
    expect(html).toContain("Proposed Graph node · nothing written yet");
    expect(html).toContain("Fill in Repository, Parent node, Checkpoint before confirming.");
    expect(html).toContain("Create a graph node “Prepare a practical workshop exercise”.");
    expect(html).toContain("Choose what to create");
    expect(html).toContain("Balance task · unavailable");
    expect(html).not.toContain("Settings and status views");
    expect(html).toContain("Routine · all your conversations");
    expect(html).toContain(">Revoke<");
    expect(html).toContain(">Card…<");
    expect(html.match(/>Confirm creation</g)).toHaveLength(1);
    expect(html).toContain("objects already created stay as they are");
  });
  test("Balance proposals expose shared destination comboboxes independently of writer availability", async () => {
    const { call, id } = await rig();
    const { body: caps } = await call("GET", "/api/conversations/capabilities");
    await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "balance-task", fields: { title: "A local sketch" } });
    const { body: view } = await call("GET", `/api/conversations/${id}/proposals`);
    const html = renderToStaticMarkup(<CreationSection id={id} archived={false} types={caps.types ?? []} view={{ proposals: view.proposals ?? [], grants: [] }} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
    expect(html.match(/role="combobox"/g)).toHaveLength(2);
    expect(html).toContain("Loading Balance destinations");
    expect(html).toContain("Parent project");
    expect(html).toContain("unavailable here");
    expect(html).not.toContain('aria-label="Area" type="text"');
  });

  test("reopened created Balance tasks hide creation fields while unsubmitted and retryable proposals retain them", async () => {
    const { call, id } = await rig(true);
    const { body: caps } = await call("GET", "/api/conversations/capabilities");
    const made = await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "balance-task", fields: { title: "Make a paper glider", area: "work" } });
    const proposed = made.body.proposal;
    if (!proposed) throw new Error("Missing Balance proposal");
    const render = (proposals: ProposalView[]): string => renderToStaticMarkup(<CreationSection id={id} archived={false} types={caps.types ?? []} view={{ proposals, grants: [] }} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
    expect(render([proposed])).toContain('aria-label="Title"');
    expect(render([proposed])).toContain("Confirm creation");
    for (const feedback of ["failed", "uncertain", "accepted"] as const) {
      const html = render([{ ...proposed, feedback }]);
      expect(html).toContain('aria-label="Title"');
      expect(html).toContain(feedback === "failed" ? "Try again" : ">Check</button>");
    }
    await call("POST", `/api/conversations/${id}/proposals/${proposed.proposal.proposalId}/confirm`, { revision: proposed.proposal.revision, digest: proposed.digest });
    const reopened = await call("GET", `/api/conversations/${id}/proposals`);
    const html = render(reopened.body.proposals ?? []);
    expect(html).toContain("Balance task · created");
    expect(html).toContain("Loading saved Balance task");
    expect(html).not.toContain('aria-label="Title"');
    expect(html).not.toContain("Loading Balance destinations");
    expect(html).not.toContain("Confirm creation");
  });

  test("a standing grant the cutover lapsed is marked as needing renewal, and a renewed one names its connection and destination", async () => {
    const { call, id } = await rig();
    const { body: caps } = await call("GET", "/api/conversations/capabilities");
    const at = new Date().toISOString();
    const grant = (overrides: Record<string, unknown>): unknown => ({ grantId: "grant-0123456789abcdef0123456789abcdef", type: "balance-task", scope: "conversation", conversationId: id, principal: "local@example.invalid", operationId: "op-1", createdAt: at, ...overrides });
    const view = { proposals: [], grants: [grant({ renewal: { reason: "The balance-task writer now runs on a new connection binding. Confirm one creation again to renew the standing permission.", at } }), grant({ grantId: "grant-fedcba9876543210fedcba9876543210", connectionId: "connection-taxi", destinations: [{ objectType: "area", canonicalId: "area-example" }] })] };
    const html = renderToStaticMarkup(<CreationSection id={id} archived={false} types={caps.types ?? []} view={view as CreationView} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
    expect(html).toContain("needs renewal before the next creation");
    expect(html).toContain("Confirm one creation again to renew");
    expect(html).toContain("connection-taxi area-example");
    expect(html).toContain('data-renewal="needed"');
  });

});

describe("graph node destination fields", () => {
  const specs = CREATION_CATALOG["graph-node"].fields;
  const ticked = (...refs: string[]) => refs.map(ref => ({ ref, label: ref, forge: "github", enabled: true }));

  test("autonomy and kind offer only the values the writer accepts, and the card links the pickers", async () => {
    const { call, id } = await rig();
    const { body: caps } = await call("GET", "/api/conversations/capabilities");
    await call("POST", `/api/conversations/${id}/proposals`, { proposalId: randomUUID(), type: "graph-node", fields: { title: "Picker probe" } });
    const { body: view } = await call("GET", `/api/conversations/${id}/proposals`);
    const html = renderToStaticMarkup(<CreationSection id={id} archived={false} types={caps.types ?? []} view={{ proposals: view.proposals ?? [], grants: [] }} error={null} busy={false} seed={{ entryId: null, text: "" }} act={() => Promise.resolve()} />);
    const options = (label: string): string[] => [...(new RegExp(`<select aria-label="${label}[^"]*"[^>]*>(.*?)</select>`).exec(html)?.[1] ?? "").matchAll(/value="([^"]*)"/g)].map(m => m[1] ?? "");
    expect(options("Autonomy")).toEqual(["approve", "propose"]);
    expect(options("Kind")).toEqual(["grilling", "research", "prototype", "task", "build"]);
    expect(html).toMatch(/aria-label="Repository" list="[^"]+-repositories"/);
    expect(html).toMatch(/aria-label="Parent node" list="[^"]+-nodes"/);
    expect(html).toContain(`value="${DEFAULT_CHECKPOINT}"`);
  });

  test("prefill fills only empty fields, and recalls the last destination only while its repository is ticked", () => {
    const remembered = { repository: "github:github.com/example/a", parent: "42" };
    expect(prefillFields("graph-node", { title: "t" }, specs, ticked("github:github.com/example/a", "github:github.com/example/b"), remembered))
      .toEqual({ title: "t", autonomy: "approve", kind: "grilling", checkpoint: DEFAULT_CHECKPOINT, repository: "github:github.com/example/a", parent: "42" });
    expect(prefillFields("graph-node", { repository: "github:github.com/example/b", kind: "task", checkpoint: "mine" }, specs, ticked("github:github.com/example/a", "github:github.com/example/b"), remembered))
      .toEqual({ repository: "github:github.com/example/b", kind: "task", checkpoint: "mine", autonomy: "approve" });
    expect(prefillFields("graph-node", {}, specs, ticked("github:github.com/example/b"), remembered).repository).toBe("github:github.com/example/b");
    expect(prefillFields("graph-node", {}, specs, ticked("github:github.com/example/b", "github:github.com/example/c"), remembered).repository).toBeUndefined();
    expect(prefillFields("graph-node", {}, specs, null, remembered).repository).toBeUndefined();
  });
});
