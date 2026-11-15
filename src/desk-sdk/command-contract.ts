export { MailHeadersSchema, MailInvitationSchema, MailLinkSchema, SourceEventSchema, SourceMailSchema, SourceOutputSchema, SourceSentSchema } from "../surface/mc/desk/sources/command";
export type { MailHeaders, MailInvitation, MailLink, SourceEvent, SourceMail, SourceSent } from "../surface/mc/desk/sources/command";
export { WriterAnswer } from "../surface/mc/desk/create";
export { CloseAnswer } from "../surface/mc/desk/mail-handoff-close";
export { FIELD_SCHEMAS as ParserFieldSchemas, ParserAnswerSchema } from "../surface/mc/desk/ask";
export type { AskCard, AskFields, AskKind, ParserRequest } from "../surface/mc/desk/ask";

import type { AskCard } from "../surface/mc/desk/ask";

/** What the Desk writes to a writer command's stdin: the confirmed card plus the request id a retry reuses. */
export type WriterRequest = AskCard & { requestId: string };
