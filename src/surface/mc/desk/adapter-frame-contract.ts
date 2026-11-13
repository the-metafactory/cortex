import { z } from "zod";
import { HostMessageSchema, MountSchema, DESK_UI_WIRE_VERSION } from "./adapter-frame-protocol";

export const DESK_ADAPTER_FRAMES_PATH = "/api/desk/adapters/frames";
export const DESK_ADAPTER_ASSETS_PREFIX = "/api/desk/adapters/assets/";
const id = z.string().min(1).max(512);
const hex = z.string().regex(/^[0-9a-f]{64}$/);
export const FrameEntrySchema = z.object({
  adapterId: id, connectionId: id, generationId: id, releaseDigest: hex,
  uiProtocolVersion: z.literal(DESK_UI_WIRE_VERSION), entry: id,
  files: z.array(z.object({ path: id, sha256: hex, mediaType: id, url: id }).strict()).min(1).max(256),
  views: z.array(MountSchema).max(128),
}).strict();
export type FrameEntry = z.infer<typeof FrameEntrySchema>;
export const OpenFrameSchema = z.object({ mountId: z.string().regex(/^[0-9a-f]{32}$/), instance: z.string().regex(/^[0-9a-f]{32}$/) }).strict();
export const FrameOpenReplySchema = z.object({ entry: FrameEntrySchema, mount: MountSchema }).strict();
export const FrameReplySchema = z.object({ messages: z.array(HostMessageSchema).max(8) }).strict();
export const shellFrameCsp = (origin: string): string => `frame-src ${new URL(origin).origin}${DESK_ADAPTER_ASSETS_PREFIX}`;

export function frameEntryUrl(entry: FrameEntry, origin: string): string | null {
  const file = entry.files.find(item => item.path === entry.entry && item.mediaType === "text/html");
  if (!file) return null;
  const url = new URL(file.url, origin);
  const expected = `${DESK_ADAPTER_ASSETS_PREFIX}${entry.releaseDigest}/${encodeURIComponent(entry.connectionId)}/${entry.entry.split("/").map(encodeURIComponent).join("/")}`;
  return url.origin === new URL(origin).origin && url.pathname === expected && !url.search && !url.hash && !url.username && !url.password ? url.href : null;
}
