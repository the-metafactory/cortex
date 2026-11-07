import { basename } from "node:path";
import { isLoopbackSideband } from "../../../common/sideband/loopback";

export type ModelRouteKind = "cloud" | "local";

/** The fields of a model configuration that decide where its prompts go. */
export interface RouteInput {
  command?: readonly string[];
  baseUrl?: string;
  sourcePolicy?: ModelRouteKind;
}

/** Which sources must stay on this machine. A source the configuration does not name answers true. */
export interface LocalSources {
  has(sourceId: string): boolean;
}

/** What a model prompt is made of. Only this module's helpers build one, so every dispatch states its content. */
export interface Provenance {
  readonly local: boolean;
}

/** Content with no mail in it: a Ranger ruling, a cloud-policy Studio thread. */
export const NOT_LOCAL_CONTENT: Provenance = Object.freeze({ local: false });

/** Content that must stay on this machine, for a reason the caller already knows. */
export const LOCAL_CONTENT: Provenance = Object.freeze({ local: true });

const CLOUD_CLIENTS = new Set(["codex", "claude", "desk-codex-json", "desk-codex-json.ts"]);
const CLOUD_CLIENT_FLAGS = new Set(["--codex", "--claude"]);

const namesCloudClient = (command: readonly string[]): boolean => command.some((arg) => CLOUD_CLIENT_FLAGS.has(arg) || CLOUD_CLIENTS.has(basename(arg)));

/**
 * Where a model configuration sends its prompts. A command is local only when it is declared local and names no known
 * cloud client. An endpoint is local when declared so, or on loopback with no declaration.
 */
export function routeOf(config: RouteInput): ModelRouteKind {
  if (config.command?.length) return config.sourcePolicy === "local" && !namesCloudClient(config.command) ? "local" : "cloud";
  if (config.sourcePolicy) return config.sourcePolicy;
  return config.baseUrl !== undefined && isLoopbackSideband(config.baseUrl) ? "local" : "cloud";
}

/** The configured mail and calendar sources that may reach a cloud model; every other source stays local. */
export function sourceBoundary(config: { areas: readonly { id: string; policy?: ModelRouteKind }[]; sources: readonly { id: string; area?: string | null }[] }): LocalSources & { cloudSources: ReadonlySet<string> } {
  const cloudAreas = new Set(config.areas.filter((area) => area.policy === "cloud").map((area) => area.id));
  const cloudSources = new Set(config.sources.filter((source) => typeof source.area === "string" && cloudAreas.has(source.area)).map((source) => source.id));
  return { cloudSources, has: (sourceId) => !cloudSources.has(sourceId) };
}

export const NOTHING_LEAVES: LocalSources = { has: () => true };

/** The provenance of a prompt built from these sources. A missing source, or no named source at all, counts as local. */
export function mailProvenance(localSources: LocalSources, sourceIds: readonly (string | null | undefined)[]): Provenance {
  if (sourceIds.length === 0) return LOCAL_CONTENT;
  return sourceIds.some((id) => !id || localSources.has(id)) ? LOCAL_CONTENT : NOT_LOCAL_CONTENT;
}

export const combined = (...parts: readonly Provenance[]): Provenance => (parts.some((part) => part.local) ? LOCAL_CONTENT : NOT_LOCAL_CONTENT);

export class CloudRouteRefused extends Error {
  constructor(label: string) {
    super(`the ${label} is a cloud route and this content must stay on this machine, so no model was called`);
    this.name = "CloudRouteRefused";
  }
}

/** The one check before any Desk model call. It throws for local content on a cloud route. */
export function assertRoute(route: ModelRouteKind, provenance: Provenance, label: string): void {
  if (provenance.local && route === "cloud") throw new CloudRouteRefused(label);
}
