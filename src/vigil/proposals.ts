import type { Database } from "bun:sqlite";
import type { VigilRefRow } from "./ref-attention";
import { DEFAULT_RESULT_BASE_URL, type ResultRenderOptions } from "./result-render";
import { readSomaFile, somaFileTitle } from "./soma-output";

export interface VigilProposalRow extends VigilRefRow {
  proposal_ref: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function openProposals(db: Database, now: number): VigilProposalRow[] {
  return db.query<VigilProposalRow, [number]>(`SELECT p.* FROM vigil_proposals p
    JOIN attention_items a ON a.id = p.attention_id
    WHERE a.status = 'open' AND p.expires_at > ? ORDER BY p.created_ended_at, p.proposal_ref`).all(now);
}

export async function proposalPresentation(proposal: VigilProposalRow, options: ResultRenderOptions): Promise<{ label: string; url: string }> {
  const content = await readSomaFile(proposal.proposal_ref, "proposals", options.somaHome);
  const label = somaFileTitle(content, proposal.proposal_ref);
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
