import type { Database } from "bun:sqlite";

export interface DeskVip {
  address: string;
  label: string | null;
  addedAt: number;
}

const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const DOMAIN = /^@?[a-z0-9.-]+\.[a-z]{2,}$/;

/**
 * A VIP is a full address ("ada@example.ch") or a whole domain ("@example.ch").
 * Returns the stored form, or null when the value is neither.
 */
export function normalizeVip(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (ADDRESS.test(value)) return value;
  if (DOMAIN.test(value)) return value.startsWith("@") ? value : `@${value}`;
  return null;
}

export function listVips(db: Database): DeskVip[] {
  return db
    .query<{ address: string; label: string | null; added_at: number }, []>("SELECT address, label, added_at FROM desk_vips ORDER BY address")
    .all()
    .map((r) => ({ address: r.address, label: r.label, addedAt: r.added_at }));
}

export function addVip(db: Database, address: string, label: string | null, now: number): void {
  db.query("INSERT INTO desk_vips (address, label, added_at) VALUES (?, ?, ?) ON CONFLICT(address) DO UPDATE SET label = COALESCE(excluded.label, desk_vips.label)")
    .run(address, label, now);
}

export function removeVip(db: Database, address: string): boolean {
  return db.query("DELETE FROM desk_vips WHERE address = ?").run(address).changes > 0;
}

/** True when the sender's address or its domain is on the list. */
export function isVip(vips: ReadonlySet<string>, address: string): boolean {
  const a = address.toLowerCase();
  return vips.has(a) || vips.has(a.slice(a.indexOf("@")));
}
