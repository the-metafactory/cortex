import type { DeskView } from "../../desk/types";

const KEEP = 200;

export function freshInterrupts(view: DeskView, seen: ReadonlySet<string>): string[] {
  return view.items.filter((i) => i.interrupt !== undefined && !seen.has(i.key)).map((i) => i.key);
}

export interface SeenStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadSeen(store: SeenStore, key: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(key) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberSeen(store: SeenStore, key: string, seen: ReadonlySet<string>, fresh: string[]): void {
  store.setItem(key, JSON.stringify([...seen, ...fresh].slice(-KEEP)));
}
