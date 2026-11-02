import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { openConversationHost, type HostStatus } from "../../../conversations/host";
import { scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import { fixtureOwner } from "../../../conversations/__tests__/fixtures/owner";
import type { Capability, CreationView, ProposalView } from "../../../conversations/creation";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { CreationSection } from "../dashboard-v2/components/desk-conversation-create";

const LABEL = "ai.meta-factory.cortex.creation-test";
const OTHER = { "cf-access-authenticated-user-email": "someone-else@example.invalid" };
const dirs = scratchDirs("conversation-creation-");
const statuses: HostStatus[] = [];
afterEach(async () => {
  for (const status of statuses.splice(0)) if (status.state === "ready") await status.host.close().catch(() => undefined);
  await dirs.clean();
});

const guard = (): MutationGuardContext => ({ isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() });
async function rig() {
  const owner = fixtureOwner();
  const status = await openConversationHost({ dir: await dirs.make(), stack: "api", label: LABEL, expectedLabel: LABEL, endpoints: { cloud: { baseUrl: "http://x.invalid", model: "m", timeoutSeconds: 5 } }, chat: () => Promise.resolve("ok") });
  statuses.push(status);
  if (status.state !== "ready") throw new Error(status.reason);
  await status.host.attachSources({ resolvers: {}, readbacks: {}, writers: { "graph-node": owner.writer, routine: owner.writer } });
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
    expect(caps.body.types?.find(t => t.type === "balance-task")?.status).toBe("blocked:2972");
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
    expect(html).toContain("Pulse has no place to save a flow without running it yet.");
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
});
