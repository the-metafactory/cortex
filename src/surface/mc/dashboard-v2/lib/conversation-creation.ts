import type { Capability, CreationView, Feedback, Grant, GrantScope, ProposalView } from "../../../../conversations/creation";
import { ApiFailure, getJson } from "./api";

export type { Capability, CreationView, Feedback, Grant, GrantScope, ProposalView };

const BASE = "/api/conversations";

export const readCapabilities = (signal?: AbortSignal): Promise<{ types: Capability[] }> => getJson(`${BASE}/capabilities`, signal ? { signal } : {});
export const readCreation = (id: string, signal?: AbortSignal): Promise<CreationView> => getJson(`${BASE}/${id}/proposals`, signal ? { signal } : {});

async function send(path: string, method: string, body?: object): Promise<ProposalView> {
  let res: Response;
  try { res = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch (error) { throw new ApiFailure({ status: 0, message: error instanceof Error ? error.message : String(error) }); }
  const reply = await res.json().catch(() => null) as { proposal?: ProposalView; error?: string } | null;
  if (reply?.proposal) return reply.proposal;
  throw new ApiFailure({ status: res.status, message: reply?.error ?? `HTTP ${res.status}` });
}

export const propose = (id: string, body: { proposalId: string; type?: string; intent?: string; fields: Record<string, string>; entryId?: string }): Promise<ProposalView> =>
  send(`${BASE}/${id}/proposals`, "POST", body);
export const revise = (id: string, proposalId: string, body: { revision: number; type?: string; fields?: Record<string, string>; dismiss?: true }): Promise<ProposalView> =>
  send(`${BASE}/${id}/proposals/${proposalId}`, "PATCH", body);
export const confirm = (id: string, proposalId: string, body: { revision: number; digest: string; grant?: { scope: GrantScope } }): Promise<ProposalView> =>
  send(`${BASE}/${id}/proposals/${proposalId}/confirm`, "POST", body);
export const check = (id: string, proposalId: string): Promise<ProposalView> => send(`${BASE}/${id}/proposals/${proposalId}/check`, "POST");
export const revoke = (grantId: string): Promise<{ grant: Grant }> => getJson(`${BASE}/grants/${grantId}`, { method: "DELETE" });

export function feedbackLabel(view: ProposalView): string {
  const label = view.capability?.label ?? "object";
  switch (view.feedback) {
    case "choose": return "Proposal · choose what to create";
    case "unavailable": return `Proposed ${label} · unavailable here`;
    case "proposed": return `Proposed ${label} · nothing written yet`;
    case "accepted": return `${label} · accepted, waiting for the owner`;
    case "created": return `${label} · created`;
    case "failed": return `${label} · not created`;
    case "uncertain": return `${label} · not confirmed yet`;
    default: return `${label} · dismissed`;
  }
}

