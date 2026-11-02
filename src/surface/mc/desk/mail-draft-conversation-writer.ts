import type { CreateResult, OwnerWriter } from "../../../conversations/types";
import type { DeskOptions } from "./compose";
import { spawnWithStdin, type WriterRunner } from "./create";
import { draftReply, type ListedMail, type TrashLedger } from "./mail-actions";

export interface MailDraftWriterDeps {
  desk: () => DeskOptions | undefined;
  listedMail: (key: string) => ListedMail | null;
  ledger: TrashLedger;
  run?: WriterRunner;
  now?: () => number;
}

const NOTHING = "Nothing was created.";
const failed = (text: string): CreateResult => ({ state: "failed", error: `${text.trim().replace(/[.\s]+$/, "")}. ${NOTHING}` });
const MAY_BE_SAVED = /check .*drafts/i;

export const mailDraftReady = (desk: DeskOptions | undefined): boolean => Boolean(desk?.enabled && desk.mailActions?.draft?.length);

export function mailDraftWriter(deps: MailDraftWriterDeps): OwnerWriter {
  return {
    create: async request => {
      const desk = deps.desk();
      if (!desk || !mailDraftReady(desk)) return failed("Drafting replies is not set up on this stack");
      const mail = deps.listedMail(request.fields.mail ?? "");
      if (!mail) return failed("That mail is no longer on the Desk");
      if (request.signal.aborted) throw new Error("The conversation stopped waiting before the draft command was called.");
      const saved = await draftReply(mail, request.fields.body ?? "", { config: desk.mailActions, ledger: deps.ledger, run: deps.run ?? spawnWithStdin, now: (deps.now ?? Date.now)() });
      if (saved.ok) return { state: "created", canonicalId: saved.id };
      if (MAY_BE_SAVED.test(saved.error)) throw new Error(saved.error);
      return failed(saved.error);
    },
    readback: () => Promise.resolve(null),
  };
}
