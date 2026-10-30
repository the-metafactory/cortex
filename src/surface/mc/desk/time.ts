export const DAY_MS = 86_400_000;

/** "14:05" in local time. */
export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5);
}

/** Local midnight of the day that contains `now`, as epoch ms. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
