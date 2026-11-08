export type DraftKind = "balance" | "graph";
export type DraftFields = Record<string, string>;
export interface DiscussionMessage { id: string; speaker: "You" | "Ivy"; text: string; cardId?: string }
export interface FieldOrigin { kind: "discussion" | "context" | "suggested" | "user"; sourceIds: string[] }
export interface FixtureReference { adapterId: string; connectionId: string; objectType: string; canonicalId: string }
export interface DraftCandidate { fields: DraftFields; origins: Record<string, FieldOrigin>; missing: string[]; alternatives: string[]; destinations: FixtureReference[] }
export interface DraftReceipt { canonicalId: string; operationId: string; fields: DraftFields; currentAvailable: boolean; destinations: FixtureReference[] }
export interface ConversationDraft {
  id: string; kind: DraftKind; revision: number; editEpoch: number; fields: DraftFields; origins: Record<string, FieldOrigin>;
  edited: string[]; missing: string[]; alternatives: string[]; stale: boolean; updating: boolean;
  destinations: FixtureReference[]; status: "proposed" | "saving" | "saved" | "failed" | "uncertain"; operationId?: string; receipt?: DraftReceipt;
}
export interface DraftContext { selection?: string; dueSelection?: string; dueMessageId?: string; scenario: string }
export interface DraftField { name: string; label: string; long?: boolean; optional?: boolean }
export const adapterFixtures: Record<DraftKind, { label: string; action: string; mainText: string; titlePrefix: string; fields: DraftField[] }> = {
  balance: { label: "Balance", action: "task", mainText: "note", titlePrefix: "Review", fields: [{ name: "title", label: "Title" }, { name: "note", label: "Note", long: true, optional: true }, { name: "area", label: "Area" }, { name: "project", label: "Project", optional: true }, { name: "due", label: "Due", optional: true }] },
  graph: { label: "Work graph", action: "research node", mainText: "body", titlePrefix: "Investigate", fields: [{ name: "title", label: "Title" }, { name: "body", label: "Description", long: true, optional: true }, { name: "repository", label: "Repository" }, { name: "parent", label: "Under map" }, { name: "checkpoint", label: "Completion check" }] },
};
export const prototypeDiscussion = (scenario: string): DiscussionMessage[] => [
  { id: "discussion-outcome", speaker: "You", text: "We need to review receipt preservation across restart. Compare the saved receipt with the owner result, cover a crash just after acceptance and propose a regression test. Done means the restart cases and test proposal are documented." },
  { id: "discussion-destination", speaker: "You", text: scenario === "ambiguous" ? "Put the task in the Platform project. For a research node, use the lifecycle map in example/project." : scenario === "missing" ? "We have not chosen where to put this work yet." : "Put the task in the Reliability project. For a research node, use the lifecycle map in example/project." },
  { id: "discussion-response", speaker: "Ivy", text: "We have a clear outcome: understand the crash cases and capture a useful regression test." },
];
const control = /^(?:turn this|make this|create (?:a |the )?|update (?:the |my )?|refresh |include (?:the )?new details|new draft|check (?:the )?result)/i;
export const discussionFacts = (messages: DiscussionMessage[]): DiscussionMessage[] => messages.filter(message => message.speaker === "You" && !control.test(message.text) && !/^Use (?:Reliability|Inbox|Platform|Lifecycle|the lifecycle|Friday|Monday|No due date)/.test(message.text));
const contextOrigin = (): FieldOrigin => ({ kind: "context", sourceIds: [] });
const discussionOrigin = (sourceIds: string[]): FieldOrigin => ({ kind: "discussion", sourceIds });
const firstSentence = (text: string) => text.split(/(?<=[.!?])\s/)[0]?.replace(/[.!?]$/, "").replace(/^(?:We need to|We should|Please)\s+/i, "") ?? "Review the discussion";
const titled = (text: string) => text ? text[0]!.toUpperCase() + text.slice(1) : "";
export function draftFromDiscussion(kind: DraftKind, messages: DiscussionMessage[], context: DraftContext): DraftCandidate {
  const facts = discussionFacts(messages);
  const outcome = facts.find(message => message.id === "discussion-outcome") ?? facts[0];
  const destination = facts.find(message => message.id === "discussion-destination");
  const additions = facts.filter(message => message !== outcome && message !== destination);
  const title = titled(firstSentence(outcome?.text ?? "Review the discussion").replace(/^review\b/i, adapterFixtures[kind].titlePrefix));
  const detail = [outcome?.text.split(/(?<=[.!?])\s/).slice(1).join(" "), ...additions.map(message => message.text)].filter(Boolean).join("\n\n");
  const sources = [outcome, ...additions].filter((message): message is DiscussionMessage => Boolean(message)).map(message => message.id);
  const fields: DraftFields = { title, [adapterFixtures[kind].mainText]: detail };
  const origins: Record<string, FieldOrigin> = { title: discussionOrigin(outcome ? [outcome.id] : []), [adapterFixtures[kind].mainText]: discussionOrigin(sources) };
  const missing: string[] = [], alternatives: string[] = [];
  if (kind === "balance") {
    fields.area = context.selection === "Inbox" ? "Inbox" : context.selection?.includes("Operations") ? "Operations" : "Engineering";
    fields.project = context.selection?.startsWith("Platform") ? "Platform" : context.selection === "Inbox" ? "" : "Reliability";
    fields.due = "";
    origins.area = contextOrigin();
    origins.project = destination ? discussionOrigin([destination.id]) : contextOrigin();
    origins.due = contextOrigin();
    if (context.scenario === "missing" && !context.selection) { fields.area = ""; fields.project = ""; missing.push("area"); }
    if (context.scenario === "ambiguous" && !context.selection) { fields.area = ""; fields.project = "Platform"; missing.push("area"); alternatives.push("Platform — Engineering", "Platform — Operations"); }
    if (additions.some(message => /Friday.*Monday|Monday.*Friday/i.test(message.text)) && !context.dueSelection) alternatives.push("Friday", "Monday", "No due date");
    if (context.dueSelection) { fields.due = context.dueSelection === "Friday" ? "2026-11-13" : context.dueSelection === "Monday" ? "2026-11-16" : ""; origins.due = { kind: "user", sourceIds: context.dueMessageId ? [context.dueMessageId] : [] }; }
  } else {
    const located = context.selection === "Lifecycle map" || Boolean(destination?.text.includes("example/project"));
    fields.repository = located ? "example/project" : "";
    fields.parent = located ? "Lifecycle map" : "";
    fields.checkpoint = /Done means ([^.]+)/i.exec(outcome?.text ?? "")?.[1] ?? "";
    fields.kind = "research";
    fields.autonomy = "approve";
    origins.kind = contextOrigin();
    origins.autonomy = contextOrigin();
    origins.repository = located && destination ? discussionOrigin([destination.id]) : contextOrigin();
    origins.parent = origins.repository;
    origins.checkpoint = { kind: "suggested", sourceIds: outcome ? [outcome.id] : [] };
    if (!located) { missing.push("repository", "parent"); alternatives.push("Lifecycle map"); }
    if (!fields.checkpoint) missing.push("checkpoint");
  }
  return { fields, origins, missing, alternatives, destinations: resolveFixtureDestinations(kind, fields) };
}
export function applyDraftUpdate(draft: ConversationDraft, candidate: DraftCandidate): ConversationDraft {
  const fields = { ...candidate.fields }, origins = { ...candidate.origins };
  for (const key of draft.edited) { fields[key] = draft.fields[key] ?? ""; origins[key] = draft.origins[key] ?? { kind: "user", sourceIds: [] }; }
  return { ...draft, fields, origins, revision: draft.revision + 1, missing: draftMissing(draft.kind, fields), destinations: resolveFixtureDestinations(draft.kind, fields), alternatives: unresolvedAlternatives(draft.kind, fields, draft.edited, candidate.alternatives), stale: false, updating: false, status: "proposed", operationId: undefined };
}
export function unresolvedAlternatives(kind: DraftKind, fields: DraftFields, edited: string[], alternatives: string[]): string[] {
  return alternatives.filter(value => ["Friday", "Monday", "No due date"].includes(value) ? !edited.includes("due") : !(resolveFixtureDestinations(kind, fields).length && (kind === "balance" ? edited.includes("area") || edited.includes("project") : edited.includes("repository") || edited.includes("parent"))));
}
export function resolveFixtureDestinations(kind: DraftKind, fields: DraftFields): FixtureReference[] {
  const ref = (objectType: string, canonicalId: string): FixtureReference => ({ adapterId: kind, connectionId: `${kind}-connection-example`, objectType, canonicalId });
  if (kind === "graph") return fields.repository === "example/project" && fields.parent === "Lifecycle map" ? [ref("repository", "example/project"), ref("map", "example/project#100")] : [];
  const areas: Record<string, string> = { Engineering: "area-engineering", Operations: "area-operations", Inbox: "area-inbox" };
  const area = areas[fields.area ?? ""];
  if (!area) return [];
  const project = fields.project;
  if (!project) return [ref("area", area)];
  if (fields.area === "Engineering" && project === "Reliability") return [ref("area", area), ref("project", "project-reliability")];
  if (["Engineering", "Operations"].includes(fields.area ?? "") && project === "Platform") return [ref("area", area), ref("project", `project-platform-${fields.area?.toLowerCase()}`)];
  return [];
}
export function draftMissing(kind: DraftKind, fields: DraftFields): string[] {
  const missing = adapterFixtures[kind].fields.filter(field => !field.optional && !fields[field.name]?.trim()).map(field => field.name);
  if (!resolveFixtureDestinations(kind, fields).length) missing.push(kind === "balance" ? "destination" : "repository");
  return [...new Set(missing)];
}
export class SyntheticDraftOwner {
  calls = 0;
  effects = 0;
  checks = 0;
  private readonly records = new Map<string, { kind: DraftKind; fields: DraftFields; outcome: "saved" | "failed" | "uncertain"; receipt?: DraftReceipt }>();
  approve(operationId: string, kind: DraftKind, fields: DraftFields, scenario: string, retry = false): { outcome: "saved" | "failed" | "uncertain"; receipt?: DraftReceipt } {
    const prior = this.records.get(operationId);
    if (prior && !(retry && prior.outcome === "failed")) return prior.outcome === "uncertain" ? { outcome: "uncertain" } : prior;
    if (prior && JSON.stringify(prior.fields) !== JSON.stringify(fields)) throw new Error("Synthetic retry changed the approved fields.");
    this.calls++;
    const failed = scenario === "failed" && !prior;
    const receipt: DraftReceipt | undefined = failed ? undefined : { operationId, canonicalId: `${kind}-example-${this.effects + 1}`, fields: { ...fields }, currentAvailable: scenario !== "uncertain-missing", destinations: resolveFixtureDestinations(kind, fields) };
    const outcome = failed ? "failed" : scenario.startsWith("uncertain") ? "uncertain" : "saved";
    if (!failed) this.effects++;
    const record = { kind, fields: { ...fields }, outcome: outcome as "saved" | "failed" | "uncertain", ...(receipt ? { receipt } : {}) };
    this.records.set(operationId, record);
    return outcome === "uncertain" ? { outcome } : record;
  }
  lookup(operationId: string): DraftReceipt | undefined { this.checks++; return this.records.get(operationId)?.receipt; }
}
