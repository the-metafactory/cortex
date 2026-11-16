import { z } from "zod";
import { DEFER_ACTIONS } from "../surface/mc/api/desk-items-defer";
import { ADAPTER_CAPABILITY_ACTION, STUDIO_RESPOND_ACTION } from "../surface/mc/desk/adapter-actions";
import { FIELD_SCHEMAS } from "../surface/mc/desk/ask";
import { HANDOFF_KEY_PREFIX, MAX_INSTRUCTION } from "../surface/mc/desk/handoff";
import { CORRECTION_MOVES } from "../surface/mc/desk/mail-correction-schema";
import { RULE_ACTIONS, RULE_MATCHES } from "../surface/mc/desk/mail-rules-schema";
import { SNOOZE_TIMES } from "../surface/mc/desk/mail-snooze-schema";
import { SWEEP_WORDS } from "../surface/mc/desk/mail-sweep-schema";
import { WAITING_OPS } from "../surface/mc/desk/mail-waiting-schema";
import { DESK_PHRASE_CODES } from "../surface/mc/desk/phrases";
import { DESK_ITEM_KINDS } from "../surface/mc/desk/types";
import { MAIL_ROUND_ACTIONS, MAIL_ROUND_GROUP_KINDS, MAIL_ROUND_UNDO_OUTCOMES } from "../surface/mc/desk/mail-round";
import { OUTLINE_REPEAT_FIELDS, OUTLINE_REPEAT_MODES, OUTLINE_REPEAT_UNITS, OUTLINE_TIME_FIELDS } from "../surface/mc/desk/balance-command";
import { DEFAULT_MAIL_ROUND_SLOTS } from "../common/types/desk-mail-rounds";

export const DESK_API_VERSION = "1.4.0";
const DESK_API_VERSION_HEADER = "x-desk-api-version";
export const DESK_CONTRACT_PATH = "/api/desk/contract";

const fieldSchemasAsJson = (): Record<string, unknown> =>
  Object.fromEntries(Object.entries(FIELD_SCHEMAS).map(([kind, schema]) => [kind, z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })]));

export function deskContract() {
  return {
    version: DESK_API_VERSION,
    phraseCodes: DESK_PHRASE_CODES,
    vocabularies: {
      ADAPTER_CAPABILITY_ACTION,
      STUDIO_RESPOND_ACTION,
      FIELD_SCHEMAS: fieldSchemasAsJson(),
      HANDOFF_KEY_PREFIX,
      CORRECTION_MOVES,
      MAX_INSTRUCTION,
      RULE_ACTIONS,
      RULE_MATCHES,
      SNOOZE_TIMES,
      DEFER_ACTIONS,
      SWEEP_WORDS,
      WAITING_OPS,
      DESK_ITEM_KINDS,
      MAIL_ROUND_GROUP_KINDS,
      MAIL_ROUND_ACTIONS,
      MAIL_ROUND_UNDO_OUTCOMES,
      DEFAULT_MAIL_ROUND_SLOTS,
      OUTLINE_TIME_FIELDS,
      OUTLINE_REPEAT_MODES,
      OUTLINE_REPEAT_UNITS,
      OUTLINE_REPEAT_FIELDS,
    },
  };
}

const UNVERSIONED = ["/api/conversations/discord/check", "/api/desk/adapters"];

const underPath = (pathname: string, base: string): boolean => pathname === base || pathname.startsWith(`${base}/`);

function carriesDeskApiVersion(pathname: string): boolean {
  if (UNVERSIONED.some((base) => underPath(pathname, base))) return false;
  return underPath(pathname, "/api/desk") || underPath(pathname, "/api/conversations") || pathname === "/api/vigil/subjects";
}

export function withDeskApiVersion(pathname: string, response: Response): Response {
  if (!carriesDeskApiVersion(pathname)) return response;
  response.headers.set(DESK_API_VERSION_HEADER, DESK_API_VERSION);
  return response;
}
