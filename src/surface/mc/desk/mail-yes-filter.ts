import type { Database } from "bun:sqlite";
import { z } from "zod";
import { loadBalanceState } from "./balance-store";
import type { OutlineNode } from "../../../balance";
import type { DeskOptions } from "./compose";
import { readStudioFiles } from "./studio/read";
import { buildStudioView, DEFAULT_YES_FILTER } from "./studio/view";
import type { ListedMail, MailActionResult } from "./mail-actions";

export const CommitmentSchema = z.object({ kind: z.enum(["thread", "project"]), id: z.string().min(1).max(300), label: z.string().max(10000) }).strict();
export type Commitment = z.infer<typeof CommitmentSchema>;
export const MailDecisionSchema = z.object({ requestId: z.uuid(), intent: z.enum(["reply", "decline"]), commitment: CommitmentSchema.nullable() }).strict();
export type MailDecision = z.infer<typeof MailDecisionSchema>;
export interface MailYesFilter { questions: string[]; commitments: Commitment[]; problems: string[] }

const DecisionStatusSchema = z.enum(["pending", "saved", "failed", "uncertain"]);
export type MailDecisionSummary = Pick<MailDecision, "intent" | "commitment"> & { status: z.infer<typeof DecisionStatusSchema> };

export function readMailDecision(db: Database, source: string, messageId: string): MailDecisionSummary | undefined {
  const row = db.query<{ binding: string; status: string }, [string, string]>("SELECT binding, status FROM desk_mail_decisions WHERE json_extract(binding, '$.source') = ? AND json_extract(binding, '$.messageId') = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(source, messageId);
  if (!row) return undefined;
  const stored = z.object({ decision: MailDecisionSchema }).parse(JSON.parse(row.binding));
  return { intent: stored.decision.intent, commitment: stored.decision.commitment, status: DecisionStatusSchema.parse(row.status) };
}

export async function mailYesFilter(db: Database, desk: DeskOptions, now: number): Promise<MailYesFilter> {
  const commitments: Commitment[] = [];
  const problems: string[] = [];
  if (desk.studio) {
    const read = await readStudioFiles(desk.studio.dir);
    const view = buildStudioView(read.files, desk.studio, desk.areas, read.problems);
    commitments.push(...view.active.map(t => ({ kind: "thread" as const, id: t.slug, label: t.question })));
    if (view.problems.length) problems.push("Some Studio commitments could not be read. Refresh before choosing.");
  }
  try {
    const state = loadBalanceState(db);
    const date = new Date(now);
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const visit = (node: OutlineNode): void => {
      if (node.done) return;
      if (node.focusMonth === month) commitments.push({ kind: "project", id: node.id, label: node.title });
      node.children.forEach(visit);
    };
    state?.outline.children.forEach(visit);
  } catch {
    problems.push("Focus projects could not be read. Refresh before choosing.");
  }
  return { questions: desk.studio?.yesFilter?.length ? [...desk.studio.yesFilter] : [...DEFAULT_YES_FILTER], commitments, problems };
}

export function decisionReceipt(db: Database, key: string, body: string, decision: MailDecision): MailActionResult | null {
  const prior = db.query<{ binding: string; status: string; result: string | null }, [string]>("SELECT binding, status, result FROM desk_mail_decisions WHERE id = ?").get(decision.requestId);
  if (!prior) return null;
  const stored = z.object({ messageId: z.string(), body: z.string(), decision: MailDecisionSchema }).parse(JSON.parse(prior.binding));
  if (`mail:${stored.messageId}` !== key || stored.body !== body || JSON.stringify(stored.decision) !== JSON.stringify(decision)) return { ok: false, status: 409, error: "This draft changed. Start a new draft before saving it." };
  if (prior.status === "saved") return { ok: true, message: prior.result ?? "The reply draft is already saved." };
  if (prior.status !== "failed") return { ok: false, status: 409, error: "This draft may already be saved. Check Drafts before starting another." };
  return null;
}

export async function saveDecisionDraft(input: { db: Database; desk: DeskOptions; mail: ListedMail; body: string; decision: MailDecision; now: number; save: () => Promise<MailActionResult> }): Promise<MailActionResult> {
  const { db, desk, mail, body, decision, now, save } = input;
  const receipt = decisionReceipt(db, `mail:${mail.id}`, body, decision);
  if (receipt) return receipt;
  const binding = JSON.stringify({ source: mail.sourceId, account: mail.account, messageId: mail.id, body, decision });
  const current = await mailYesFilter(db, desk, now);
  const selected = decision.commitment;
  if (selected && !current.commitments.some(c => c.kind === selected.kind && c.id === selected.id && c.label === selected.label)) return { ok: false, status: 409, error: "That commitment is no longer current. Refresh and choose again; your reply is retained." };
  const acquired = db.transaction((): MailActionResult | null => {
    const prior = db.query<{ binding: string; status: string; result: string | null }, [string]>("SELECT binding, status, result FROM desk_mail_decisions WHERE id = ?").get(decision.requestId);
    if (prior) {
    if (prior.binding !== binding) return { ok: false, status: 409, error: "This draft changed. Start a new draft before saving it." };
    if (prior.status === "saved") return { ok: true, message: prior.result ?? "The reply draft is already saved." };
    if (prior.status !== "failed") return { ok: false, status: 409, error: "This draft may already be saved. Check Drafts before starting another." };
  }
    db.query("INSERT INTO desk_mail_decisions (id, binding, status, result, created_at) VALUES (?, ?, 'pending', NULL, ?) ON CONFLICT(id) DO UPDATE SET status = 'pending', result = NULL").run(decision.requestId, binding, now);
    return null;
  })();
  if (acquired) return acquired;
  const result = await save();
  db.query("UPDATE desk_mail_decisions SET status = ?, result = ? WHERE id = ?").run(result.ok ? "saved" : result.status >= 500 ? "uncertain" : "failed", result.ok ? result.message : result.error, decision.requestId);
  return !result.ok && result.status >= 500 ? { ...result, error: "The draft outcome is uncertain. Check Drafts before starting another." } : result;
}
