import type { Database } from "bun:sqlite";
import { DEFAULT_RESULT_BASE_URL } from "../common/result-base-url";
import type { VigilRefRow } from "./ref-attention";
import type { ResultRenderOptions } from "./result-render";
import { readSomaProposalTitle } from "./soma-output";

export interface VigilProposalRow extends VigilRefRow {
  proposal_ref: string;
  filing_error: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function getProposal(db: Database, ref: string): VigilProposalRow | null {
  return db.query<VigilProposalRow, [string]>("SELECT * FROM vigil_proposals WHERE proposal_ref = ?").get(ref);
}

export function getProposalByAttentionId(db: Database, attentionId: string): VigilProposalRow | null {
  return db.query<VigilProposalRow, [string]>("SELECT * FROM vigil_proposals WHERE attention_id = ?").get(attentionId);
}

export function setProposalFilingError(db: Database, attentionId: string, error: string | null): void {
  db.query("UPDATE vigil_proposals SET filing_error = ? WHERE attention_id = ?").run(error, attentionId);
}

export function openProposals(db: Database, now: number): VigilProposalRow[] {
  return db.query<VigilProposalRow, [number]>(`SELECT p.* FROM vigil_proposals p
    JOIN attention_items a ON a.id = p.attention_id
    WHERE a.status = 'open' AND p.expires_at > ? ORDER BY p.created_ended_at, p.proposal_ref`).all(now);
}

export async function proposalPresentation(proposal: VigilProposalRow, options: ResultRenderOptions): Promise<{ label: string; url: string }> {
  const label = (await readSomaProposalTitle(proposal.proposal_ref, options.somaHome)) ?? proposal.proposal_ref;
  const url = `${(options.resultBaseUrl ?? DEFAULT_RESULT_BASE_URL).replace(/\/$/, "")}/proposals/${encodeURIComponent(proposal.proposal_ref)}`;
  return { label, url };
}

export async function proposalDigestLines(
  proposals: VigilProposalRow[], now: number, lastDigest: number | null, options: ResultRenderOptions,
): Promise<string[]> {
  if (proposals.length === 0) return [];
  const lines: string[] = [];
  for (const proposal of proposals) {
    const reminderAt = proposal.expires_at - DAY_MS;
    const expiresTomorrow = now >= reminderAt && (lastDigest === null || lastDigest < reminderAt);
    if (proposal.digested_version !== 0 && !expiresTomorrow) continue;
    const { label, url } = await proposalPresentation(proposal, options);
    if (proposal.digested_version === 0) lines.push(`${label} — ${url}`);
    if (expiresTomorrow) lines.push(`expires tomorrow: ${label}`);
  }
  const oldest = Math.max(0, Math.floor((now - Math.min(...proposals.map((proposal) => proposal.created_ended_at))) / DAY_MS));
  lines.push(`waiting for your answer: ${proposals.length} proposals, oldest ${oldest}d`);
  return lines;
}
