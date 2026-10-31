import type { DeskView } from "../../desk/types";

const STORE_KEY = "desk.chimed";
const KEEP = 200;

export function freshInterrupts(view: DeskView, chimed: ReadonlySet<string>): string[] {
  if (!view.chime) return [];
  return view.items.filter((i) => i.interrupt !== undefined && !chimed.has(i.key)).map((i) => i.key);
}

export interface ChimeStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function loadChimed(store: ChimeStore): Set<string> {
  try {
    const parsed: unknown = JSON.parse(store.getItem(STORE_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberChimed(store: ChimeStore, chimed: ReadonlySet<string>, fresh: string[]): void {
  store.setItem(STORE_KEY, JSON.stringify([...chimed, ...fresh].slice(-KEEP)));
}

export function playChime(ctx: AudioContext): void {
  const t = ctx.currentTime;
  [880, 1318.5].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = t + i * 0.16;
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.32);
  });
  setTimeout(() => void ctx.close(), 800);
}

export function chimeForNew(view: DeskView): void {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
  const chimed = loadChimed(window.localStorage);
  const fresh = freshInterrupts(view, chimed);
  if (fresh.length === 0) return;
  rememberChimed(window.localStorage, chimed, fresh);
  try {
    playChime(new AudioContext());
  } catch {
    return;
  }
}
