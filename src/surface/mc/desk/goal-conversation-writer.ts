import { proposalDigest } from "../../../conversations/creation";
import type { CreateRequest, OwnerWriter, ReadbackResult } from "../../../conversations/types";
import { deskConversationWriter, type DeskWriterDeps } from "./desk-conversation-writer";
import { SOMA_GOAL_ID, spawnGoalCommand, type GoalRunner } from "./goals";

export interface GoalWriterDeps extends DeskWriterDeps {
  list?: GoalRunner;
}

const OPEN_GOAL = new Set(["draft", "active", "paused"]);
const LIST_TIMEOUT_MS = 10_000;

export function openGoals(stdout: string): { id: string; wording: string }[] {
  return stdout.split("\n").flatMap(row => {
    const [id = "", status = "", , , ...wording] = row.split("\t");
    return SOMA_GOAL_ID.test(id.trim()) && OPEN_GOAL.has(status.trim()) && wording.length ? [{ id: id.trim(), wording: wording.join("\t").trim() }] : [];
  });
}

function goalFields(request: CreateRequest): { wording: string } | string {
  const wording = request.fields.wording ?? "";
  return /[\r\n]/.test(wording) ? "The wording must be a single line" : { wording };
}

export function goalWriter(deps: GoalWriterDeps): OwnerWriter {
  const find = async (digest: string): Promise<ReadbackResult> => {
    const somaBin = deps.desk()?.somaBin;
    if (!somaBin) return null;
    const listed = await (deps.list ?? spawnGoalCommand)([somaBin, "goal", "list", "--wording"], {}, LIST_TIMEOUT_MS).catch(() => null);
    if (listed?.code !== 0) return null;
    const goal = openGoals(listed.stdout).find(g => proposalDigest("soma-goal", { wording: g.wording }) === digest);
    return goal ? { found: true, canonicalId: goal.id } : { found: false };
  };
  return deskConversationWriter({
    kind: "goal",
    objects: "Goals",
    fields: goalFields,
    afterRefusal: request => find(proposalDigest("soma-goal", request.fields)),
    readback: operation => (operation.digest ? find(operation.digest) : Promise.resolve(null)),
  }, deps);
}
