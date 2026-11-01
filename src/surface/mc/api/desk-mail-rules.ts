import { z } from "zod";
import type { Database } from "bun:sqlite";
import type { DeskRuntime } from "../desk/compose";
import { spawnWithStdin } from "../desk/create";
import { fail, noStore, type DeskMailDeps } from "./desk-mail";
import { answerProposal, DEFAULT_MAIL_RULES, deleteRule, editRule, releaseRule, ruleViews, setRuleOn, undoRuleRun, type RuleChange } from "../desk/mail-rules";
import type { MoveResult } from "../desk/mail-move";

const Id = z.string().min(1).max(64);
const Edit = { match: z.string(), value: z.string(), action: z.string() };

const RuleRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.enum(["approve", "later", "never"]), proposal: z.string().min(1).max(400) }).strict(),
  z.object({ op: z.enum(["release", "stop", "start", "delete"]), rule: Id }).strict(),
  z.object({ op: z.literal("edit"), rule: Id, ...Edit }).strict(),
  z.object({ op: z.literal("undo"), run: Id }).strict(),
]);

export type DeskMailRulesDeps = DeskMailDeps;

/**
 * GET lists the approved rules. POST {op: "approve" | "later" | "never", proposal} answers a proposal card;
 * {op: "release" | "stop" | "start" | "delete", rule} and {op: "edit", rule, match, value, action} change a rule;
 * {op: "undo", run} takes back one rule run. The rebind and identity gates in handleApi run before this handler.
 */
export async function handleDeskMailRules(req: Request, db: Database, runtime: DeskRuntime | undefined, deps: DeskMailRulesDeps = {}): Promise<Response> {
  const desk = runtime?.options;
  if (!runtime || !desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  if (!desk.mailActions?.move?.length) return fail(409, "Mail rules need the move command (mc.desk.mail.actions.move), and it is not set up on this stack.");
  if (req.method === "GET") return Response.json({ ok: true, rules: ruleViews(db) }, { headers: noStore });
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } });
  const parsed = RuleRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail(400, "An op and a proposal, rule or run are required.");
  const body = parsed.data;
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
      return kick(editRule(db, body.rule, body, now));
    case "undo":
      return answer(await undoRuleRun(body.run, { db, config: desk.mailActions, ledger: runtime.ledger, run: deps.run ?? spawnWithStdin, now }));
  }
}

function answer(result: RuleChange | MoveResult): Response {
  if (!result.ok) return fail(result.status, result.error);
  return Response.json(result, { headers: noStore });
}
