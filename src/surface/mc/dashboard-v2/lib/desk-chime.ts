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

export type ChimeAudio = Pick<AudioContext, "state" | "resume" | "currentTime" | "createOscillator" | "createGain" | "destination">;

export function playChime(ctx: ChimeAudio): void {
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
}

export interface ChimeDeps {
  store: ChimeStore;
  audio: () => ChimeAudio;
  wait?: number;
}

export async function chimeIfNew(view: DeskView, deps: ChimeDeps): Promise<boolean> {
  const chimed = loadChimed(deps.store);
  const fresh = freshInterrupts(view, chimed);
  if (fresh.length === 0) return false;
  const ctx = deps.audio();
  if (ctx.state !== "running") {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, deps.wait ?? 300));
    await Promise.race([ctx.resume().catch(() => undefined), timeout]);
  }
  if (ctx.state !== "running") return false;
  rememberChimed(deps.store, chimed, fresh);
  playChime(ctx);
  return true;
}

let shared: AudioContext | null = null;

export function chimeForNew(view: DeskView): void {
  if (typeof window === "undefined" || typeof AudioContext === "undefined") return;
  const audio = (): AudioContext => {
    shared ??= new AudioContext();
    return shared;
  };
  void chimeIfNew(view, { store: window.localStorage, audio }).catch(() => false);
}
