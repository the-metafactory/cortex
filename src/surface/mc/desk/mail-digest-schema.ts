import type { EndpointAccess } from "./classify";

export const DIGEST_SQL = [
  "CREATE TABLE IF NOT EXISTS desk_mail_digest_kept (message_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS desk_mail_digest_flags (digest_id TEXT PRIMARY KEY, stamp TEXT NOT NULL, model TEXT NOT NULL, flags TEXT NOT NULL, skipped TEXT, created_at INTEGER NOT NULL)",
];

export type DigestModel = EndpointAccess & { local?: EndpointAccess };

export interface DigestConfig {
  at: string;
  model?: DigestModel;
}
