import type { Database } from "bun:sqlite";
import { FOLDED_LABELS } from "./rank";
import { DESK_ITEM_KINDS, type DeskCorrection, type DeskCorrectionMode, type DeskItem, type DeskItemKind } from "./types";

export const CORRECTION_MODES = ["less", "always"] as const satisfies readonly DeskCorrectionMode[];

const SOURCE = /^[\w.:-]{1,64}$/;

export const isCorrectionMode = (v: unknown): v is DeskCorrectionMode => CORRECTION_MODES.includes(v as DeskCorrectionMode);
export const isItemKind = (v: unknown): v is DeskItemKind => DESK_ITEM_KINDS.includes(v as DeskItemKind);
export const isSource = (v: unknown): v is string => typeof v === "string" && SOURCE.test(v);

export const correctionLabel = (kind: DeskItemKind, source: string): string => `${FOLDED_LABELS[kind]}, from ${source}`;

interface Row {
  kind: string;
  source: string;
  mode: string;
  created_at: number;
}

export function listCorrections(db: Database): DeskCorrection[] {
  const rows = db.query<Row, []>("SELECT kind, source, mode, created_at FROM desk_corrections ORDER BY created_at DESC, kind, source").all();
  return rows.flatMap((r) =>
    isItemKind(r.kind) && isCorrectionMode(r.mode)
      ? [{ kind: r.kind, source: r.source, mode: r.mode, label: correctionLabel(r.kind, r.source), createdAt: r.created_at }]
      : [],
  );
}

export type CorrectionsRead = { ok: true; corrections: DeskCorrection[] } | { ok: false; error: string };

export function readCorrections(db: Database): CorrectionsRead {
  try {
    return { ok: true, corrections: listCorrections(db) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function setCorrection(db: Database, kind: DeskItemKind, source: string, mode: DeskCorrectionMode, now: number): void {
  db.query("INSERT INTO desk_corrections (kind, source, mode, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, source) DO UPDATE SET mode = excluded.mode, created_at = excluded.created_at")
    .run(kind, source, mode, now);
}

export function removeCorrection(db: Database, kind: DeskItemKind, source: string): boolean {
  return db.query("DELETE FROM desk_corrections WHERE kind = ? AND source = ?").run(kind, source).changes > 0;
}

const TIER: Record<DeskCorrectionMode | "none", number> = { always: 0, none: 1, less: 2 };

const byRank = (a: DeskItem, b: DeskItem): number =>
  TIER[a.correction ?? "none"] - TIER[b.correction ?? "none"] || b.score - a.score || a.key.localeCompare(b.key);

const HISTORY: Record<DeskCorrectionMode, string> = {
  less: "You asked for less like this, so it ranks below everything you have not marked.",
  always: "You asked to always show this, so it ranks above everything you have not marked.",
};

export function applyCorrections(items: DeskItem[], corrections: DeskCorrection[]): DeskItem[] {
  const modes = new Map(corrections.map((c) => [`${c.kind}\u0000${c.source}`, c.mode]));
  return items
    .map((item) => {
      const mode = item.kind === "mail" ? undefined : modes.get(`${item.kind}\u0000${item.source}`);
      return mode ? { ...item, correction: mode, detail: { ...item.detail, history: [...item.detail.history, HISTORY[mode]] } } : item;
    })
    .sort(byRank);
}
