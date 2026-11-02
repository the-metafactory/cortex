import type { Database } from "bun:sqlite";
import type { CreateRequest, CreateResult, OwnerReadback, OwnerWriter, ReadbackResult } from "../../../conversations/types";
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

export type DeskWriterKind = Extract<WriterKind, "calendar" | "reminder" | "goal" | "note">;

export interface DeskWriterSpec<K extends DeskWriterKind> {
  kind: K;
  objects: string;
  keptOnDesk?: true;
  destination?: { flag: string; field: string; noun: string; fallback: string; verb?: string };
  fields: (request: CreateRequest) => AskFields[K] | string;
  afterRefusal?: (request: CreateRequest, error: string) => Promise<ReadbackResult>;
  readback?: OwnerReadback;
}

const NOTHING = "Nothing was created.";
const sentence = (text: string): string => `${text.trim().replace(/[.\s]+$/, "")}.`;
const failed = (text: string): CreateResult => ({ state: "failed", error: `${sentence(text.replace(/[;,]\s*nothing was created[.\s]*$/i, ""))} ${NOTHING}` });
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?$/;

export const deskWriterArgv = (desk: DeskOptions | undefined, kind: DeskWriterKind): string[] | undefined => {
  const argv = desk?.enabled ? desk.ask?.writers[kind] : undefined;
  return argv?.length ? argv : undefined;
};

export const deskWriterOwner = (desk: DeskOptions | undefined, kind: DeskWriterKind): string | undefined =>
  deskWriterArgv(desk, kind) ? desk?.ask?.writerOwners?.[kind] : undefined;

function argvOption(argv: readonly string[], flag: string): string | undefined {
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
    const writes = spec.keptOnDesk ? !argv : Boolean(argv);
    if (!desk?.enabled || !writes) return failed(`${spec.objects} are not set up on this stack`);
    if (spec.destination) {
      const { flag, field, noun, fallback, verb = "saves" } = spec.destination;
      const destination = argvOption(argv ?? [], flag);
      const asked = request.fields[field] ?? "";
      if (asked && asked !== destination) return failed(`This stack ${verb} ${noun} only to ${destination ?? fallback}`);
    }
    const fields = spec.fields(request);
    if (typeof fields === "string") return failed(fields);
    const card = validateCard(spec.kind, fields);
    if (typeof card === "string") return failed(card);
    if (request.signal.aborted) throw new Error(`The conversation stopped waiting before the ${writerName} was called.`);
    const saved = await createFromCard(card, { requestId: studioRequestId(request.operationId), writers: argv ? { [spec.kind]: argv } : {}, run: deps.run ?? spawnWithStdin, db: deps.db, now: (deps.now ?? Date.now)(), timeoutMs: (desk.ask?.timeoutSeconds ?? 30) * 1000 });
    if (saved.ok) return { state: "created", canonicalId: saved.id };
    if (saved.uncertain) throw new Error(saved.error);
    const found = spec.afterRefusal ? await spec.afterRefusal(request, saved.error) : { found: false as const };
    if (!found) throw new Error(`${sentence(saved.error)} Whether the ${writerName} created anything could not be checked.`);
    return found.found ? { state: "created", canonicalId: found.canonicalId } : failed(saved.error);
  };
  return { create, readback: spec.readback ?? (() => Promise.resolve(null)) };
}
