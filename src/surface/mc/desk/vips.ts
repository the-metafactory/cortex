import type { Database } from "bun:sqlite";

export interface DeskVip {
  address: string;
  label: string | null;
  addedAt: number;
}

export type SenderList = "vips" | "unimportant";

const TABLE: Record<SenderList, string> = { vips: "desk_vips", unimportant: "desk_unimportant" };

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN = /^@?[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * A listed sender is a full address ("ada@example.ch") or a whole domain ("@example.ch").
 * Returns the stored form, or null when the value is neither.
 */
export function normalizeVip(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (ADDRESS.test(value)) return value;
  if (DOMAIN.test(value)) return value.startsWith("@") ? value : `@${value}`;
  return null;
}

export function listSenders(db: Database, list: SenderList): DeskVip[] {
  return db
    .query<{ address: string; label: string | null; added_at: number }, []>(`SELECT address, label, added_at FROM ${TABLE[list]} ORDER BY address`)
    .all()
    .map((r) => ({ address: r.address, label: r.label, addedAt: r.added_at }));
}

export function addSender(db: Database, list: SenderList, address: string, label: string | null, now: number): void {
  const table = TABLE[list];
  db.query(`INSERT INTO ${table} (address, label, added_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = COALESCE(excluded.label, ${table}.label)`)
    .run(address, label, now);
}

export function removeSender(db: Database, list: SenderList, address: string): boolean {
  return db.query(`DELETE FROM ${TABLE[list]} WHERE address = ?`).run(address).changes > 0;
}

export const listVips = (db: Database): DeskVip[] => listSenders(db, "vips");
export function addVip(db: Database, address: string, label: string | null, now: number): void {
  addSender(db, "vips", address, label, now);
}
export const removeVip = (db: Database, address: string): boolean => removeSender(db, "vips", address);

/** True when the sender's address or its domain is on the list. */
export function isVip(vips: ReadonlySet<string>, address: string): boolean {
  const a = address.toLowerCase();
  return vips.has(a) || vips.has(a.slice(a.indexOf("@")));
}

/** Mail from an unimportant sender counts as bulk, unless the sender is a VIP: VIP wins. */
export const isUnimportant = (unimportant: ReadonlySet<string>, vips: ReadonlySet<string>, address: string): boolean =>
  isVip(unimportant, address) && !isVip(vips, address);
