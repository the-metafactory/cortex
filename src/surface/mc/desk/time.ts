export const DAY_MS = 86_400_000;

export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
