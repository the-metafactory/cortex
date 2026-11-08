import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalSchema } from "../schema-validation";
import { ApprovedSnapshotSchema, DispatchRequestSchema, ObjectReadbackSchema, OwnerResultSchema, OwnerSupportSchema } from "../operations/types";
import type { ObjectReference, SchemaRef } from "../types";
import { ReadResponseSchema, type DraftingBinding, type PackagedConnector, type ReadBinding } from "./contract";
import { containedFile, inspectPackage, loadPackages, type LoadedPackage, type LoadResult } from "./loader";

type Json = unknown;
type Fields = Record<string, Json>;
interface Connection { connectionId: string; adapterId: string; revision: number; enabled: boolean; accountScope: Record<string, unknown>; configuration: Record<string, unknown>; readDestinations: string[]; writeDestinations: string[]; knownDestinations: { ref: ObjectReference; label: string }[] }
export interface FieldSpec { name: string; label: string; required: boolean; kind: "text" | "long" | "enum" | "date" | "number" | "boolean" | "list" | "reference" | "unsupported"; options?: string[]; role?: DraftingBinding["fieldHints"][number]["role"]; resolveWith?: string }
interface Draft { id: string; adapterId: string; adapterLabel: string; objectLabel: string; objectType: string; capabilityId: string; inputSchemaRef: SchemaRef; spec: FieldSpec[]; fields: Fields; edited: string[]; revision: number; status: "proposed" | "saving" | "saved" | "failed" | "uncertain"; stale: boolean; error?: string; alternatives: Record<string, { label: string; ref: ObjectReference }[]>; operationId?: string; receipt?: { ref: ObjectReference; at: string; title: string }; current?: { object: Json; available: boolean }; automatic: boolean; origins: Record<string, string> }
interface ResultItem { ref: ObjectReference; object: Json; title: string; summary: string; destination?: string }
interface ResultGroup { adapterId: string; label: string; objectType: string; status: "ok" | "partial" | "denied" | "unavailable" | "no-match"; note?: string; items: ResultItem[]; more?: string; capabilityId: string }
interface Message { id: string; speaker: "You" | "Ivy"; text: string; card?: { kind: "draft"; id: string } | { kind: "results"; id: string } }
interface ProjectionRow { ref: ObjectReference; adapterId: string; capabilityId: string; object: Json; ownerRevision: string; destination?: string; lastSuccessAt: string; lastAttemptAt: string; observedAt: string }
interface State { approvals: Record<string, string>; fenced: Record<string, true>; connections: Record<string, Connection>; projection: Record<string, ProjectionRow>; evidence: Record<string, string>; quarantined: string[]; drafts: Record<string, Draft>; results: Record<string, { groups: ResultGroup[]; text: string }>; messages: Message[]; ownerCalls: number; deniedAttempts: number; frameIncidents: string[] }

const seedMessages = (): Message[] => [
  { id: randomUUID(), speaker: "You", text: "Receipts across a crash are worth coming back to. The piece I read explains why." },
  { id: randomUUID(), speaker: "Ivy", text: "Noted. Tell me what you would like to do with it." },
];
const emptyState = (): State => ({ approvals: {}, fenced: {}, connections: {}, projection: {}, evidence: {}, quarantined: [], drafts: {}, results: {}, messages: seedMessages(), ownerCalls: 0, deniedAttempts: 0, frameIncidents: [] });
const at = (value: Json, pointer: string): Json => pointer.split("/").slice(1).map(part => part.replace(/~1/g, "/").replace(/~0/g, "~")).reduce<Json>((current, key) => current !== null && typeof current === "object" ? (current as Record<string, Json>)[key] : undefined, value);
const str = (value: Json): string => typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
const refKey = (ref: ObjectReference): string => `${ref.adapterId}|${ref.connectionId}|${ref.objectType}|${ref.canonicalId}`;
const isReference = (value: Json): value is ObjectReference => !!value && typeof value === "object" && "canonicalId" in value;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const iso = (): string => new Date().toISOString();
const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun}`;
const STALE_AFTER_MS = 10 * 60_000;
const DEFAULT_PAGE_TIMEOUT_MS = 10_000;

export const draftDigest = (draft: Pick<Draft, "capabilityId" | "fields">): string => sha(canonicalSchema({ capabilityId: draft.capabilityId, fields: draft.fields }));

export class ExtensionHost {
  state: State;
  loaded!: LoadResult;
  readonly startedAt = new Date().toISOString();
  private readonly continuations = new Map<string, { adapterId: string; capabilityId: string; revision: number; input: Json; cursor: string; expires: number }>();
  private readonly statePath: string;
  readonly packagesRoot: string;

  constructor(readonly stateDir: string, readonly samplesRoot: string) {
    mkdirSync(stateDir, { recursive: true });
    this.statePath = join(stateDir, "state.json");
    this.packagesRoot = join(stateDir, "packages");
    this.state = existsSync(this.statePath) ? { ...emptyState(), ...JSON.parse(readFileSync(this.statePath, "utf8")) as State } : emptyState();
  }
  private save(): void { writeFileSync(this.statePath, JSON.stringify(this.state, null, 1)); }

  async start(): Promise<void> {
    for (const dir of Object.keys(this.state.fenced)) { rmSync(join(this.packagesRoot, dir), { recursive: true, force: true }); delete this.state.fenced[dir]; }
    this.loaded = await loadPackages(this.packagesRoot, this.state.approvals);
    await this.poll();
    this.save();
  }
  private dirOf(pkg: LoadedPackage): string { return pkg.dir.split("/").pop() ?? ""; }
  private pkg(adapterId: string): LoadedPackage | undefined { return this.active().find(entry => entry.manifest.declaration.adapterId === adapterId); }
  private active(): LoadedPackage[] { return this.loaded.active.filter(entry => !this.state.fenced[this.dirOf(entry)]); }
  private live(adapterId: string): Connection | undefined { const connection = this.state.connections[adapterId]; return connection?.enabled && this.pkg(adapterId) ? connection : undefined; }
  private mayRead(adapterId: string, destination?: string): boolean { const connection = this.live(adapterId); return !!connection && (destination === undefined || connection.readDestinations.includes(destination)); }

  private async read(pkg: LoadedPackage, binding: ReadBinding, connection: Connection, input: Json, continuation?: string): Promise<{ ok: true; items: ResultItem[]; rows: { ref: ObjectReference; value: Json; ownerRevision: string; destination?: string }[]; continuation?: string; observedAt: string; withheld: boolean } | { ok: false; note: string }> {
    const checked = this.loaded.registry.validateInput({ capabilityId: binding.capabilityId, inputSchemaRef: binding.inputSchemaRef, input }, null);
    if (!checked.ok) return { ok: false, note: "The request did not match this adapter’s input." };
    const destinations = connection.knownDestinations.filter(entry => connection.readDestinations.includes(entry.ref.canonicalId)).map(entry => entry.ref);
    const context = { connectionId: connection.connectionId, destinations, ...(continuation ? { continuation } : {}), signal: AbortSignal.timeout(DEFAULT_PAGE_TIMEOUT_MS) };
    let raw: unknown;
    try {
      if (binding.mode === "poll") {
        const observation = pkg.bindings.observations[binding.capabilityId] as { poll?: (context: unknown) => unknown } | undefined;
        if (!observation?.poll) return { ok: false, note: "This adapter has no reader for that." };
        raw = await observation.poll(context);
      } else {
        const handler = pkg.bindings.handlers[binding.capabilityId];
        if (!handler) return { ok: false, note: "This adapter has no reader for that." };
        raw = await handler(checked.value.input, context);
      }
    } catch { return { ok: false, note: "The adapter could not answer just now." }; }
    const parsed = ReadResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, note: "The adapter’s answer was not valid, so nothing from it is shown." };
    const output = this.loaded.registry.validateOutput(binding.capabilityId, parsed.data.payload);
    if (!output.ok) return { ok: false, note: "The adapter’s answer was not valid, so nothing from it is shown." };
    const items: ResultItem[] = [];
    const rows: { ref: ObjectReference; value: Json; ownerRevision: string; destination?: string }[] = [];
    let withheld = false;
    for (const annotation of parsed.data.annotations) {
      const value = annotation.pointer === "" ? parsed.data.payload : at(parsed.data.payload, annotation.pointer);
      if (value === undefined || annotation.ref.adapterId !== binding.adapterId || annotation.ref.connectionId !== connection.connectionId) return { ok: false, note: "The adapter’s answer did not account for its objects, so nothing from it is shown." };
      const object = this.loaded.registry.validateObject(binding.adapterId, annotation.ref.objectType, annotation.objectSchemaRef, value);
      if (!object.ok) return { ok: false, note: "The adapter’s answer was not valid, so nothing from it is shown." };
      const destination = annotation.destination?.canonicalId;
      if (binding.destinationType && (destination === undefined || !connection.readDestinations.includes(destination))) { withheld = true; this.state.deniedAttempts += 1; continue; }
      items.push({ ref: annotation.ref, object: value, title: str(at(value, binding.display.title)), summary: binding.display.summary ? str(at(value, binding.display.summary)) : "", ...(destination ? { destination } : {}) });
      rows.push({ ref: annotation.ref, value, ownerRevision: annotation.ownerRevision, ...(destination ? { destination } : {}) });
    }
    return { ok: true, items, rows, ...(parsed.data.continuation ? { continuation: parsed.data.continuation } : {}), observedAt: parsed.data.observedAt, withheld };
  }

  async poll(): Promise<void> {
    for (const pkg of this.active()) {
      const connection = this.live(pkg.manifest.declaration.adapterId);
      if (!connection) continue;
      for (const binding of pkg.manifest.readBindings.filter(entry => entry.mode === "poll")) {
        const attempted = iso();
        const result = await this.read(pkg, binding, connection, {});
        if (!result.ok) { for (const row of Object.values(this.state.projection)) if (row.capabilityId === binding.capabilityId) row.lastAttemptAt = attempted; continue; }
        for (const row of result.rows) {
          const key = refKey(row.ref);
          const evidenceKey = `${key}@${row.ownerRevision}`;
          const digest = sha(canonicalSchema(row.value));
          const held = this.state.evidence[evidenceKey];
          if (held && held !== digest) { this.state.quarantined.push(evidenceKey); continue; }
          this.state.evidence[evidenceKey] = digest;
          this.state.projection[key] = { ref: row.ref, adapterId: binding.adapterId, capabilityId: binding.capabilityId, object: row.value, ownerRevision: row.ownerRevision, ...(row.destination ? { destination: row.destination } : {}), lastSuccessAt: iso(), lastAttemptAt: attempted, observedAt: result.observedAt };
        }
      }
    }
    this.save();
  }

  day(): Record<string, Json>[] {
    const native = [{ key: "native-meeting", kind: "meeting", source: "Calendar", title: "Planning review", why: "Starts in 40 minutes", urgency: "soon", score: 70, stale: false, adapter: null }];
    const adapterItems = Object.values(this.state.projection).flatMap(row => {
      const binding = this.pkg(row.adapterId)?.manifest.readBindings.find(entry => entry.capabilityId === row.capabilityId);
      if (!binding?.attention || !this.mayRead(row.adapterId, row.destination)) return [];
      const due = binding.attention.due ? str(at(row.object, binding.attention.due)) : "";
      const near = due !== "" && Date.parse(due) - Date.now() < 2 * 86_400_000;
      return [{ key: refKey(row.ref), kind: "adapter", source: this.pkg(row.adapterId)?.manifest.declaration.label ?? row.adapterId, title: str(at(row.object, binding.attention.title)), why: binding.attention.why ? str(at(row.object, binding.attention.why)) : "", due, area: binding.attention.area ? str(at(row.object, binding.attention.area)) : "", urgency: near ? "soon" : "later", score: near ? 60 : 30, stale: Date.now() - Date.parse(row.lastSuccessAt) > STALE_AFTER_MS, adapter: row.adapterId, interrupt: "off", actions: [] }];
    });
    return [...native, ...adapterItems].sort((a, b) => b.score - a.score);
  }

  private say(speaker: Message["speaker"], text: string, card?: Message["card"]): Message { const message: Message = { id: randomUUID(), speaker, text, ...(card ? { card } : {}) }; this.state.messages.push(message); return message; }

  private matchObject(text: string): { pkg: LoadedPackage; objectType: string; label: string }[] {
    const lower = text.toLowerCase();
    return this.active().flatMap(pkg => pkg.manifest.declaration.objectTypes
      .filter(object => new RegExp(`\\b${object.label.toLowerCase()}\\b`).test(lower) && !pkg.manifest.readBindings.some(binding => binding.mode === "destinations" && binding.objectType === object.objectType))
      .map(object => ({ pkg, objectType: object.objectType, label: object.label })));
  }

  async handleMessage(text: string): Promise<void> {
    const value = text.trim();
    if (!value) return;
    this.say("You", value);
    if (/^(?:find|search|show|look)\b/i.test(value)) await this.runQuery(value.replace(/^(?:find|search|show|look)(?:\s+(?:me|for|up))*\s*/i, ""));
    else if (/^(?:turn this|make this|create|new draft)\b/i.test(value)) await this.makeDraft(value, /^new draft/i.test(value));
    else if (/^update\b/i.test(value)) await this.refreshDraft(value);
    else {
      for (const draft of Object.values(this.state.drafts)) if (draft.status === "proposed" || draft.status === "failed") draft.stale = true;
      this.say("Ivy", "I’ve noted that. Ask me to update a draft when you want to include it.");
    }
    this.save();
  }

  private async runQuery(text: string): Promise<void> {
    const groups: ResultGroup[] = [];
    for (const pkg of this.active()) {
      const connection = this.live(pkg.manifest.declaration.adapterId);
      if (!connection) continue;
      for (const binding of pkg.manifest.readBindings.filter(entry => entry.mode === "query" && entry.textPointer)) {
        groups.push(await this.group(pkg, binding, connection, { [String(binding.textPointer).slice(1)]: text }));
      }
    }
    if (!groups.length) { this.say("Ivy", "Nothing connected here can answer that yet."); return; }
    const id = randomUUID();
    this.state.results[id] = { groups, text };
    this.say("Ivy", groups.some(group => group.items.length) ? "Here’s what I found." : "I didn’t find anything in what’s connected.", { kind: "results", id });
  }

  private async group(pkg: LoadedPackage, binding: ReadBinding, connection: Connection, input: Json, cursor?: string): Promise<ResultGroup> {
    const base = { adapterId: binding.adapterId, label: pkg.manifest.declaration.label, objectType: binding.objectType, capabilityId: binding.capabilityId };
    if (binding.destinationType && connection.readDestinations.length === 0) return { ...base, status: "denied", note: "Reading isn’t allowed anywhere on this connection.", items: [] };
    const result = await this.read(pkg, binding, connection, input, cursor);
    if (!result.ok) return { ...base, status: "unavailable", note: result.note, items: [] };
    let more: string | undefined;
    if (result.continuation) { more = randomUUID(); this.continuations.set(more, { adapterId: binding.adapterId, capabilityId: binding.capabilityId, revision: connection.revision, input, cursor: result.continuation, expires: Date.now() + 10 * 60_000 }); }
    return { ...base, status: result.withheld ? "partial" : result.items.length === 0 && !more ? "no-match" : "ok", ...(result.withheld ? { note: "Some results aren’t shown because of what this connection may read." } : {}), items: result.items, ...(more ? { more } : {}) };
  }

  async loadMore(resultId: string, continuationId: string): Promise<void> {
    const held = this.continuations.get(continuationId);
    const group = this.state.results[resultId]?.groups.find(entry => entry.more === continuationId);
    if (!group) return;
    const connection = held ? this.live(held.adapterId) : undefined;
    const pkg = held ? this.pkg(held.adapterId) : undefined;
    const binding = pkg?.manifest.readBindings.find(entry => entry.capabilityId === held?.capabilityId);
    this.continuations.delete(continuationId);
    if (!held || !connection || !pkg || !binding || held.revision !== connection.revision || held.expires < Date.now()) { delete group.more; group.status = "partial"; group.note = "What this connection may read changed, so ask again to see more."; this.save(); return; }
    const next = await this.group(pkg, binding, connection, held.input, held.cursor);
    group.items.push(...next.items);
    delete group.more;
    if (next.more) group.more = next.more;
    if (next.status !== "ok" && next.status !== "no-match") { group.status = next.status; if (next.note) group.note = next.note; }
    this.save();
  }

  private fieldSpecs(pkg: LoadedPackage, capabilityId: string, objectType: string, binding?: DraftingBinding): { spec: FieldSpec[]; inputSchemaRef: SchemaRef } {
    const capability = pkg.manifest.declaration.capabilities.find(entry => entry.capabilityId === capabilityId);
    if (!capability) throw new Error("capability missing");
    const schema = pkg.manifest.declaration.schemas.find(entry => entry.schemaId === capability.inputSchemaRef.schemaId && entry.version === capability.inputSchemaRef.version)?.schema as Record<string, Json> | undefined;
    const properties = (schema?.properties ?? {}) as Record<string, Record<string, Json>>;
    const required = new Set((schema?.required ?? []) as string[]);
    const relationships = pkg.manifest.declaration.objectTypes.find(entry => entry.objectType === objectType)?.relationships ?? [];
    const spec = Object.entries(properties).map(([name, field]): FieldSpec => {
      const hint = binding?.fieldHints.find(entry => entry.pointer === `/${name}`);
      const base = { name, label: typeof field.title === "string" ? field.title : name, required: required.has(name), ...(hint ? { role: hint.role } : {}), ...(hint?.resolveWith ? { resolveWith: hint.resolveWith } : {}) };
      const relation = relationships.find(entry => entry.fieldPath === `/${name}`);
      if (relation) return relation.cardinality === "one" && hint?.resolveWith ? { ...base, kind: "reference" } : { ...base, kind: "unsupported" };
      if (Array.isArray(field.enum) && field.enum.every(option => typeof option === "string")) return { ...base, kind: "enum", options: field.enum as string[] };
      if (field.type === "string" && field.format === "date") return { ...base, kind: "date" };
      if (field.type === "string" && field.format === undefined) return { ...base, kind: hint?.widget === "long" ? "long" : "text" };
      if (field.type === "number" || field.type === "integer") return { ...base, kind: "number" };
      if (field.type === "boolean") return { ...base, kind: "boolean" };
      if (field.type === "array" && (field.items as Record<string, Json> | undefined)?.type === "string") return { ...base, kind: "list" };
      return { ...base, kind: "unsupported" };
    });
    return { spec, inputSchemaRef: capability.inputSchemaRef };
  }

  private generate(pkg: LoadedPackage, binding: DraftingBinding | undefined, spec: FieldSpec[], edited: string[], current: Fields): { fields: Fields; alternatives: Draft["alternatives"]; origins: Record<string, string> } {
    const fields: Fields = { ...current };
    const alternatives: Draft["alternatives"] = {};
    const origins: Record<string, string> = {};
    const said = this.state.messages.filter(message => message.speaker === "You" && !/^(?:find|search|show|look|turn this|make this|create|new draft|update|use )\b/i.test(message.text)).map(message => message.text);
    const latest = said.at(-1) ?? "";
    const connection = this.live(pkg.manifest.declaration.adapterId);
    for (const field of spec) {
      if (edited.includes(field.name) || !binding) continue;
      if (field.role === "title") { fields[field.name] = (latest.split(/(?<=[.!?])\s/)[0] ?? latest).replace(/[.!?]$/, "").slice(0, 70); origins[field.name] = "From our discussion."; }
      if (field.role === "summary" || field.role === "detail") { fields[field.name] = said.slice(-3).join(" "); origins[field.name] = "Summarised from our discussion."; }
      if (field.role === "destination" && field.resolveWith && connection) {
        const options = connection.knownDestinations.filter(entry => connection.writeDestinations.includes(entry.ref.canonicalId));
        const named = options.filter(entry => said.join(" ").toLowerCase().includes(entry.label.toLowerCase()));
        const picks = named.length ? named : options;
        const only = picks.length === 1 ? picks[0] : undefined;
        if (only) { fields[field.name] = only.ref; origins[field.name] = named.length ? "You mentioned it." : "The only place this connection can add to."; }
        else alternatives[field.name] = picks;
      }
    }
    return { fields, alternatives, origins };
  }

  private async makeDraft(text: string, fresh: boolean): Promise<void> {
    const matches = this.matchObject(text);
    if (!matches.length) { this.say("Ivy", "Nothing connected here can make that yet. You can add one under Adapters."); return; }
    const withAction = matches.flatMap(match => { const capability = match.pkg.manifest.declaration.capabilities.find(entry => entry.kind === "action" && entry.objectTypes.includes(match.objectType)); return capability ? [{ ...match, capabilityId: capability.capabilityId }] : []; });
    const chosen = withAction[0];
    if (!chosen) { const match = matches[0]; this.say("Ivy", `${match?.pkg.manifest.declaration.label ?? "That"} can be read here, but it can’t make ${match ? withArticle(match.label.toLowerCase()) : "a new one"} from a conversation.`); return; }
    if (withAction.length > 1) { this.say("Ivy", `More than one connected source has a ${chosen.label.toLowerCase()}. Which did you mean: ${withAction.map(entry => entry.pkg.manifest.declaration.label).join(" or ")}?`); return; }
    const adapterId = chosen.pkg.manifest.declaration.adapterId;
    if (!this.live(adapterId)) { this.say("Ivy", `${chosen.pkg.manifest.declaration.label} isn’t connected yet. You can connect it under Adapters.`); return; }
    const existing = Object.values(this.state.drafts).filter(draft => draft.capabilityId === chosen.capabilityId).at(-1);
    if (existing && !fresh) { this.say("Ivy", existing.status === "saved" ? "That is already saved. The card and its result are still in this conversation." : "Your draft is still in this conversation; I’ve kept your edits."); return; }
    const binding = chosen.pkg.manifest.draftingBindings.find(entry => entry.capabilityId === chosen.capabilityId);
    const { spec, inputSchemaRef } = this.fieldSpecs(chosen.pkg, chosen.capabilityId, chosen.objectType, binding);
    const generated = this.generate(chosen.pkg, binding, spec, [], {});
    const draft: Draft = { id: randomUUID(), adapterId, adapterLabel: chosen.pkg.manifest.declaration.label, objectLabel: chosen.label, objectType: chosen.objectType, capabilityId: chosen.capabilityId, inputSchemaRef, spec, fields: generated.fields, edited: [], revision: 1, status: "proposed", stale: false, alternatives: generated.alternatives, automatic: !!binding, origins: generated.origins };
    this.state.drafts[draft.id] = draft;
    this.say("Ivy", binding ? `Here’s ${withArticle(chosen.label.toLowerCase())} for that.` : `I can’t draft this one for you, but you can fill in the ${chosen.label.toLowerCase()} yourself.`, { kind: "draft", id: draft.id });
  }

  private async refreshDraft(text: string): Promise<void> {
    const open = Object.values(this.state.drafts).filter(draft => draft.status === "proposed" || draft.status === "failed");
    const draft = open.filter(entry => text.toLowerCase().includes(entry.objectLabel.toLowerCase())).at(-1) ?? open.at(-1);
    const pkg = draft ? this.pkg(draft.adapterId) : undefined;
    if (!draft || !pkg) { this.say("Ivy", "There is no editable draft to update yet."); return; }
    const binding = pkg.manifest.draftingBindings.find(entry => entry.capabilityId === draft.capabilityId);
    const generated = this.generate(pkg, binding, draft.spec, draft.edited, draft.fields);
    draft.fields = generated.fields; draft.alternatives = generated.alternatives; draft.origins = { ...draft.origins, ...generated.origins }; draft.revision += 1; draft.stale = false;
    this.say("Ivy", draft.edited.length ? "I updated the untouched details and kept your edits." : "I updated the draft with the new details.");
  }

  editDraft(id: string, revision: number, changes: Fields): void {
    const draft = this.state.drafts[id];
    if (draft?.revision !== revision || !(draft.status === "proposed" || draft.status === "failed")) return;
    const named = Object.keys(changes).filter(name => draft.spec.some(field => field.name === name));
    for (const name of named) {
      const field = draft.spec.find(entry => entry.name === name);
      let value = changes[name];
      if (field?.kind === "reference" && typeof value === "string") { const chosen = value; value = this.state.connections[draft.adapterId]?.knownDestinations.find(entry => entry.ref.canonicalId === chosen)?.ref; delete draft.alternatives[name]; }
      if (field?.kind === "number" && typeof value === "string") value = value === "" ? undefined : Number(value);
      if (field?.kind === "list" && typeof value === "string") value = value === "" ? undefined : value.split(",").map(entry => entry.trim()).filter(Boolean);
      if (value === "" || value === undefined) delete draft.fields[name]; else draft.fields[name] = value;
      draft.origins[name] = "You edited this.";
    }
    draft.edited = [...new Set([...draft.edited, ...named])];
    draft.revision += 1; draft.status = "proposed"; delete draft.error; delete draft.operationId;
    this.save();
  }

  blockers(draft: Draft): string[] {
    if (!this.pkg(draft.adapterId)) return ["unavailable"];
    const blockers: string[] = [];
    if (draft.spec.some(field => field.kind === "unsupported" && (field.required || field.name in draft.fields))) blockers.push("unsupported");
    for (const field of draft.spec) if (field.required && draft.fields[field.name] === undefined) blockers.push(`missing:${field.label}`);
    return blockers;
  }

  async approve(id: string, revision: number, digest: string): Promise<void> {
    const draft = this.state.drafts[id];
    if (!draft) return;
    if (draft.status === "saved" || draft.status === "saving" || draft.status === "uncertain" || draft.revision !== revision || draftDigest(draft) !== digest || this.blockers(draft).length) return;
    const pkg = this.pkg(draft.adapterId);
    const connection = this.live(draft.adapterId);
    const refused = (message: string): void => { draft.error = message; this.state.deniedAttempts += 1; this.save(); };
    if (!pkg || !connection) { refused(`${draft.adapterLabel} isn’t connected, so nothing was saved.`); return; }
    const destinations = Object.values(draft.fields).filter(isReference);
    const blocked = destinations.find(ref => !connection.writeDestinations.includes(ref.canonicalId));
    if (blocked) { refused(`This connection can’t add to ${connection.knownDestinations.find(entry => entry.ref.canonicalId === blocked.canonicalId)?.label ?? "that place"}, so nothing was saved.`); return; }
    const validated = this.loaded.registry.validateInput({ capabilityId: draft.capabilityId, inputSchemaRef: draft.inputSchemaRef, input: draft.fields }, null);
    if (!validated.ok) { refused(`${validated.error.issues?.[0]?.message ?? validated.error.message} Nothing was saved.`); return; }
    const connect = pkg.connectors.get(draft.capabilityId);
    const capability = pkg.manifest.declaration.capabilities.find(entry => entry.capabilityId === draft.capabilityId);
    if (!connect || !capability) { refused("This adapter has no connected owner, so nothing was saved."); return; }
    let connector: PackagedConnector;
    try { connector = connect({ connectionId: connection.connectionId, adapterId: draft.adapterId, accountScope: connection.accountScope, configuration: connection.configuration }); OwnerSupportSchema.parse(connector.support); }
    catch { refused("This adapter’s owner did not declare what it supports, so nothing was saved."); return; }
    const operationId = draft.operationId ?? randomUUID();
    draft.operationId = operationId; draft.status = "saving"; delete draft.error; this.save();
    const snapshotBody = { provenance: { conversationId: "prototype-conversation", proposalId: draft.id, revision: draft.revision, entryId: null, link: "?desk=conversation" }, adapterId: draft.adapterId, connectionId: connection.connectionId, capabilityId: draft.capabilityId, inputSchemaRef: capability.inputSchemaRef, outputSchemaRef: capability.outputSchemaRef, errorSchemaRef: capability.errorSchemaRef, input: draft.fields, destinations, sources: [], policy: "local" as const };
    const snapshot = ApprovedSnapshotSchema.parse({ ...snapshotBody, digest: sha(canonicalSchema(snapshotBody)) });
    const request = DispatchRequestSchema.parse({ lifecycleVersion: "1.0.0", operationId, attemptId: randomUUID(), idempotencyKey: operationId, ownerRequestId: operationId, snapshot, authority: { principalRef: "prototype-principal", basis: { kind: "confirmation", confirmationId: `${draft.id}:${draft.revision}`, transport: "web" }, connectionRevision: String(connection.revision), policyRevision: "1", decisionRef: randomUUID(), authorizedAt: iso() }, supportDeclarationId: connector.support.declarationId, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
    this.state.ownerCalls += 1;
    let answer: ReturnType<typeof OwnerResultSchema.parse>;
    try { answer = OwnerResultSchema.parse(await connector.dispatch(request, AbortSignal.timeout(30_000))); }
    catch { draft.status = "uncertain"; draft.error = "I couldn’t confirm whether this was saved. Let’s check before trying again."; this.save(); return; }
    if (answer.result.kind === "failed" || answer.result.kind === "conflict") { draft.status = "failed"; draft.error = answer.result.kind === "conflict" ? "This changed at its source, so nothing was saved. Your draft is still here." : "I couldn’t save this. Your draft is still here."; delete draft.operationId; this.save(); return; }
    const ref = answer.result.kind === "succeeded" ? answer.result.evidence.refs[0] : undefined;
    if (answer.result.kind !== "succeeded" || !ref || !this.loaded.registry.validateOutput(draft.capabilityId, answer.result.output).ok) { draft.status = "uncertain"; draft.error = "I couldn’t confirm whether this was saved. Let’s check before trying again."; this.save(); return; }
    const title = draft.spec.find(field => field.role === "title");
    draft.receipt = { ref, at: iso(), title: title ? str(draft.fields[title.name]) : draft.objectLabel };
    draft.status = "saved";
    await this.readBack(draft, connector);
    this.save();
  }

  private async readBack(draft: Draft, connector: PackagedConnector): Promise<void> {
    if (!draft.receipt) return;
    try {
      const answer = ObjectReadbackSchema.parse(await connector.readback({ lifecycleVersion: "1.0.0", ref: draft.receipt.ref }, AbortSignal.timeout(DEFAULT_PAGE_TIMEOUT_MS)));
      draft.current = answer.result.kind === "present" && this.loaded.registry.validateObject(draft.adapterId, draft.objectType, answer.result.schemaRef, answer.result.value).ok ? { object: answer.result.value, available: true } : { object: null, available: false };
    } catch { draft.current = { object: null, available: false }; }
  }

  async currentResult(id: string): Promise<void> {
    const draft = this.state.drafts[id];
    const pkg = draft ? this.pkg(draft.adapterId) : undefined;
    const connection = draft ? this.live(draft.adapterId) : undefined;
    const connect = pkg?.connectors.get(draft?.capabilityId ?? "");
    if (draft?.receipt) {
      if (connection && connect) await this.readBack(draft, connect({ connectionId: connection.connectionId, adapterId: draft.adapterId, accountScope: connection.accountScope, configuration: connection.configuration }));
      else draft.current = { object: null, available: false };
    }
    this.save();
  }

  listSamples(): string[] { return existsSync(this.samplesRoot) ? [...new Bun.Glob("*/desk-adapter.json").scanSync(this.samplesRoot)].map(path => path.split("/")[0] ?? "").sort() : []; }
  install(sample: string): void { if (!this.listSamples().includes(sample)) return; mkdirSync(this.packagesRoot, { recursive: true }); cpSync(join(this.samplesRoot, sample), join(this.packagesRoot, sample), { recursive: true, verbatimSymlinks: true }); this.loaded.diagnostics = [...this.loaded.diagnostics.filter(entry => entry.dir !== sample), inspectPackage(this.packagesRoot, sample, new Set(this.loaded.active.map(entry => entry.manifest.declaration.adapterId)))]; this.save(); }
  approvePackage(packageId: string, releaseDigest: string): boolean {
    const known = this.loaded.diagnostics.some(entry => entry.state === "awaiting-approval" && entry.packageId === packageId && entry.releaseDigest === releaseDigest);
    if (!known) return false;
    this.state.approvals[packageId] = releaseDigest;
    this.save();
    return true;
  }

  remove(sample: string): boolean {
    const diagnostic = this.loaded.diagnostics.find(entry => entry.dir === sample);
    const loaded = this.loaded.active.find(entry => this.dirOf(entry) === sample);
    if (diagnostic?.packageId) delete this.state.approvals[diagnostic.packageId];
    const needsRestart = !!loaded || diagnostic?.code === "duplicate_adapter";
    if (loaded) {
      this.state.fenced[sample] = true;
      const connection = this.state.connections[loaded.manifest.declaration.adapterId];
      if (connection) { connection.enabled = false; connection.revision += 1; }
    } else {
      rmSync(join(this.packagesRoot, sample), { recursive: true, force: true });
      this.loaded.diagnostics = this.loaded.diagnostics.filter(entry => entry.dir !== sample);
    }
    this.save();
    return needsRestart;
  }

  async connect(adapterId: string, accountScope: Record<string, unknown>, configuration: Record<string, unknown>): Promise<void> {
    const pkg = this.pkg(adapterId);
    if (!pkg) return;
    const existing = this.state.connections[adapterId];
    const connection: Connection = existing ? { ...existing, enabled: true, revision: existing.revision + 1, accountScope, configuration } : { connectionId: `${adapterId}-connection`, adapterId, revision: 1, enabled: true, accountScope, configuration, readDestinations: [], writeDestinations: [], knownDestinations: [] };
    this.state.connections[adapterId] = connection;
    const listing = pkg.manifest.readBindings.find(entry => entry.mode === "destinations");
    const handler = listing ? pkg.bindings.handlers[listing.capabilityId] : undefined;
    if (listing && handler) {
      const parsed = ReadResponseSchema.safeParse(await handler({}, { connectionId: connection.connectionId, destinations: [], signal: AbortSignal.timeout(DEFAULT_PAGE_TIMEOUT_MS) }));
      if (parsed.success) {
        connection.knownDestinations = parsed.data.annotations.map(annotation => ({ ref: annotation.ref, label: str(at(annotation.pointer === "" ? parsed.data.payload : at(parsed.data.payload, annotation.pointer), listing.display.title)) }));
        if (!existing) { connection.readDestinations = connection.knownDestinations.map(entry => entry.ref.canonicalId); connection.writeDestinations = [...connection.readDestinations]; }
      }
    }
    await this.poll();
  }
  disconnect(adapterId: string): void { const connection = this.state.connections[adapterId]; if (connection) { connection.enabled = false; connection.revision += 1; this.save(); } }
  setDestination(adapterId: string, canonicalId: string, kind: "read" | "write", allowed: boolean): void {
    const connection = this.state.connections[adapterId];
    if (!connection) return;
    const key = kind === "read" ? "readDestinations" : "writeDestinations";
    connection[key] = allowed ? [...new Set([...connection[key], canonicalId])] : connection[key].filter(entry => entry !== canonicalId);
    connection.revision += 1;
    this.save();
  }

  frameIncident(adapterId: string, reason: string): void { this.state.frameIncidents.push(`${adapterId}: ${reason}`); this.save(); }

  catalog(): Record<string, Json>[] {
    return this.active().flatMap(pkg => pkg.manifest.ui ? [{ adapterId: pkg.manifest.declaration.adapterId, releaseDigest: pkg.releaseDigest, protocol: pkg.manifest.ui.protocolVersion, src: `/adapter-assets/${pkg.releaseDigest}/${pkg.manifest.ui.entry}`, views: pkg.manifest.ui.views }] : []);
  }

  asset(releaseDigest: string, path: string): { file: string; mediaType: string } | null {
    const pkg = this.active().find(entry => entry.releaseDigest === releaseDigest);
    const listed = pkg?.manifest.ui?.files.find(file => file.path === path);
    if (!pkg || !listed) return null;
    try { const file = containedFile(pkg.dir, path); return createHash("sha256").update(readFileSync(file)).digest("hex") === listed.sha256 ? { file, mediaType: listed.mediaType } : null; }
    catch { return null; }
  }

  view(): Record<string, Json> {
    const results = Object.fromEntries(Object.entries(this.state.results).map(([id, result]) => [id, { text: result.text, groups: result.groups.map(group => ({ ...group, items: group.items.filter(item => this.mayRead(group.adapterId, item.destination)) })) }]));
    const drafts = Object.fromEntries(Object.values(this.state.drafts).map(draft => [draft.id, { ...draft, digest: draftDigest(draft), blockers: this.blockers(draft), current: draft.current && !this.mayRead(draft.adapterId) ? { object: null, available: false } : draft.current, destinationLabels: this.state.connections[draft.adapterId]?.knownDestinations.map(entry => ({ id: entry.ref.canonicalId, label: entry.label })) ?? [] }]));
    const adapters = this.listSamples().map(sample => {
      const diagnostic = this.loaded.diagnostics.find(entry => entry.dir === sample);
      const pkg = this.loaded.active.find(entry => this.dirOf(entry) === sample);
      const connection = pkg ? this.state.connections[pkg.manifest.declaration.adapterId] : undefined;
      return { sample, installed: existsSync(join(this.packagesRoot, sample)), loadedThisRun: !!diagnostic, removing: !!this.state.fenced[sample], state: diagnostic?.state ?? null, code: diagnostic?.code ?? null, message: diagnostic?.message ?? null, packageId: diagnostic?.packageId ?? null, releaseDigest: diagnostic?.releaseDigest ?? null, approved: !!diagnostic?.releaseDigest && this.state.approvals[diagnostic.packageId] === diagnostic.releaseDigest, label: diagnostic?.label ?? null, adapterId: pkg?.manifest.declaration.adapterId ?? null, connection: connection ? { enabled: connection.enabled, destinations: connection.knownDestinations.map(entry => ({ id: entry.ref.canonicalId, label: entry.label, read: connection.readDestinations.includes(entry.ref.canonicalId), write: connection.writeDestinations.includes(entry.ref.canonicalId) })) } : null };
    });
    return { messages: this.state.messages, drafts, results, day: this.day(), adapters, catalog: this.catalog() };
  }

  diagnostics(): Record<string, Json> {
    return { startedAt: this.startedAt, ownerCalls: this.state.ownerCalls, deniedAttempts: this.state.deniedAttempts, frameIncidents: this.state.frameIncidents, projectionRows: Object.keys(this.state.projection).length, evidenceEntries: Object.keys(this.state.evidence).length, quarantined: this.state.quarantined, packages: this.loaded.diagnostics };
  }
}
