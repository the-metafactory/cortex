import { z } from "zod";
import { hex64, identifier } from "../../../src/conversations/domain-adapters/package-primitives";
import { ObjectReferenceSchema } from "../../../src/conversations/domain-adapters/types";

export const DESK_UI_PROTOCOL = "desk-ui";
export const DESK_UI_WIRE_VERSION = "1.0.0";
export const DESK_UI_MAX_MESSAGE_BYTES = 65_536;
export const DESK_UI_MAX_CHANGES = 64;
export const DESK_UI_MAX_RESIZE = 4_000;
export const DESK_UI_HANDSHAKE_MS = 3_000;

const instance = z.string().regex(/^[0-9a-f]{32}$/);
const seq = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const pointer = z.string().max(256).regex(/^(?:\/(?:[^~/]|~[01])*)+$/);
const revision = z.number().int().min(0);
const draftId = identifier.pipe(z.string().max(128));
const json: z.ZodType<unknown> = z.json();

export const MountSchema = z.object({ objectType: identifier, view: z.enum(["result", "editor"]) }).strict();
export type Mount = z.infer<typeof MountSchema>;

const identity = {
  protocol: z.literal(DESK_UI_PROTOCOL),
  version: z.literal(DESK_UI_WIRE_VERSION),
  instance,
  adapterId: identifier,
  connectionId: identifier,
  generationId: identifier,
  releaseDigest: hex64,
  seq,
};
export type Identity = { protocol: typeof DESK_UI_PROTOCOL; version: typeof DESK_UI_WIRE_VERSION; instance: string; adapterId: string; connectionId: string; generationId: string; releaseDigest: string };

const message = <T extends string, B extends z.ZodType>(type: T, body: B) => z.object({ ...identity, type: z.literal(type), body }).strict();

const editChange = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set"), value: json }).strict(),
  z.object({ kind: z.literal("null") }).strict(),
  z.object({ kind: z.literal("omit") }).strict(),
]);
const blocking = z.object({ pointer, code: z.enum(["required_missing", "unresolved", "invalid_value", "unsupported_editor", "schema_unavailable"]) }).strict();

export const InitSchema = message("host:init", z.object({ mount: MountSchema }).strict());

export const HostMessageSchema = z.discriminatedUnion("type", [
  message("host:projection", z.object({ projectionId: identifier, revision, object: json }).strict()),
  message("host:draft", z.object({ draftId, revision, values: z.record(pointer, json), blocking: z.array(blocking).max(256) }).strict()),
  message("host:theme", z.object({ scheme: z.enum(["light", "dark"]), reducedMotion: z.boolean(), locale: z.string().max(35) }).strict()),
  message("host:reply", z.object({ replyTo: seq, outcome: z.enum(["accepted", "rejected", "stale"]), code: identifier.optional() }).strict()),
  message("host:close", z.object({ reason: z.enum(["navigation", "disabled", "generation_changed", "connection_changed", "unmounted", "protocol_violation"]) }).strict()),
]);

export const UiMessageSchema = z.discriminatedUnion("type", [
  message("ui:ready", z.object({ mount: MountSchema }).strict()),
  message("ui:resize", z.object({ height: z.number().int().min(0).max(DESK_UI_MAX_RESIZE) }).strict()),
  message("ui:error", z.object({ code: z.enum(["render_failed", "unsupported_projection", "internal"]) }).strict()),
  message("ui:navigate", z.object({ target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("object"), ref: ObjectReferenceSchema }).strict(),
    z.object({ kind: z.literal("draft"), draftId }).strict(),
  ]) }).strict()),
  message("draft:change", z.object({ draftId, baseRevision: revision, changes: z.array(z.object({ pointer, change: editChange }).strict()).min(1).max(DESK_UI_MAX_CHANGES) }).strict()),
  message("action:propose", z.object({ draftId, revision }).strict()),
]);
export type UiMessage = z.infer<typeof UiMessageSchema>;
export type HostMessage = z.infer<typeof HostMessageSchema>;

const EDITOR_ONLY: ReadonlySet<string> = new Set(["draft:change", "action:propose"]);

export type Violation =
  | "not_plain_json" | "oversized" | "schema" | "identity_mismatch" | "replayed_or_out_of_order"
  | "before_ready" | "ready_twice" | "mount_mismatch" | "editor_only" | "cross_connection_reference";

export type Verdict = { ok: true; message: UiMessage } | { ok: false; violation: Violation };

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

function plainJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => plainJson(item, depth + 1));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.keys(value).every(key => key !== "__proto__" && plainJson((value as Record<string, unknown>)[key], depth + 1));
}

/** One mounted frame's inbound gate: every message from the frame passes here exactly once, and any violation is terminal. */
export class InboundGate {
  private lastSeq = 0;
  private ready = false;
  constructor(private readonly expected: Identity, private readonly mount: Mount) {}

  admit(raw: unknown): Verdict {
    if (!plainJson(raw)) return { ok: false, violation: "not_plain_json" };
    if (byteLength(JSON.stringify(raw)) > DESK_UI_MAX_MESSAGE_BYTES) return { ok: false, violation: "oversized" };
    const parsed = UiMessageSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, violation: "schema" };
    const m = parsed.data;
    const e = this.expected;
    if (m.instance !== e.instance || m.adapterId !== e.adapterId || m.connectionId !== e.connectionId || m.generationId !== e.generationId || m.releaseDigest !== e.releaseDigest) return { ok: false, violation: "identity_mismatch" };
    if (m.seq <= this.lastSeq) return { ok: false, violation: "replayed_or_out_of_order" };
    this.lastSeq = m.seq;
    if (m.type === "ui:ready") {
      if (this.ready) return { ok: false, violation: "ready_twice" };
      if (m.body.mount.objectType !== this.mount.objectType || m.body.mount.view !== this.mount.view) return { ok: false, violation: "mount_mismatch" };
      this.ready = true;
      return { ok: true, message: m };
    }
    if (!this.ready) return { ok: false, violation: "before_ready" };
    if (EDITOR_ONLY.has(m.type) && this.mount.view !== "editor") return { ok: false, violation: "editor_only" };
    if (m.type === "ui:navigate" && m.body.target.kind === "object" && (m.body.target.ref.adapterId !== e.adapterId || m.body.target.ref.connectionId !== e.connectionId)) return { ok: false, violation: "cross_connection_reference" };
    return { ok: true, message: m };
  }
}

export const newInstance = (): string => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
