import type { Database } from "bun:sqlite";
import type { RoutineOptions, RoutineRunner, RoutineView } from "./routine-command";
import { routineConfigHash } from "./routine-store";
import { readRoutines } from "./routines";

export class RoutineReadLoop {
  private snapshot: RoutineView = { installed: [], pending: [], done: [], changes: [], error: "Routines are loading." };
  private inFlight: Promise<void> | null = null;
  private at = 0;
  private hash = "";

  read(db: Database, options: RoutineOptions, now: number): RoutineView {
    const hash = routineConfigHash(options);
    if (hash !== this.hash) {
      this.hash = hash;
      this.at = 0;
      this.snapshot = { installed: [], pending: [], done: [], changes: [], error: "Routines are loading." };
    }
    if (!this.inFlight && now - this.at > 5000) void this.refresh(db, options, now);
    return this.snapshot;
  }

  refresh(db: Database, options: RoutineOptions, now = Date.now(), run?: RoutineRunner): Promise<void> {
    this.hash = routineConfigHash(options);
    this.inFlight ??= readRoutines(db, options, run).then((view) => { this.snapshot = view; this.at = now; }).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async afterWrite(db: Database, options: RoutineOptions): Promise<void> {
    await this.inFlight;
    await this.refresh(db, options);
  }
}
