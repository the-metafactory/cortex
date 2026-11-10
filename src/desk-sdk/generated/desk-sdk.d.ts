// ============================================================================
// glossary-ignore: host, run
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

export declare const DESK_ADAPTER_SDK_VERSION = "1.0.0";
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
/** The registry handler a package's module supplies for one query capability. */
export type DeskQueryHandler = (input: unknown, context: unknown) => unknown;
/** The registry bindings a package's module supplies for its declared query and observation capabilities. */
export interface DeskAdapterBindings {
	readonly handlers: Record<string, DeskQueryHandler>;
	readonly observations: Record<string, object>;
}
/** The connection identity the host binds when it constructs a connector for one configured connection. */
export interface DeskAdapterConnection {
	readonly adapterId: string;
	readonly connectionId: string;
}
/** The trusted connector a package's module returns for one connection; it carries no credentials itself. */
export interface DeskActionConnector {
	readonly kind: "action";
	readonly adapterId: string;
	readonly connectionId: string;
	readonly capabilityId: string;
}
/** Builds one connector per connection; the host calls it only after a connection exists. */
export type DeskConnectorFactory = (connection: DeskAdapterConnection) => DeskActionConnector;
/** The only host seam a package module receives: its SDK version and protected action-connector registration. */
export interface DeskAdapterHost {
	readonly sdkVersion: string;
	registerConnector(capabilityId: string, createConnector: DeskConnectorFactory): void;
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
