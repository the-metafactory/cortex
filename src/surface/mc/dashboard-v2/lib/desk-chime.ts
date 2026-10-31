import type { DeskView } from "../../desk/types";

const CHIME_KEY = "desk.chimed";
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
  store: SeenStore;
  audio: () => ChimeAudio;
  wait?: number;
}

export async function chimeIfNew(view: DeskView, deps: ChimeDeps): Promise<boolean> {
  if (!view.chime) return false;
  const chimed = loadSeen(deps.store, CHIME_KEY);
  const fresh = freshInterrupts(view, chimed);
  if (fresh.length === 0) return false;
  const ctx = deps.audio();
  if (ctx.state !== "running") {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, deps.wait ?? 300));
    await Promise.race([ctx.resume().catch(() => undefined), timeout]);
  }
  if (ctx.state !== "running") return false;
  rememberSeen(deps.store, CHIME_KEY, chimed, fresh);
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
