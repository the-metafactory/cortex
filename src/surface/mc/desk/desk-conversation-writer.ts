import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult, OwnerWriter } from "../../../conversations/types";
import { KIND_LABEL, validateCard, type AskFields } from "./ask";
import type { DeskOptions } from "./compose";
import { studioRequestId } from "./conversation-ids";
import { createFromCard, spawnWithStdin, type WriterKind, type WriterRunner } from "./create";

export interface DeskWriterDeps {
  db: Database;
  desk: () => DeskOptions | undefined;
  run?: WriterRunner;
  now?: () => number;
}

type DeskWriterKind = Extract<WriterKind, "calendar" | "reminder">;

export interface DeskWriterSpec<K extends DeskWriterKind> {
  kind: K;
  objects: string;
  noun: string;
  destinationFlag: string;
  destinationField: string;
  defaultDestination: string;
  fields: (request: CreateRequest) => AskFields[K] | string;
}

const NOTHING = "Nothing was created.";
export const failed = (sentence: string): CreateResult => ({ state: "failed", error: `${sentence.trim().replace(/[.\s]+$/, "")}. ${NOTHING}` });
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export const deskWriterArgv = (desk: DeskOptions | undefined, kind: DeskWriterKind): string[] | undefined => {
  const argv = desk?.enabled ? desk.ask?.writers[kind] : undefined;
  return argv?.length ? argv : undefined;
};

export function argvOption(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function instant(name: string, value: string | undefined): number | string {
  const at = value && ISO_TIME.exec(value) ? Date.parse(value) : Number.NaN;
  return Number.isFinite(at) ? at : `The ${name} is not an ISO 8601 date and time such as 2027-01-06T09:00:00+01:00`;
}

export function deskConversationWriter<K extends DeskWriterKind>(spec: DeskWriterSpec<K>, deps: DeskWriterDeps): OwnerWriter {
  const writerName = `${KIND_LABEL[spec.kind].toLowerCase()} writer`;
  const create = async (request: CreateRequest): Promise<CreateResult> => {
    const desk = deps.desk();
    const argv = deskWriterArgv(desk, spec.kind);
    if (!desk || !argv) return failed(`${spec.objects} are not set up on this stack`);
    const destination = argvOption(argv, spec.destinationFlag);
    const asked = request.fields[spec.destinationField] ?? "";
    if (asked && asked !== destination) return failed(`This stack saves ${spec.noun} only to ${destination ?? spec.defaultDestination}`);
    const fields = spec.fields(request);
    if (typeof fields === "string") return failed(fields);
    const card = validateCard(spec.kind, fields);
    if (typeof card === "string") return failed(card);
    if (request.signal.aborted) throw new Error(`The conversation stopped waiting before the ${writerName} was called.`);
    const saved = await createFromCard(card, { requestId: studioRequestId(request.operationId), writers: { [spec.kind]: argv }, run: deps.run ?? spawnWithStdin, db: deps.db, now: (deps.now ?? Date.now)(), timeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000 });
    if (saved.ok) return { state: "created", canonicalId: saved.id };
    if (saved.uncertain) throw new Error(saved.error);
    return failed(saved.error);
  };
  return { create, readback: () => Promise.resolve(null) };
}
