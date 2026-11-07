import { z } from "zod";
import { canonicalJSON, CanonicalDepthError, CanonicalWidthError } from "../../common/registry/canonical-json";
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import type { AdapterDeclaration, BoundaryError, Result, SchemaRef } from "./types";

export const schemaKey = (ref: SchemaRef): string => `urn:desk-schema:${encodeURIComponent(ref.schemaId)}:${encodeURIComponent(ref.version)}`;
export const failure = (code: string, message: string, issues?: BoundaryError["issues"]): Result<never> => ({ ok: false, error: { code, message, ...(issues?.length ? { issues } : {}) } });
export const success = <T>(value: T): Result<T> => ({ ok: true, value });
export const canonicalSchema = canonicalJSON;
const pointerToken = (value: string): string => value.replace(/~/g, "~0").replace(/\//g, "~1");

function issue(error: ErrorObject): NonNullable<BoundaryError["issues"]>[number] {
  const params = error.params as Record<string, unknown>;
  const property = error.keyword === "required" ? params.missingProperty : error.keyword === "additionalProperties" ? params.additionalProperty : undefined;
  return { path: `${error.instancePath}${typeof property === "string" ? `/${pointerToken(property)}` : ""}`, code: error.keyword, message: `Value does not satisfy ${error.keyword}.` };
}

export const jsonBoundCode = (error: unknown): string => error instanceof CanonicalDepthError ? "depth_limit" : error instanceof CanonicalWidthError ? "size_limit" : "invalid_json";

export function validatePayload(validate: ValidateFunction, value: unknown, code: string): Result<unknown> {
  try { canonicalSchema(value); }
  catch (error) { return failure(code, "Data is not a supported JSON value.", [{ path: "", code: jsonBoundCode(error), message: "Supply a bounded JSON value." }]); }
  const json = z.json().safeParse(value);
  if (!json.success) return failure(code, "Data is not a supported JSON value.");
  return validate(json.data) ? success(json.data) : failure(code, "Data does not match the declared schema.", validate.errors?.map(issue));
}

export class SchemaBundle {
  readonly ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true, ownProperties: true, useDefaults: false, coerceTypes: false, removeAdditional: false });
  readonly validators = new Map<string, ValidateFunction>();

  constructor(readonly schemas: AdapterDeclaration["schemas"]) {
    addFormats(this.ajv);
    for (const schema of schemas) this.ajv.addSchema(schema.schema, schemaKey(schema));
    for (const schema of schemas) {
      const validate = this.ajv.getSchema(schemaKey(schema));
      if (!validate || "$async" in validate) throw new Error("Bundled schemas require synchronous validation.");
      this.validators.set(schemaKey(schema), validate);
    }
  }

  validator(ref: SchemaRef): ValidateFunction | undefined { return this.validators.get(schemaKey(ref)); }

  field(ref: SchemaRef, fieldPath: string): Record<string, unknown> | undefined {
    let current: unknown = this.schemas.find(schema => schemaKey(schema) === schemaKey(ref))?.schema;
    let base = schemaKey(ref);
    const dereference = (): Record<string, unknown> | undefined => {
      const seen = new Set<unknown>();
      while (current && typeof current === "object" && !Array.isArray(current)) {
        if (seen.has(current)) return undefined;
        seen.add(current);
        const node = current as Record<string, unknown>;
        if (typeof node.$id === "string") base = node.$id;
        if (typeof node.$ref !== "string") return node;
        const target = node.$ref.startsWith("#") ? `${base}${node.$ref}` : node.$ref;
        current = this.ajv.getSchema(target)?.schema;
      }
      return undefined;
    };
    for (const token of fieldPath.slice(1).split("/").map(value => value.replace(/~1/g, "/").replace(/~0/g, "~"))) {
      const node = dereference();
      const properties = node?.properties;
      if (!properties || typeof properties !== "object" || Array.isArray(properties)) return undefined;
      current = (properties as Record<string, unknown>)[token];
    }
    return dereference();
  }
}
