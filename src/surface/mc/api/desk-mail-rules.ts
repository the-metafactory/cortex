import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { spawnWithStdin } from "../desk/create";
import { fail, noStore, type DeskMailDeps } from "./desk-mail";
import { answerProposal, createRule, DEFAULT_MAIL_RULES, deleteRule, editRule, proposalAction, releaseRule, ruleById, ruleViews, setRuleOn, undoRuleRun, type RuleChange, type RuleTarget } from "../desk/mail-rules";
import type { MoveResult } from "../desk/mail-move";
import { ruleAttach, ruleTargetOf } from "../desk/rule-attach";
import { STUDIO_SLUG } from "../desk/studio/format";

const Id = z.string().min(1).max(64);
const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), id: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal("thread"), slug: z.string().regex(STUDIO_SLUG) }).strict(),
]);
const Edit = { match: z.string(), value: z.string(), action: z.string(), target: TargetSchema.optional() };

const RuleRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["approve", "later", "never"]), proposal: z.string().min(1).max(400) }).strict(),
  z.object({ op: z.enum(["release", "stop", "start", "delete"]), rule: Id }).strict(),
  z.object({ op: z.literal("edit"), rule: Id, ...Edit }).strict(),
  z.object({ op: z.literal("create"), ...Edit }).strict(),
  z.object({ op: z.literal("undo"), run: Id }).strict(),
]);

type RuleBody = z.infer<typeof RuleRequestSchema>;

export type DeskMailRulesDeps = DeskMailDeps;

const NO_MOVE = "Mail rules that move mail need the move command (mc.desk.mail.actions.move), and it is not set up on this stack.";
const KEEPS_IN_MAILBOX = new Set<string>(["attach", "digest"]);

function actionOf(db: Database, body: RuleBody): string | null {
  if (body.op === "create" || body.op === "edit") return body.action;
  if (body.op === "approve") return proposalAction(body.proposal);
  if (body.op === "release" || body.op === "start") return ruleById(db, body.rule)?.action ?? null;
  return null;
}

async function targetOf(db: Database, desk: DeskOptions, target: z.infer<typeof TargetSchema>, now: number): Promise<RuleTarget | string> {
  const picked = await ruleTargetOf(db, desk, target, now);
  if (typeof picked !== "string") return picked;
  return target.kind === "task" ? "That task no longer exists or is done. Pick another one." : "That thread is no longer active. Pick another one.";
}

/**
 * GET lists the approved rules. POST {op: "approve" | "later" | "never", proposal} answers a proposal card;
 * {op: "release" | "stop" | "start" | "delete", rule} and {op: "edit", rule, match, value, action, target?} change a rule;
 * {op: "create", match, value, action, target?} adds a rule; an attach rule's target is {kind: "task", id} or {kind: "thread", slug}.
 * {op: "undo", run} takes back one rule run. Only rules that move mail need the move command. The rebind and identity gates in
 * handleApi run before this handler.
 */
export async function handleDeskMailRules(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskMailRulesDeps = {}): Promise<Response> {
  const desk = runtime?.options;
  if (!runtime || !desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  if (req.method === "GET") return Response.json({ ok: true, rules: ruleViews(db) }, { headers: noStore });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const parsed = RuleRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "An op and a proposal, rule or run are required.");
  const body = parsed.data;
  const action = actionOf(db, body);
  if (action !== null && !KEEPS_IN_MAILBOX.has(action) && !desk.mailActions?.move?.length) return fail(409, NO_MOVE);
  const now = (deps.now ?? Date.now)();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const config = desk.mailRules ?? DEFAULT_MAIL_RULES;
  const kick = (r: RuleChange): Response => {
    if (r.ok) void runtime.mailRules?.kick();
    return answer(r);
  };
  switch (body.op) {
    case "approve":
    case "later":
    case "never":
      return kick(answerProposal(db, body.proposal, body.op, now, config, newId));
    case "release":
      return kick(releaseRule(db, body.rule, now));
    case "start":
      return kick(setRuleOn(db, body.rule, true, now));
    case "stop":
      return answer(setRuleOn(db, body.rule, false, now));
    case "delete":
      return answer(deleteRule(db, body.rule));
    case "edit":
    case "create": {
      const target = body.target ? await targetOf(db, desk, body.target, now) : undefined;
      if (typeof target === "string") return fail(409, target);
      const edit = { match: body.match, value: body.value, action: body.action, ...(target ? { target } : {}) };
      return kick(body.op === "edit" ? editRule(db, body.rule, edit, now) : createRule(db, edit, now, newId));
    }
    case "undo":
      return answer(await undoRuleRun(body.run, { db, config: desk.mailActions, ledger: runtime.ledger, run: deps.run ?? spawnWithStdin, now }, ruleAttach(db, desk, () => runtime.sourceCache?.cached() ?? [], () => now)));
  }
}

function answer(result: RuleChange | MoveResult): Response {
  if (!result.ok) return fail(result.status, result.error);
  return Response.json(result, { headers: noStore });
}
