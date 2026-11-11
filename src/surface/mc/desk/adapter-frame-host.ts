import type { z } from "zod";
import type { AuthorityMediator, HostContext, ReadScope } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { DraftService, Lane } from "../../../conversations/domain-adapters/drafting";
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { AdapterAssetService } from "./adapter-assets";
import { FrameEntrySchema, type FrameEntry } from "./adapter-frame-contract";
import { DESK_UI_PROTOCOL, DESK_UI_WIRE_VERSION, DESK_UI_HANDSHAKE_MS, DESK_UI_MAX_MESSAGE_BYTES, HostMessageSchema, InboundGate, MountSchema, newInstance, plainJson, type HostMessage, type Identity, type Mount, type UiMessage } from "./adapter-frame-protocol";

export interface FrameBinding {
  principal: string;
  audience: Lane;
  adapterId: string;
  connectionId: string;
  mount: Mount;
  authority: AuthorityMediator;
  context: HostContext;
  sink: Extract<ReleaseSink, { kind: "view" }>;
  scopes: ReadScope[];
  schema: z.ZodType;
  projection(): Promise<{ projectionId: string; revision: number; object: unknown }>;
  editor?: { service: DraftService; draftId: string; hasOperation(): Promise<boolean> };
}

interface Session {
  binding: FrameBinding;
  entry: FrameEntry;
  identity: Identity;
  gate: InboundGate;
  seq: number;
  ready: boolean;
  expires: number;
  busy: boolean;
}

const FRAME_REPLAY_RETENTION_MS = 60_000;

export class FrameUnavailable extends Error {
  constructor() { super("The adapter view is unavailable. Safe host status and history are retained."); }
}

export class AdapterFrameHost {
  private readonly mounts = new Map<string, FrameBinding>();
  private readonly sessions = new Map<string, Session>();
  private readonly used = new Map<string, number>();

  constructor(private readonly assets: AdapterAssetService, private readonly now: () => number = Date.now) {}

  register(binding: FrameBinding): { mountId: string; remove(): void } {
    MountSchema.parse(binding.mount);
    if (binding.scopes.length === 0 || binding.scopes.some(scope => scope.policy === undefined)) throw new FrameUnavailable();
    if (binding.mount.view === "editor" && !binding.editor) throw new FrameUnavailable();
    const unregisterSink = binding.authority.registerReleaseSink(binding.sink, () => Promise.resolve());
    const mountId = newInstance();
    this.mounts.set(mountId, binding);
    return { mountId, remove: () => {
      this.mounts.delete(mountId);
      unregisterSink();
      for (const [instance, session] of this.sessions) if (session.binding === binding) this.retire(instance, session);
    } };
  }

  private async current(binding: FrameBinding, audience: Lane): Promise<FrameEntry> {
    if (binding.audience !== audience || audience === "cloud" && binding.scopes.some(scope => scope.policy === "local")) throw new FrameUnavailable();
    const catalog = await this.assets.catalog(binding.principal, DESK_UI_WIRE_VERSION);
    if ("ok" in catalog || catalog.protocolVersion !== DESK_UI_WIRE_VERSION) throw new FrameUnavailable();
    const entry = catalog.adapters.find(item => item.adapterId === binding.adapterId && item.connectionId === binding.connectionId && item.availability.state === "available");
    if (!entry?.views.some(view => view.view === binding.mount.view && view.objectType === binding.mount.objectType)) throw new FrameUnavailable();
    return FrameEntrySchema.parse({ adapterId: entry.adapterId, connectionId: entry.connectionId, generationId: entry.generationId, releaseDigest: entry.releaseDigest, uiProtocolVersion: entry.uiProtocolVersion, entry: entry.entry, files: entry.files, views: entry.views });
  }

  async open(principal: string, audience: Lane, mountId: string, instance: string): Promise<{ entry: FrameEntry; mount: Mount }> {
    const now = this.now();
    for (const [id, session] of this.sessions) if (now > session.expires) this.retire(id, session, session.expires);
    for (const [id, expires] of this.used) if (now > expires && !this.sessions.has(id)) this.used.delete(id);
    const binding = this.mounts.get(mountId);
    if (binding?.principal !== principal || this.used.has(instance) || this.used.size >= 4096 || this.sessions.size >= 128) throw new FrameUnavailable();
    this.used.set(instance, now + FRAME_REPLAY_RETENTION_MS);
    const entry = await this.current(binding, audience);
    if (this.mounts.get(mountId) !== binding || this.now() > now + DESK_UI_HANDSHAKE_MS) throw new FrameUnavailable();
    const identity: Identity = { protocol: DESK_UI_PROTOCOL, version: DESK_UI_WIRE_VERSION, instance, adapterId: entry.adapterId, connectionId: entry.connectionId, generationId: entry.generationId, releaseDigest: entry.releaseDigest };
    this.sessions.set(instance, { binding, entry, identity, gate: new InboundGate(identity, binding.mount), seq: 1, ready: false, expires: this.now() + DESK_UI_HANDSHAKE_MS, busy: false });
    return { entry, mount: binding.mount };
  }

  close(principal: string, instance: string): void {
    const session = this.sessions.get(instance);
    if (session?.binding.principal === principal) this.retire(instance, session);
  }

  private retire(instance: string, session: Session, at = this.now()): void {
    if (this.sessions.get(instance) !== session) return;
    this.sessions.delete(instance);
    this.used.set(instance, at + FRAME_REPLAY_RETENTION_MS);
  }

  private async check(instance: string, session: Session, audience: Lane): Promise<void> {
    if (this.sessions.get(instance) !== session || this.now() > session.expires) throw new FrameUnavailable();
    const current = await this.current(session.binding, audience);
    if (this.sessions.get(instance) !== session || this.now() > session.expires || JSON.stringify(current) !== JSON.stringify(session.entry)) throw new FrameUnavailable();
  }

  private async authorized(session: Session, derive: () => Promise<Json>): Promise<Json> {
    const b = session.binding;
    await this.check(session.identity.instance, session, b.audience);
    const release = await b.authority.projectHostData(b.context, b.connectionId, b.sink, derive, b.scopes);
    if (release.kind !== "released") throw new FrameUnavailable();
    return release.value;
  }

  private message(session: Session, type: HostMessage["type"], body: unknown): HostMessage {
    const message = HostMessageSchema.parse({ ...session.identity, seq: ++session.seq, type, body });
    if (!plainJson(message) || new TextEncoder().encode(JSON.stringify(message)).length > DESK_UI_MAX_MESSAGE_BYTES) throw new FrameUnavailable();
    return message;
  }

  private async projection(session: Session): Promise<HostMessage[]> {
    const body = await this.authorized(session, async () => {
      const projection = await session.binding.projection();
      if (!plainJson(projection)) throw new FrameUnavailable();
      const parsed = session.binding.schema.safeParse(projection.object);
      if (!parsed.success || !plainJson(parsed.data)) throw new FrameUnavailable();
      await this.check(session.identity.instance, session, session.binding.audience);
      return { projectionId: projection.projectionId, revision: projection.revision, object: parsed.data } as Json;
    });
    const messages = [this.message(session, "host:projection", body)];
    const editor = session.binding.editor;
    if (session.binding.mount.view === "editor" && editor) {
      const draft = await this.authorized(session, async () => {
        const view = await editor.service.read(editor.draftId, session.binding.audience);
        if (view?.draft.adapterId !== session.entry.adapterId || view.draft.connectionId !== session.entry.connectionId || view.withheld.length > 0 || view.draft.conversationId !== session.binding.sink.conversationId) throw new FrameUnavailable();
        const values = Object.fromEntries(Object.entries(view.draft.fields).filter(([, field]) => field.presence !== "absent").map(([pointer, field]) => [pointer, field.presence === "null" ? null : field.value ?? null]));
        return { draftId: editor.draftId, revision: view.draft.revision, values, blocking: view.blocking.map(item => ({ pointer: item.pointer, code: item.code })) };
      });
      messages.push(this.message(session, "host:draft", draft));
    }
    return messages;
  }

  private async request(session: Session, m: UiMessage): Promise<HostMessage[]> {
    if (m.type === "ui:ready") { session.ready = true; return this.projection(session); }
    if (m.type === "ui:error") throw new FrameUnavailable();
    if (m.type === "ui:resize") return [];
    await this.authorized(session, () => Promise.resolve(null));
    if (m.type === "ui:navigate") {
      if (m.body.target.kind === "draft" && m.body.target.draftId !== session.binding.editor?.draftId) throw new FrameUnavailable();
      return [this.message(session, "host:reply", { replyTo: m.seq, outcome: "accepted" })];
    }
    const editor = session.binding.editor;
    if (m.body.draftId !== editor?.draftId || await editor.hasOperation()) throw new FrameUnavailable();
    const view = await editor.service.read(editor.draftId, session.binding.audience);
    if (!view || view.withheld.length > 0 || view.draft.connectionId !== session.entry.connectionId || view.draft.adapterId !== session.entry.adapterId) throw new FrameUnavailable();
    const revision = m.type === "draft:change" ? m.body.baseRevision : m.body.revision;
    if (revision !== view.draft.revision) return [this.message(session, "host:reply", { replyTo: m.seq, outcome: "stale" })];
    if (m.type === "draft:change") {
      let next = revision;
      for (const change of m.body.changes) {
        await this.authorized(session, () => Promise.resolve(null));
        const edited = await editor.service.edit(editor.draftId, next, change.pointer, change.change);
        next = edited.draft.revision;
      }
    }
    return [...await this.projection(session), this.message(session, "host:reply", { replyTo: m.seq, outcome: "accepted" })];
  }

  async exchange(principal: string, audience: Lane, instance: string, raw?: unknown): Promise<{ messages: HostMessage[] }> {
    const session = this.sessions.get(instance);
    if (session?.binding.principal !== principal || session.busy) throw new FrameUnavailable();
    session.busy = true;
    try {
      await this.check(instance, session, audience);
      let messages: HostMessage[];
      if (raw === undefined) {
        if (!session.ready) throw new FrameUnavailable();
        messages = await this.projection(session);
      } else {
        const verdict = session.gate.admit(raw);
        if (!verdict.ok) throw new FrameUnavailable();
        messages = await this.request(session, verdict.message);
      }
      await this.authorized(session, () => Promise.resolve(null));
      await this.check(instance, session, audience);
      session.expires = this.now() + 30_000;
      return { messages };
    } catch (error) {
      this.retire(instance, session);
      throw error;
    } finally { session.busy = false; }
  }
}
