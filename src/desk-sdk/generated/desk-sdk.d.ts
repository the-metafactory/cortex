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

export declare const DESK_ADAPTER_SDK_VERSION = "1.8.0";
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
			observation: "observation";
			query: "query";
			action: "action";
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
		watermark: "watermark";
		objects: "objects";
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
/** The host seam a package module receives: its SDK version, protected action-connector registration and Mail reads. */
export interface DeskAdapterHost {
	readonly sdkVersion: string;
	registerConnector(capabilityId: string, createConnector: DeskConnectorFactory): void;
	readonly mail: DeskMailReadBridge;
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

export {};
