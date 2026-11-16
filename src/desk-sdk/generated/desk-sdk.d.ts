// ============================================================================
// glossary-ignore: host, run, message, body
// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Self-contained type artifact for the Desk adapter SDK. Out-of-tree Desk
// adapter packages resolve it via
//   import type { AdapterDeclaration, DeskAdapterHost, … }
//     from "@the-metafactory/cortex/desk-sdk";
// (package.json exports["./desk-sdk"].types points here).
//
// Regenerate after ANY change to src/desk-sdk/index.ts or the contract types
// it re-exports:
//   bun run desk:dts
//
// CI fails on drift between this committed file and a fresh regeneration, and
// scripts/check-desk-sdk.ts requires a DESK_ADAPTER_SDK_VERSION bump whenever
// the contract shape changes.
// ============================================================================

import { z } from 'zod';

export declare const DESK_ADAPTER_SDK_VERSION = "1.18.0";
declare const AUTH_VERDICTS: readonly [
	"pass",
	"fail",
	"softfail",
	"neutral",
	"none",
	"temperror",
	"permerror",
	"policy"
];
/** Headers a mail source may report. Untrusted: each field that does not fit is dropped on its own, never the mail. */
export declare const MailHeadersSchema: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodObject<{
	listId: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	listUnsubscribe: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	listUnsubscribePost: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	authResults: z.ZodCatch<z.ZodOptional<z.ZodObject<{
		spf: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
			pass: "pass";
			fail: "fail";
			softfail: "softfail";
			neutral: "neutral";
			none: "none";
			temperror: "temperror";
			permerror: "permerror";
			policy: "policy";
		}>>>>;
		dkim: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
			pass: "pass";
			fail: "fail";
			softfail: "softfail";
			neutral: "neutral";
			none: "none";
			temperror: "temperror";
			permerror: "permerror";
			policy: "policy";
		}>>>>;
		dmarc: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
			pass: "pass";
			fail: "fail";
			softfail: "softfail";
			neutral: "neutral";
			none: "none";
			temperror: "temperror";
			permerror: "permerror";
			policy: "policy";
		}>>>>;
		dkimDomains: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<string[], unknown[]>>>>;
		spfDomain: z.ZodCatch<z.ZodOptional<z.ZodString>>;
	}, z.core.$strip>>>;
	replyTo: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	inReplyTo: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	references: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<string[], unknown[]>>>>;
}, z.core.$strip>, z.ZodTransform<MailHeaders | undefined, {
	listId?: string | undefined;
	listUnsubscribe?: string | undefined;
	listUnsubscribePost?: string | undefined;
	authResults?: {
		spf?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
		dkim?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
		dmarc?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
		dkimDomains?: string[] | undefined;
		spfDomain?: string | undefined;
	} | undefined;
	replyTo?: string | undefined;
	inReplyTo?: string | undefined;
	references?: string[] | undefined;
}>>>>;
export interface MailHeaders {
	listId?: string;
	listUnsubscribe?: string;
	listUnsubscribePost?: string;
	authResults?: Partial<Record<"spf" | "dkim" | "dmarc", (typeof AUTH_VERDICTS)[number]>> & {
		dkimDomains?: string[];
		spfDomain?: string;
	};
	replyTo?: string;
	inReplyTo?: string;
	references?: string[];
}
export declare const MailLinkSchema: z.ZodObject<{
	text: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
	href: z.ZodString;
}, z.core.$strip>;
export interface MailLink {
	text: string;
	href: string;
}
/** A meeting request a mail carries (iTIP METHOD:REQUEST), as the mail source read it. Untrusted; a bad one is dropped alone. */
export declare const MailInvitationSchema: z.ZodCatch<z.ZodOptional<z.ZodObject<{
	method: z.ZodLiteral<"REQUEST">;
	uid: z.ZodString;
	sequence: z.ZodCatch<z.ZodNumber>;
	summary: z.ZodCatch<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>;
	start: z.ZodString;
	end: z.ZodCatch<z.ZodOptional<z.ZodString>>;
	allDay: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
	location: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	organizer: z.ZodObject<{
		address: z.ZodPipe<z.ZodString, z.ZodString>;
		name: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	}, z.core.$strip>;
	attendee: z.ZodCatch<z.ZodOptional<z.ZodObject<{
		address: z.ZodPipe<z.ZodString, z.ZodString>;
		status: z.ZodCatch<z.ZodEnum<{
			"NEEDS-ACTION": "NEEDS-ACTION";
			ACCEPTED: "ACCEPTED";
			DECLINED: "DECLINED";
			TENTATIVE: "TENTATIVE";
			DELEGATED: "DELEGATED";
		}>>;
		rsvp: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
	}, z.core.$strip>>>;
	recurring: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
	attendees: z.ZodCatch<z.ZodNumber>;
}, z.core.$strip>>>;
export type MailInvitation = NonNullable<z.infer<typeof MailInvitationSchema>>;
export declare const SourceMailSchema: z.ZodObject<{
	kind: z.ZodLiteral<"mail">;
	id: z.ZodString;
	from: z.ZodObject<{
		name: z.ZodOptional<z.ZodString>;
		address: z.ZodString;
	}, z.core.$strip>;
	subject: z.ZodString;
	receivedAt: z.ZodString;
	dueAt: z.ZodCatch<z.ZodOptional<z.ZodString>>;
	unread: z.ZodBoolean;
	firstParagraph: z.ZodOptional<z.ZodString>;
	url: z.ZodOptional<z.ZodString>;
	account: z.ZodOptional<z.ZodString>;
	headers: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodObject<{
		listId: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		listUnsubscribe: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		listUnsubscribePost: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		authResults: z.ZodCatch<z.ZodOptional<z.ZodObject<{
			spf: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
				pass: "pass";
				fail: "fail";
				softfail: "softfail";
				neutral: "neutral";
				none: "none";
				temperror: "temperror";
				permerror: "permerror";
				policy: "policy";
			}>>>>;
			dkim: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
				pass: "pass";
				fail: "fail";
				softfail: "softfail";
				neutral: "neutral";
				none: "none";
				temperror: "temperror";
				permerror: "permerror";
				policy: "policy";
			}>>>>;
			dmarc: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodEnum<{
				pass: "pass";
				fail: "fail";
				softfail: "softfail";
				neutral: "neutral";
				none: "none";
				temperror: "temperror";
				permerror: "permerror";
				policy: "policy";
			}>>>>;
			dkimDomains: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<string[], unknown[]>>>>;
			spfDomain: z.ZodCatch<z.ZodOptional<z.ZodString>>;
		}, z.core.$strip>>>;
		replyTo: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		inReplyTo: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		references: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<string[], unknown[]>>>>;
	}, z.core.$strip>, z.ZodTransform<MailHeaders | undefined, {
		listId?: string | undefined;
		listUnsubscribe?: string | undefined;
		listUnsubscribePost?: string | undefined;
		authResults?: {
			spf?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
			dkim?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
			dmarc?: "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | undefined;
			dkimDomains?: string[] | undefined;
			spfDomain?: string | undefined;
		} | undefined;
		replyTo?: string | undefined;
		inReplyTo?: string | undefined;
		references?: string[] | undefined;
	}>>>>;
	links: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<MailLink[], unknown[]>>>>;
	invitation: z.ZodCatch<z.ZodOptional<z.ZodObject<{
		method: z.ZodLiteral<"REQUEST">;
		uid: z.ZodString;
		sequence: z.ZodCatch<z.ZodNumber>;
		summary: z.ZodCatch<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>;
		start: z.ZodString;
		end: z.ZodCatch<z.ZodOptional<z.ZodString>>;
		allDay: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
		location: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		organizer: z.ZodObject<{
			address: z.ZodPipe<z.ZodString, z.ZodString>;
			name: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		}, z.core.$strip>;
		attendee: z.ZodCatch<z.ZodOptional<z.ZodObject<{
			address: z.ZodPipe<z.ZodString, z.ZodString>;
			status: z.ZodCatch<z.ZodEnum<{
				"NEEDS-ACTION": "NEEDS-ACTION";
				ACCEPTED: "ACCEPTED";
				DECLINED: "DECLINED";
				TENTATIVE: "TENTATIVE";
				DELEGATED: "DELEGATED";
			}>>;
			rsvp: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
		}, z.core.$strip>>>;
		recurring: z.ZodCatch<z.ZodOptional<z.ZodBoolean>>;
		attendees: z.ZodCatch<z.ZodNumber>;
	}, z.core.$strip>>>;
}, z.core.$strip>;
/**
 * A calendar event. `organizer` and `attendees` are the meeting's people, read by the `mail.link-meeting` auto-link. Entries whose
 * address does not parse are dropped, but the list still counts as given: an unreadable organizer becomes null, and an attendee
 * value that is not an array, or a nonempty one with no readable entry, becomes empty, so the auto-link refuses every sender rather than none.
 */
export declare const SourceEventSchema: z.ZodObject<{
	id: z.ZodString;
	start: z.ZodString;
	end: z.ZodOptional<z.ZodString>;
	allDay: z.ZodOptional<z.ZodBoolean>;
	title: z.ZodString;
	calendar: z.ZodOptional<z.ZodString>;
	calendarId: z.ZodOptional<z.ZodString>;
	location: z.ZodOptional<z.ZodString>;
	online: z.ZodOptional<z.ZodBoolean>;
	url: z.ZodOptional<z.ZodString>;
	availability: z.ZodOptional<z.ZodObject<{
		status: z.ZodEnum<{
			unknown: "unknown";
			busy: "busy";
			free: "free";
		}>;
		provenance: z.ZodString;
	}, z.core.$strip>>;
	organizer: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodTransform<{
		address: string;
		name?: string | undefined;
	} | null | undefined, unknown>>>;
	attendees: z.ZodOptional<z.ZodPipe<z.ZodUnknown, z.ZodTransform<{
		address: string;
		name?: string | undefined;
	}[] | undefined, unknown>>>;
}, z.core.$strip>;
/** A mail the account sent (cortex#2983): its recipients, its thread headers and the replies the source found. */
export declare const SourceSentSchema: z.ZodObject<{
	kind: z.ZodLiteral<"sent">;
	id: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
	from: z.ZodObject<{
		name: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		address: z.ZodPipe<z.ZodString, z.ZodString>;
	}, z.core.$strip>;
	to: z.ZodPipe<z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<{
		address: string;
		name?: string | undefined;
	}[], unknown[]>>>>, z.ZodArray<z.ZodObject<{
		name: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
		address: z.ZodPipe<z.ZodString, z.ZodString>;
	}, z.core.$strip>>>;
	subject: z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>;
	sentAt: z.ZodString;
	text: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodTransform<string, string>>>>;
	url: z.ZodCatch<z.ZodOptional<z.ZodString>>;
	account: z.ZodOptional<z.ZodString>;
	inReplyTo: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodPipe<z.ZodString, z.ZodTransform<string, string>>, z.ZodString>>>;
	references: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<string[], unknown[]>>>>;
	replies: z.ZodCatch<z.ZodOptional<z.ZodPipe<z.ZodArray<z.ZodUnknown>, z.ZodTransform<{
		id: string;
		from: {
			address: string;
			name?: string | undefined;
		};
		at: string;
	}[], unknown[]>>>>;
}, z.core.$strip>;
export type SourceEvent = z.infer<typeof SourceEventSchema>;
export type SourceMail = z.infer<typeof SourceMailSchema>;
export type SourceSent = z.infer<typeof SourceSentSchema>;
export declare const SourceOutputSchema: z.ZodObject<{
	events: z.ZodOptional<z.ZodUnknown>;
	items: z.ZodOptional<z.ZodUnknown>;
}, z.core.$loose>;
declare const ParserPermissionsSchema: z.ZodObject<{
	permitted: z.ZodArray<z.ZodEnum<{
		codex: "codex";
		pi: "pi";
	}>>;
}, z.core.$strict>;
export type ParserPermissions = z.infer<typeof ParserPermissionsSchema>;
declare const ASK_KINDS: readonly [
	"reminder",
	"note",
	"capture",
	"task",
	"goal",
	"calendar",
	"routine",
	"conversation",
	"row"
];
export type AskKind = (typeof ASK_KINDS)[number];
declare const FIELD_SCHEMAS: {
	routine: z.ZodObject<{
		proposalId: z.ZodUUID;
	}, z.core.$strip>;
	row: z.ZodObject<{
		title: z.ZodString;
		area: z.ZodString;
		repeat: z.ZodObject<{
			mode: z.ZodOptional<z.ZodEnum<{
				calendar: "calendar";
				completion: "completion";
			}>>;
			unit: z.ZodEnum<{
				month: "month";
				day: "day";
				week: "week";
			}>;
			interval: z.ZodNumber;
			weekdays: z.ZodOptional<z.ZodArray<z.ZodNumber>>;
			count: z.ZodOptional<z.ZodNumber>;
			until: z.ZodOptional<z.ZodISODate>;
		}, z.core.$strict>;
	}, z.core.$strip>;
	conversation: z.ZodObject<{
		text: z.ZodString;
		area: z.ZodOptional<z.ZodString>;
	}, z.core.$strip>;
	reminder: z.ZodObject<{
		text: z.ZodString;
		due: z.ZodString;
	}, z.core.$strip>;
	note: z.ZodObject<{
		text: z.ZodString;
	}, z.core.$strip>;
	capture: z.ZodObject<{
		text: z.ZodString;
	}, z.core.$strip>;
	task: z.ZodObject<{
		title: z.ZodString;
		details: z.ZodOptional<z.ZodString>;
		map: z.ZodString;
	}, z.core.$strip>;
	goal: z.ZodObject<{
		wording: z.ZodString;
	}, z.core.$strip>;
	calendar: z.ZodObject<{
		title: z.ZodString;
		start: z.ZodString;
		end: z.ZodOptional<z.ZodString>;
		allDay: z.ZodOptional<z.ZodBoolean>;
		location: z.ZodOptional<z.ZodString>;
		notes: z.ZodOptional<z.ZodString>;
	}, z.core.$strip>;
};
export type AskFields = {
	[K in AskKind]: z.infer<(typeof FIELD_SCHEMAS)[K]>;
};
export type AskCard = {
	[K in AskKind]: {
		kind: K;
		fields: AskFields[K];
	};
}[AskKind];
export interface AskMap {
	ref: string;
	label: string;
}
export interface ParserRequest {
	text: string;
	now: string;
	timeZone: string;
	kinds: AskKind[];
	maps: AskMap[];
	routing?: ParserPermissions;
}
export declare const ParserAnswerSchema: z.ZodObject<{
	kind: z.ZodString;
	fields: z.ZodOptional<z.ZodUnknown>;
	reason: z.ZodOptional<z.ZodString>;
	routing: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;
export declare const WriterAnswer: z.ZodObject<{
	id: z.ZodString;
	url: z.ZodOptional<z.ZodString>;
	message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const CloseAnswer: z.ZodObject<{
	id: z.ZodString;
	message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/** What the Desk writes to a writer command's stdin: the confirmed card plus the request id a retry reuses. */
export type WriterRequest = AskCard & {
	requestId: string;
};
export declare const MailMoveCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"move">;
	target: z.ZodEnum<{
		junk: "junk";
		archive: "archive";
		trash: "trash";
	}>;
}, z.core.$strip>;
export declare const MailRestoreCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"restore">;
	from: z.ZodEnum<{
		junk: "junk";
		archive: "archive";
		trash: "trash";
	}>;
}, z.core.$strip>;
export declare const MailTrashCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"trash">;
}, z.core.$strip>;
export declare const MailLocateCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"locate">;
}, z.core.$strip>;
export declare const MailDraftCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"draft">;
	to: z.ZodString;
	subject: z.ZodString;
	body: z.ZodString;
}, z.core.$strip>;
export declare const MailReportCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"report">;
	to: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
export declare const MailInvitationReplyCommandRequestSchema: z.ZodObject<{
	account: z.ZodString;
	messageId: z.ZodString;
	action: z.ZodLiteral<"invite-reply">;
	uid: z.ZodString;
	reply: z.ZodEnum<{
		decline: "decline";
		accept: "accept";
	}>;
	requestId: z.ZodString;
}, z.core.$strip>;
export declare const MailMoveCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	message: z.ZodCatch<z.ZodString>;
	folder: z.ZodCatch<z.ZodPipe<z.ZodString, z.ZodTransform<string | null, string>>>;
}, z.core.$strip>>>;
export declare const MailRestoreCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	message: z.ZodCatch<z.ZodString>;
	folder: z.ZodCatch<z.ZodPipe<z.ZodString, z.ZodTransform<string | null, string>>>;
}, z.core.$strip>>>;
export declare const MailTrashCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	message: z.ZodCatch<z.ZodString>;
	folder: z.ZodCatch<z.ZodPipe<z.ZodString, z.ZodTransform<string | null, string>>>;
}, z.core.$strip>>>;
export declare const MailLocateCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodObject<{
	place: z.ZodEnum<{
		junk: "junk";
		archive: "archive";
		trash: "trash";
		gone: "gone";
		inbox: "inbox";
	}>;
	folder: z.ZodCatch<z.ZodPipe<z.ZodString, z.ZodTransform<string | null, string>>>;
	unread: z.ZodPipe<z.ZodUnknown, z.ZodTransform<boolean, unknown>>;
}, z.core.$strip>>;
export declare const MailDraftCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	id: z.ZodCatch<z.ZodString>;
}, z.core.$strip>>>;
export declare const MailReportCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	message: z.ZodCatch<z.ZodString>;
}, z.core.$strip>>>;
export declare const MailInvitationReplyCommandResultSchema: z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodCatch<z.ZodObject<{
	message: z.ZodCatch<z.ZodString>;
}, z.core.$strip>>>;
export declare const PushCommandRequestSchema: z.ZodObject<{
	key: z.ZodString;
	title: z.ZodString;
	why: z.ZodString;
	action: z.ZodOptional<z.ZodObject<{
		label: z.ZodString;
		url: z.ZodURL;
	}, z.core.$strip>>;
	reason: z.ZodOptional<z.ZodObject<{
		code: z.ZodEnum<{
			"meeting.soon": "meeting.soon";
			"reminder.due": "reminder.due";
			"mail.meeting-today": "mail.meeting-today";
			"mail.deadline-today": "mail.deadline-today";
			"mail.vip": "mail.vip";
			"mail.ranked": "mail.ranked";
		}>;
		phrase: z.ZodObject<{
			code: z.ZodEnum<{
				"meeting.soon": "meeting.soon";
				"reminder.due": "reminder.due";
				"mail.meeting-today": "mail.meeting-today";
				"mail.deadline-today": "mail.deadline-today";
				"mail.vip": "mail.vip";
				"mail.ranked": "mail.ranked";
			}>;
			params: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
		}, z.core.$strip>;
		target: z.ZodOptional<z.ZodString>;
		eventKey: z.ZodOptional<z.ZodString>;
		dueAt: z.ZodOptional<z.ZodString>;
	}, z.core.$strip>>;
	held: z.ZodOptional<z.ZodObject<{
		eventKey: z.ZodString;
		title: z.ZodString;
		until: z.ZodNumber;
	}, z.core.$strip>>;
}, z.core.$strip>;
declare const SchemaRefSchema: z.ZodObject<{
	schemaId: z.ZodString;
	version: z.ZodString;
}, z.core.$strict>;
declare const ObjectReferenceSchema: z.ZodObject<{
	adapterId: z.ZodString;
	connectionId: z.ZodString;
	objectType: z.ZodString;
	canonicalId: z.ZodString;
}, z.core.$strict>;
declare const AdapterDeclarationSchema: z.ZodObject<{
	adapterId: z.ZodString;
	label: z.ZodString;
	contractRange: z.ZodString;
	schemas: z.ZodArray<z.ZodObject<{
		schemaId: z.ZodString;
		version: z.ZodString;
		schema: z.ZodUnion<readonly [
			z.ZodBoolean,
			z.ZodRecord<z.ZodString, z.ZodJSONSchema>
		]>;
	}, z.core.$strict>>;
	objectTypes: z.ZodArray<z.ZodObject<{
		objectType: z.ZodString;
		label: z.ZodString;
		schemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		relationships: z.ZodArray<z.ZodObject<{
			fieldPath: z.ZodString;
			targetAdapterId: z.ZodString;
			targetObjectType: z.ZodString;
			cardinality: z.ZodEnum<{
				one: "one";
				many: "many";
			}>;
		}, z.core.$strict>>;
	}, z.core.$strict>>;
	capabilities: z.ZodArray<z.ZodObject<{
		capabilityId: z.ZodString;
		label: z.ZodString;
		kind: z.ZodEnum<{
			action: "action";
			observation: "observation";
			query: "query";
		}>;
		objectTypes: z.ZodArray<z.ZodString>;
		inputSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		outputSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		errorSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
	}, z.core.$strict>>;
	uiHints: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodJSONSchema>>;
}, z.core.$strict>;
declare const BoundaryErrorSchema: z.ZodObject<{
	code: z.ZodString;
	message: z.ZodString;
	issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
		path: z.ZodString;
		code: z.ZodString;
		message: z.ZodString;
	}, z.core.$strict>>>;
}, z.core.$strict>;
export type SchemaRef = z.infer<typeof SchemaRefSchema>;
export type ObjectReference = z.infer<typeof ObjectReferenceSchema>;
export type AdapterDeclaration = z.infer<typeof AdapterDeclarationSchema>;
export type CapabilityDeclaration = AdapterDeclaration["capabilities"][number];
export type BoundaryError = z.infer<typeof BoundaryErrorSchema>;
export type Result<T> = {
	ok: true;
	value: T;
} | {
	ok: false;
	error: BoundaryError;
};
declare const json: z.ZodJSONSchema;
declare const ProvenanceSchema: z.ZodObject<{
	conversationId: z.ZodString;
	proposalId: z.ZodString;
	revision: z.ZodNumber;
	entryId: z.ZodNullable<z.ZodString>;
	link: z.ZodString;
}, z.core.$strict>;
declare const ApprovedSnapshotSchema: z.ZodObject<{
	provenance: z.ZodObject<{
		conversationId: z.ZodString;
		proposalId: z.ZodString;
		revision: z.ZodNumber;
		entryId: z.ZodNullable<z.ZodString>;
		link: z.ZodString;
	}, z.core.$strict>;
	adapterId: z.ZodString;
	connectionId: z.ZodString;
	capabilityId: z.ZodString;
	inputSchemaRef: z.ZodObject<{
		schemaId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>;
	outputSchemaRef: z.ZodObject<{
		schemaId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>;
	errorSchemaRef: z.ZodObject<{
		schemaId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>;
	input: z.ZodJSONSchema;
	destinations: z.ZodArray<z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>>;
	target: z.ZodOptional<z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>>;
	expectedOwnerRevision: z.ZodOptional<z.ZodString>;
	sources: z.ZodArray<z.ZodObject<{
		ref: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		restrictionRef: z.ZodString;
	}, z.core.$strict>>;
	policy: z.ZodEnum<{
		local: "local";
		cloud: "cloud";
	}>;
	digest: z.ZodString;
}, z.core.$strict>;
declare const OwnerSupportSchema: z.ZodObject<{
	adapterId: z.ZodString;
	connectionId: z.ZodString;
	capabilityId: z.ZodString;
	declarationId: z.ZodString;
	dedup: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"none">;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"guaranteed">;
			scope: z.ZodLiteral<"connection-capability">;
			retentionMs: z.ZodNumber;
			bindsSnapshot: z.ZodLiteral<true>;
			concurrent: z.ZodLiteral<true>;
		}, z.core.$strict>
	], "kind">;
	operationLookup: z.ZodEnum<{
		none: "none";
		historical: "historical";
	}>;
	conditionalUpdate: z.ZodEnum<{
		none: "none";
		"owner-enforced": "owner-enforced";
	}>;
	cancellation: z.ZodEnum<{
		none: "none";
		"best-effort": "best-effort";
		"confirmed-no-effect": "confirmed-no-effect";
	}>;
	compensationCapabilityId: z.ZodOptional<z.ZodString>;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
declare const OwnerResultSchema: z.ZodObject<{
	operationId: z.ZodString;
	attemptId: z.ZodString;
	snapshotDigest: z.ZodString;
	resultId: z.ZodString;
	reportedAt: z.ZodISODateTime;
	result: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"accepted">;
			ownerRequestId: z.ZodString;
			receipt: z.ZodJSONSchema;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"succeeded">;
			output: z.ZodJSONSchema;
			evidence: z.ZodObject<{
				kind: z.ZodLiteral<"effect">;
				evidenceId: z.ZodString;
				observedAt: z.ZodISODateTime;
				ownerRequestId: z.ZodString;
				receipt: z.ZodJSONSchema;
				refs: z.ZodArray<z.ZodObject<{
					adapterId: z.ZodString;
					connectionId: z.ZodString;
					objectType: z.ZodString;
					canonicalId: z.ZodString;
				}, z.core.$strict>>;
				ownerRevision: z.ZodOptional<z.ZodString>;
			}, z.core.$strict>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"failed">;
			error: z.ZodObject<{
				code: z.ZodString;
				message: z.ZodString;
				issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
					path: z.ZodString;
					code: z.ZodString;
					message: z.ZodString;
				}, z.core.$strict>>>;
			}, z.core.$strict>;
			evidence: z.ZodObject<{
				kind: z.ZodLiteral<"no-effect">;
				evidenceId: z.ZodString;
				observedAt: z.ZodISODateTime;
				ownerRequestId: z.ZodString;
				receipt: z.ZodJSONSchema;
				final: z.ZodLiteral<true>;
			}, z.core.$strict>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"conflict">;
			error: z.ZodObject<{
				code: z.ZodString;
				message: z.ZodString;
				issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
					path: z.ZodString;
					code: z.ZodString;
					message: z.ZodString;
				}, z.core.$strict>>>;
			}, z.core.$strict>;
			currentOwnerRevision: z.ZodString;
			evidence: z.ZodObject<{
				kind: z.ZodLiteral<"no-effect">;
				evidenceId: z.ZodString;
				observedAt: z.ZodISODateTime;
				ownerRequestId: z.ZodString;
				receipt: z.ZodJSONSchema;
				final: z.ZodLiteral<true>;
			}, z.core.$strict>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"cancelled">;
			evidence: z.ZodObject<{
				kind: z.ZodLiteral<"no-effect">;
				evidenceId: z.ZodString;
				observedAt: z.ZodISODateTime;
				ownerRequestId: z.ZodString;
				receipt: z.ZodJSONSchema;
				final: z.ZodLiteral<true>;
			}, z.core.$strict>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"uncertain">;
			error: z.ZodObject<{
				code: z.ZodString;
				message: z.ZodString;
				issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
					path: z.ZodString;
					code: z.ZodString;
					message: z.ZodString;
				}, z.core.$strict>>>;
			}, z.core.$strict>;
			ownerRequestId: z.ZodOptional<z.ZodString>;
			receipt: z.ZodOptional<z.ZodJSONSchema>;
		}, z.core.$strict>
	], "kind">;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
declare const DispatchRequestSchema: z.ZodObject<{
	operationId: z.ZodString;
	attemptId: z.ZodString;
	idempotencyKey: z.ZodString;
	ownerRequestId: z.ZodString;
	snapshot: z.ZodObject<{
		provenance: z.ZodObject<{
			conversationId: z.ZodString;
			proposalId: z.ZodString;
			revision: z.ZodNumber;
			entryId: z.ZodNullable<z.ZodString>;
			link: z.ZodString;
		}, z.core.$strict>;
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		capabilityId: z.ZodString;
		inputSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		outputSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		errorSchemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		input: z.ZodJSONSchema;
		destinations: z.ZodArray<z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>>;
		target: z.ZodOptional<z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>>;
		expectedOwnerRevision: z.ZodOptional<z.ZodString>;
		sources: z.ZodArray<z.ZodObject<{
			ref: z.ZodObject<{
				adapterId: z.ZodString;
				connectionId: z.ZodString;
				objectType: z.ZodString;
				canonicalId: z.ZodString;
			}, z.core.$strict>;
			restrictionRef: z.ZodString;
		}, z.core.$strict>>;
		policy: z.ZodEnum<{
			local: "local";
			cloud: "cloud";
		}>;
		digest: z.ZodString;
	}, z.core.$strict>;
	authority: z.ZodObject<{
		principalRef: z.ZodString;
		basis: z.ZodDiscriminatedUnion<[
			z.ZodObject<{
				kind: z.ZodLiteral<"confirmation">;
				confirmationId: z.ZodString;
				transport: z.ZodEnum<{
					web: "web";
					discord: "discord";
				}>;
			}, z.core.$strict>,
			z.ZodObject<{
				kind: z.ZodLiteral<"grant">;
				grantId: z.ZodString;
				grantRevision: z.ZodString;
			}, z.core.$strict>
		], "kind">;
		connectionRevision: z.ZodString;
		policyRevision: z.ZodString;
		decisionRef: z.ZodString;
		authorizedAt: z.ZodISODateTime;
	}, z.core.$strict>;
	supportDeclarationId: z.ZodString;
	deadlineAt: z.ZodISODateTime;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
declare const OperationLookupSchema: z.ZodObject<{
	operationId: z.ZodString;
	checkedAt: z.ZodISODateTime;
	result: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"known">;
			response: z.ZodObject<{
				operationId: z.ZodString;
				attemptId: z.ZodString;
				snapshotDigest: z.ZodString;
				resultId: z.ZodString;
				reportedAt: z.ZodISODateTime;
				result: z.ZodDiscriminatedUnion<[
					z.ZodObject<{
						kind: z.ZodLiteral<"accepted">;
						ownerRequestId: z.ZodString;
						receipt: z.ZodJSONSchema;
					}, z.core.$strict>,
					z.ZodObject<{
						kind: z.ZodLiteral<"succeeded">;
						output: z.ZodJSONSchema;
						evidence: z.ZodObject<{
							kind: z.ZodLiteral<"effect">;
							evidenceId: z.ZodString;
							observedAt: z.ZodISODateTime;
							ownerRequestId: z.ZodString;
							receipt: z.ZodJSONSchema;
							refs: z.ZodArray<z.ZodObject<{
								adapterId: z.ZodString;
								connectionId: z.ZodString;
								objectType: z.ZodString;
								canonicalId: z.ZodString;
							}, z.core.$strict>>;
							ownerRevision: z.ZodOptional<z.ZodString>;
						}, z.core.$strict>;
					}, z.core.$strict>,
					z.ZodObject<{
						kind: z.ZodLiteral<"failed">;
						error: z.ZodObject<{
							code: z.ZodString;
							message: z.ZodString;
							issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
								path: z.ZodString;
								code: z.ZodString;
								message: z.ZodString;
							}, z.core.$strict>>>;
						}, z.core.$strict>;
						evidence: z.ZodObject<{
							kind: z.ZodLiteral<"no-effect">;
							evidenceId: z.ZodString;
							observedAt: z.ZodISODateTime;
							ownerRequestId: z.ZodString;
							receipt: z.ZodJSONSchema;
							final: z.ZodLiteral<true>;
						}, z.core.$strict>;
					}, z.core.$strict>,
					z.ZodObject<{
						kind: z.ZodLiteral<"conflict">;
						error: z.ZodObject<{
							code: z.ZodString;
							message: z.ZodString;
							issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
								path: z.ZodString;
								code: z.ZodString;
								message: z.ZodString;
							}, z.core.$strict>>>;
						}, z.core.$strict>;
						currentOwnerRevision: z.ZodString;
						evidence: z.ZodObject<{
							kind: z.ZodLiteral<"no-effect">;
							evidenceId: z.ZodString;
							observedAt: z.ZodISODateTime;
							ownerRequestId: z.ZodString;
							receipt: z.ZodJSONSchema;
							final: z.ZodLiteral<true>;
						}, z.core.$strict>;
					}, z.core.$strict>,
					z.ZodObject<{
						kind: z.ZodLiteral<"cancelled">;
						evidence: z.ZodObject<{
							kind: z.ZodLiteral<"no-effect">;
							evidenceId: z.ZodString;
							observedAt: z.ZodISODateTime;
							ownerRequestId: z.ZodString;
							receipt: z.ZodJSONSchema;
							final: z.ZodLiteral<true>;
						}, z.core.$strict>;
					}, z.core.$strict>,
					z.ZodObject<{
						kind: z.ZodLiteral<"uncertain">;
						error: z.ZodObject<{
							code: z.ZodString;
							message: z.ZodString;
							issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
								path: z.ZodString;
								code: z.ZodString;
								message: z.ZodString;
							}, z.core.$strict>>>;
						}, z.core.$strict>;
						ownerRequestId: z.ZodOptional<z.ZodString>;
						receipt: z.ZodOptional<z.ZodJSONSchema>;
					}, z.core.$strict>
				], "kind">;
				lifecycleVersion: z.ZodLiteral<"1.0.0">;
			}, z.core.$strict>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"no-effect">;
			evidence: z.ZodObject<{
				kind: z.ZodLiteral<"no-effect">;
				evidenceId: z.ZodString;
				observedAt: z.ZodISODateTime;
				ownerRequestId: z.ZodString;
				receipt: z.ZodJSONSchema;
				final: z.ZodLiteral<true>;
			}, z.core.$strict>;
		}, z.core.$strict>,
		...z.ZodObject<{
			kind: z.ZodLiteral<"unknown" | "unavailable" | "denied">;
			reason: z.ZodObject<{
				code: z.ZodString;
				message: z.ZodString;
				issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
					path: z.ZodString;
					code: z.ZodString;
					message: z.ZodString;
				}, z.core.$strict>>>;
			}, z.core.$strict>;
		}, z.core.$strict>[]
	], "kind">;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
declare const ObjectReadbackSchema: z.ZodObject<{
	ref: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
	checkedAt: z.ZodISODateTime;
	provenance: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		evidenceId: z.ZodString;
	}, z.core.$strict>;
	result: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"present">;
			schemaRef: z.ZodObject<{
				schemaId: z.ZodString;
				version: z.ZodString;
			}, z.core.$strict>;
			value: z.ZodJSONSchema;
			ownerRevision: z.ZodOptional<z.ZodString>;
			links: z.ZodArray<z.ZodObject<{
				label: z.ZodString;
				url: z.ZodURL;
			}, z.core.$strict>>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"deleted">;
			evidenceId: z.ZodString;
			deletedAt: z.ZodOptional<z.ZodISODateTime>;
		}, z.core.$strict>,
		...z.ZodObject<{
			kind: z.ZodLiteral<"unknown" | "unavailable" | "denied">;
			reason: z.ZodObject<{
				code: z.ZodString;
				message: z.ZodString;
				issues: z.ZodOptional<z.ZodArray<z.ZodObject<{
					path: z.ZodString;
					code: z.ZodString;
					message: z.ZodString;
				}, z.core.$strict>>>;
			}, z.core.$strict>;
		}, z.core.$strict>[]
	], "kind">;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
declare const CancelRequestSchema: z.ZodObject<{
	operationId: z.ZodString;
	cancelId: z.ZodString;
	authority: z.ZodObject<{
		principalRef: z.ZodString;
		basis: z.ZodDiscriminatedUnion<[
			z.ZodObject<{
				kind: z.ZodLiteral<"confirmation">;
				confirmationId: z.ZodString;
				transport: z.ZodEnum<{
					web: "web";
					discord: "discord";
				}>;
			}, z.core.$strict>,
			z.ZodObject<{
				kind: z.ZodLiteral<"grant">;
				grantId: z.ZodString;
				grantRevision: z.ZodString;
			}, z.core.$strict>
		], "kind">;
		connectionRevision: z.ZodString;
		policyRevision: z.ZodString;
		decisionRef: z.ZodString;
		authorizedAt: z.ZodISODateTime;
	}, z.core.$strict>;
	requestedAt: z.ZodISODateTime;
	lifecycleVersion: z.ZodLiteral<"1.0.0">;
}, z.core.$strict>;
export type Json = z.infer<typeof json>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type ApprovedSnapshot = z.infer<typeof ApprovedSnapshotSchema>;
export type OwnerSupport = z.infer<typeof OwnerSupportSchema>;
export type OwnerResult = z.infer<typeof OwnerResultSchema>;
export type DispatchRequest = z.infer<typeof DispatchRequestSchema>;
export type OperationLookup = z.infer<typeof OperationLookupSchema>;
export type ObjectReadback = z.infer<typeof ObjectReadbackSchema>;
export type CancelRequest = z.infer<typeof CancelRequestSchema>;
export interface LookupRequest {
	lifecycleVersion: "1.0.0";
	operationId: string;
	ownerRequestId: string;
}
export interface ReadbackRequest {
	lifecycleVersion: "1.0.0";
	ref: ObjectReference;
}
declare const QuerySourceSchema: z.ZodObject<{
	connectionId: z.ZodString;
	capabilityId: z.ZodString;
	destinations: z.ZodArray<z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>>;
	input: z.ZodJSONSchema;
	adapterId: z.ZodString;
	inputSchemaRef: z.ZodObject<{
		schemaId: z.ZodString;
		version: z.ZodString;
	}, z.core.$strict>;
}, z.core.$strict>;
export type QuerySource = z.infer<typeof QuerySourceSchema>;
declare const QueryPageSchema: z.ZodObject<{
	readVersion: z.ZodLiteral<"1.0.0">;
	payload: z.ZodJSONSchema;
	annotations: z.ZodArray<z.ZodObject<{
		pointer: z.ZodString;
		ref: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		schemaRef: z.ZodObject<{
			schemaId: z.ZodString;
			version: z.ZodString;
		}, z.core.$strict>;
		destination: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		position: z.ZodNumber;
		evidence: z.ZodObject<{
			evidenceId: z.ZodString;
			revision: z.ZodString;
			observedAt: z.ZodISODateTime;
		}, z.core.$strict>;
	}, z.core.$strict>>;
	observedAt: z.ZodISODateTime;
	ordering: z.ZodLiteral<"provider">;
	snapshot: z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"stable">;
			id: z.ZodString;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"live">;
		}, z.core.$strict>
	], "kind">;
	cursor: z.ZodOptional<z.ZodString>;
}, z.core.$strict>;
export type QueryPage = z.infer<typeof QueryPageSchema>;
export interface QueryFetchRequest {
	readVersion: "1.0.0";
	queryId: string;
	capabilityId: string;
	input: Json;
	destinations: QuerySource["destinations"];
	cursor?: string;
	limit: number;
}
declare const ObservationBatchSchema: z.ZodObject<{
	version: z.ZodLiteral<"1.0.0">;
	payload: z.ZodJSONSchema;
	events: z.ZodArray<z.ZodDiscriminatedUnion<[
		z.ZodObject<{
			kind: z.ZodLiteral<"present">;
			pointer: z.ZodString;
			evidenceId: z.ZodOptional<z.ZodString>;
			ref: z.ZodObject<{
				adapterId: z.ZodString;
				connectionId: z.ZodString;
				objectType: z.ZodString;
				canonicalId: z.ZodString;
			}, z.core.$strict>;
			schemaRef: z.ZodObject<{
				schemaId: z.ZodString;
				version: z.ZodString;
			}, z.core.$strict>;
			destination: z.ZodObject<{
				adapterId: z.ZodString;
				connectionId: z.ZodString;
				objectType: z.ZodString;
				canonicalId: z.ZodString;
			}, z.core.$strict>;
			observedAt: z.ZodISODateTime;
			revision: z.ZodOptional<z.ZodString>;
		}, z.core.$strict>,
		z.ZodObject<{
			kind: z.ZodLiteral<"deleted">;
			evidenceId: z.ZodString;
			ownerDeletion: z.ZodLiteral<true>;
			ref: z.ZodObject<{
				adapterId: z.ZodString;
				connectionId: z.ZodString;
				objectType: z.ZodString;
				canonicalId: z.ZodString;
			}, z.core.$strict>;
			schemaRef: z.ZodObject<{
				schemaId: z.ZodString;
				version: z.ZodString;
			}, z.core.$strict>;
			destination: z.ZodObject<{
				adapterId: z.ZodString;
				connectionId: z.ZodString;
				objectType: z.ZodString;
				canonicalId: z.ZodString;
			}, z.core.$strict>;
			observedAt: z.ZodISODateTime;
			revision: z.ZodOptional<z.ZodString>;
		}, z.core.$strict>
	], "kind">>;
	checkpoint: z.ZodOptional<z.ZodObject<{
		cursor: z.ZodString;
		expiresAt: z.ZodNumber;
	}, z.core.$strict>>;
	continuation: z.ZodOptional<z.ZodString>;
	gap: z.ZodBoolean;
	coverage: z.ZodEnum<{
		none: "none";
		objects: "objects";
		watermark: "watermark";
	}>;
}, z.core.$strict>;
export type ObservationBatch = z.infer<typeof ObservationBatchSchema>;
export type ObservationMode = "poll" | "subscription" | "resync" | "reconcile";
export interface ObservationRequest {
	source: QuerySource;
	mode: ObservationMode;
	checkpoint?: string;
	continuation?: string;
	limit: number;
}
export type DeskMailExecutionMethod = "draft" | "lookup" | "move" | "restore" | "lookupMove" | "unsubscribe" | "lookupUnsubscribe" | "report" | "lookupReport";
export interface DeskMailExecutionConnection {
	readonly version: number;
	readonly methods: readonly DeskMailExecutionMethod[];
}
export interface DeskMailOperationContext {
	readonly operationId: string;
	readonly attemptId: string;
	readonly ownerRequestId: string;
	readonly snapshotDigest: string;
	readonly snapshot: ApprovedSnapshot;
}
export interface DeskMailExecutionBridge {
	connection(connection: DeskAdapterConnection): DeskMailExecutionConnection | null;
	invoke(connection: DeskAdapterConnection, method: DeskMailExecutionMethod, input: unknown): Promise<unknown>;
	lookupContext(connection: DeskAdapterConnection, request: LookupRequest): Promise<DeskMailOperationContext>;
}
declare const replySubject: (subject: string) => string;
declare const MailJudgementInputSchema: z.ZodDiscriminatedUnion<[
	z.ZodObject<{
		action: z.ZodLiteral<"unimportant">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"block-domain">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"correct">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		said: z.ZodEnum<{
			junk: "junk";
			archive: "archive";
			trash: "trash";
			reply: "reply";
			plan: "plan";
			todo: "todo";
			keep: "keep";
			"not-bulk": "not-bulk";
			matters: "matters";
		}>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"not-phishing">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"snooze">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		until: z.ZodDiscriminatedUnion<[
			z.ZodObject<{
				kind: z.ZodEnum<{
					tomorrow: "tomorrow";
					later: "later";
					"next-week": "next-week";
				}>;
			}, z.core.$strict>,
			z.ZodObject<{
				kind: z.ZodLiteral<"date">;
				date: z.ZodString;
			}, z.core.$strict>,
			z.ZodObject<{
				kind: z.ZodLiteral<"meeting">;
				event: z.ZodString;
			}, z.core.$strict>,
			z.ZodObject<{
				kind: z.ZodLiteral<"person">;
				address: z.ZodString;
			}, z.core.$strict>
		], "kind">;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"snooze-cancel">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"waiting">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		op: z.ZodEnum<{
			done: "done";
			snooze: "snooze";
			"no-answer": "no-answer";
			expect: "expect";
		}>;
	}, z.core.$strict>,
	z.ZodObject<{
		action: z.ZodLiteral<"undo">;
		message: z.ZodObject<{
			adapterId: z.ZodString;
			connectionId: z.ZodString;
			objectType: z.ZodString;
			canonicalId: z.ZodString;
		}, z.core.$strict>;
		operationId: z.ZodString;
	}, z.core.$strict>
], "action">;
export type MailJudgementInput = z.infer<typeof MailJudgementInputSchema>;
export type MailJudgementAction = MailJudgementInput["action"];
export declare const judgementCapability: (action: MailJudgementAction) => string;
declare const MailJudgementOutputSchema: z.ZodObject<{
	ref: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
	message: z.ZodString;
	undo: z.ZodBoolean;
}, z.core.$strict>;
export type MailJudgementOutput = z.infer<typeof MailJudgementOutputSchema>;
export declare function mailJudgementDeclaration(adapterId: string): AdapterDeclaration;
export declare function mailJudgementSnapshot(options: {
	adapterId: string;
	connectionId: string;
	account: string;
	input: MailJudgementInput;
	provenance: Provenance;
}): ApprovedSnapshot;
export declare const MAIL_UNSUBSCRIBE_CAPABILITY = "mail.unsubscribe";
declare const MailUnsubscribeInputSchema: z.ZodObject<{
	message: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
}, z.core.$strict>;
export type MailUnsubscribeInput = z.infer<typeof MailUnsubscribeInputSchema>;
declare const MailUnsubscribeOutputSchema: z.ZodObject<{
	ref: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
	host: z.ZodString;
}, z.core.$strict>;
export type MailUnsubscribeOutput = z.infer<typeof MailUnsubscribeOutputSchema>;
/** The declaration a Mail adapter publishes for one-click unsubscribe. The Cortex runtime registers it as the contract a fixture binding or a real adapter must meet. */
export declare function mailUnsubscribeDeclaration(adapterId: string): AdapterDeclaration;
export declare function mailUnsubscribeSnapshot(options: {
	adapterId: string;
	connectionId: string;
	account: string;
	input: MailUnsubscribeInput;
	provenance: Provenance;
}): ApprovedSnapshot;
export declare const MAIL_REPORT_KINDS: readonly [
	"draft",
	"spam",
	"phishing"
];
export type MailReportKind = (typeof MAIL_REPORT_KINDS)[number];
export declare const MAIL_REPORT_CAPABILITY: Readonly<Record<MailReportKind, string>>;
declare const MailReportInputSchema: z.ZodObject<{
	message: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
}, z.core.$strict>;
export type MailReportInput = z.infer<typeof MailReportInputSchema>;
declare const MailReportOutputSchema: z.ZodObject<{
	ref: z.ZodObject<{
		adapterId: z.ZodString;
		connectionId: z.ZodString;
		objectType: z.ZodString;
		canonicalId: z.ZodString;
	}, z.core.$strict>;
	folder: z.ZodString;
}, z.core.$strict>;
export type MailReportOutput = z.infer<typeof MailReportOutputSchema>;
/** The declaration a Mail adapter publishes for the report kinds. Provider reports need restore too, because Undo moves the mail back. */
export declare function mailReportDeclaration(adapterId: string, kinds?: readonly MailReportKind[]): AdapterDeclaration;
export declare function mailReportSnapshot(options: {
	adapterId: string;
	connectionId: string;
	account: string;
	kind: MailReportKind;
	input: MailReportInput;
	provenance: Provenance;
}): ApprovedSnapshot;
export declare const MAIL_MOVE_CAPABILITY = "mail.move";
export declare const MAIL_TRASH_CAPABILITY = "mail.trash";
export declare const MAIL_RESTORE_CAPABILITY = "mail.restore";
export declare const MAIL_MOVE_CAPABILITIES: readonly [
	"mail.move",
	"mail.trash",
	"mail.restore"
];
export type MailMoveAction = "move" | "trash" | "restore";
declare const MAIL_MOVE_TARGETS: readonly [
	"archive",
	"junk"
];
export type MailMoveTarget = (typeof MAIL_MOVE_TARGETS)[number];
/** The declaration a Mail adapter publishes for the move verbs. The Cortex runtime registers it as the contract a fixture binding or a real adapter must meet. */
export declare function mailMoveDeclaration(adapterId: string, only?: readonly MailMoveAction[]): AdapterDeclaration;
export declare const mailAccountRef: (adapterId: string, connectionId: string, account: string) => ObjectReference;
export declare const mailMessageRef: (adapterId: string, connectionId: string, messageId: string) => ObjectReference;
export type MailMoveInput = {
	action: "move";
	message: ObjectReference;
	target: MailMoveTarget;
} | {
	action: "trash";
	message: ObjectReference;
} | {
	action: "restore";
	message: ObjectReference;
	from: string;
};
export declare function mailMoveSnapshot(options: {
	adapterId: string;
	connectionId: string;
	account: ObjectReference;
	input: MailMoveInput;
	provenance: Provenance;
	policy?: "local" | "cloud";
}): ApprovedSnapshot;
export declare const MAIL_REPLY_DRAFT_CAPABILITY = "mail.reply-draft.create";
/** The existing reply-draft wire contract, shared by the host and external Mail adapters. */
export declare function mailReplyDraftDeclaration(adapterId?: string): AdapterDeclaration;
/** Builds the exact message/account approval shape without trimming the reply text. */
export declare function mailReplyDraftSnapshot(options: {
	adapterId: string;
	connectionId: string;
	account: ObjectReference;
	message: ObjectReference;
	body: string;
	provenance: Provenance;
	policy?: "local" | "cloud";
	capability?: CapabilityDeclaration;
}): ApprovedSnapshot;
/** An invitation as the rule sees it: its SEQUENCE, its start and optional end as ISO instants, and whether it repeats. */
export interface InvitationFacts {
	readonly sequence: number;
	readonly start: string;
	readonly end?: string;
	readonly recurring?: boolean;
}
/** A mail as the reply rule sees it. `inReplyTo` and `references` hold message ids without angle brackets. */
export interface ReplyFacts {
	readonly id: string;
	readonly from: string;
	readonly receivedAt: string;
	readonly inReplyTo?: readonly string[];
	readonly references?: readonly string[];
}
export type InvitationOpenRule = (invitation: InvitationFacts, answeredSequence: number | undefined, now: number) => boolean;
export type RepliesToRule = (sent: Pick<ReplyFacts, "id" | "from">, candidates: readonly ReplyFacts[]) => string[];
export declare const MAX_REPLIES = 10;
/**
 * The reference rule for whether an invitation is still open. It is open when it is not answered at the same or a newer
 * SEQUENCE and not over. It is over at its end, or at its start when it has no end. A recurring invitation is never over.
 */
export declare const invitationOpen: InvitationOpenRule;
/**
 * The reference rule for which mails reply to a sent mail. A candidate replies when it names the sent mail's id in
 * In-Reply-To or References, has a different id and comes from a different address. At most 10, oldest first.
 */
export declare const repliesTo: RepliesToRule;
export interface InvitationOpenVector {
	readonly name: string;
	readonly input: {
		readonly invitation: InvitationFacts;
		readonly answeredSequence: number | undefined;
		readonly now: number;
	};
	readonly expected: boolean;
}
export interface RepliesToVector {
	readonly name: string;
	readonly input: {
		readonly sent: Pick<ReplyFacts, "id" | "from">;
		readonly candidates: readonly ReplyFacts[];
	};
	readonly expected: readonly string[];
}
export declare const INVITATION_OPEN_VECTORS: readonly InvitationOpenVector[];
export declare const REPLIES_TO_VECTORS: readonly RepliesToVector[];
export interface ConformanceFailure {
	readonly rule: "invitationOpen" | "repliesTo";
	readonly name: string;
	readonly expected: unknown;
	readonly actual: unknown;
}
/** Runs every vector against an adapter's own rules and returns the vectors it fails; an empty list means it conforms. */
export declare function runDeskRuleVectors(rules: {
	invitationOpen: InvitationOpenRule;
	repliesTo: RepliesToRule;
}): ConformanceFailure[];
/**
 * The call a package's module supplies for one query capability. The host passes the validated fetch request for
 * the capability and releases the result only after it parses as a `QueryPage`.
 */
export type DeskQueryHandler = (request: QueryFetchRequest, signal: AbortSignal) => unknown;
/**
 * The calls a package's module supplies for one observation capability. `fetch` resolves to an `ObservationBatch`;
 * the host validates it against the capability's read binding before storing anything.
 */
export interface DeskObservationBinding {
	readonly modes: readonly ("poll" | "subscription")[];
	readonly ordering?: {
		readonly id: string;
		compare(left: string, right: string): "older" | "same" | "newer" | "incomparable";
	};
	fetch(request: ObservationRequest, signal: AbortSignal): unknown;
}
/** The untyped 1.0.0 binding shape; the host treats one without `fetch` and `modes` as an unavailable observation path. */
export type DeskLegacyObservationBinding = object;
/** The bindings a package's module supplies for its declared query and observation capabilities. */
export interface DeskAdapterBindings {
	readonly handlers: Record<string, DeskQueryHandler>;
	readonly observations: Record<string, DeskObservationBinding | DeskLegacyObservationBinding>;
}
/** The connection identity the host binds when it constructs a connector for one configured connection. */
export interface DeskAdapterConnection {
	readonly adapterId: string;
	readonly connectionId: string;
}
/**
 * The trusted connector a package's module returns for one connection and one action capability; it carries no
 * credentials itself. Every call is optional: a call the package omits makes that path unavailable, and the host
 * never substitutes another implementation.
 *
 * - `dispatch` needs `writerOwner` and `support`; `support` must name this adapter, connection and capability.
 * - `readback` needs `readbackCapabilityId`, which must name a declared query capability of the same adapter.
 * - The host owns credential and account checks; a package cannot report a connection as available.
 */
export interface DeskActionConnector {
	readonly kind: "action";
	readonly adapterId: string;
	readonly connectionId: string;
	readonly capabilityId: string;
	readonly writerOwner?: string;
	readonly support?: OwnerSupport;
	dispatch?(request: DispatchRequest, signal: AbortSignal): unknown;
	cancel?(request: CancelRequest, signal: AbortSignal): unknown;
	lookup?(request: LookupRequest, signal: AbortSignal): unknown;
	readonly readbackCapabilityId?: string;
	readback?(request: ReadbackRequest, signal: AbortSignal): unknown;
}
/** Builds one connector per connection; the host calls it only after a connection exists. */
export type DeskConnectorFactory = (connection: DeskAdapterConnection) => DeskActionConnector;
/** One listed mail's identity: the connection that listed it and its Message-ID. */
export interface DeskMailReference {
	readonly connection: string;
	readonly messageId: string;
}
/**
 * One mail a Mail source listed for a connection, as the host releases it to an adapter. It carries the header
 * fields and at most the first paragraph, never a body.
 */
export interface DeskListedMail {
	readonly ref: DeskMailReference;
	readonly account: string;
	readonly from: {
		readonly name?: string;
		readonly address: string;
	};
	readonly subject: string;
	readonly receivedAt: string;
	readonly unread: boolean;
	readonly firstParagraph?: string;
	readonly unsubscribe?: {
		readonly oneClick: true;
		readonly host: string;
	};
}
/**
 * A connection's provider health. `fresh` means the source's last listing succeeded. `stale` means it failed
 * (`provider_failure`) or has not run yet (`not_listed`); the listing then keeps the last listed mail, and nothing
 * is reported as deleted.
 */
export type DeskMailHealth = {
	readonly state: "fresh";
	readonly listedAt: string;
} | {
	readonly state: "stale";
	readonly code: "provider_failure" | "not_listed";
};
/** The mail one source listed for one source-and-account connection, with the account the host resolved for it. */
export interface DeskMailListing {
	readonly connection: DeskAdapterConnection;
	readonly account: string;
	readonly health: DeskMailHealth;
	readonly mail: readonly DeskListedMail[];
}
/**
 * The host's read bridge to Mail. Call `listed` only inside a backend call the host made for that same connection,
 * such as a query handler; elsewhere it rejects with `mail_read_unadmitted`. It resolves to `null` for a connection
 * the host does not bind to a Mail source and account for this adapter. It never runs the provider: it reads what
 * the source last listed.
 */
export interface DeskMailReadBridge {
	listed(connection: DeskAdapterConnection): Promise<DeskMailListing | null>;
}
export interface DeskMailJudgementBridge {
	changeJudgement(request: DispatchRequest): Promise<OwnerResult>;
}
/** The host seam a package module receives: its SDK version, protected action-connector registration and Mail reads. */
export interface DeskAdapterHost {
	readonly sdkVersion: string;
	registerConnector(capabilityId: string, createConnector: DeskConnectorFactory): void;
	readonly mail: DeskMailReadBridge;
	readonly mailJudgements?: DeskMailJudgementBridge;
	readonly mailExecution?: DeskMailExecutionBridge;
}
/** What a package's `createDeskAdapter` returns; the loader compares the declaration to the verified manifest. */
export interface DeskAdapterDefinition {
	readonly declaration: AdapterDeclaration;
	readonly bindings: DeskAdapterBindings;
}
/** The factory a package's ESM entry exports; it runs with no credentials and starts no provider effect. */
export type CreateDeskAdapter = (host: DeskAdapterHost) => DeskAdapterDefinition;
/** The exact module shape a `desk-adapter.json` backend entry must export. */
export interface DeskAdapterModule {
	readonly createDeskAdapter: CreateDeskAdapter;
}

export {
	FIELD_SCHEMAS as ParserFieldSchemas,
	replySubject as mailReplySubject,
};

export {};
