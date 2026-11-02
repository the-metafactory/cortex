/** Runs one pass at a time: a call while a pass runs shares it, and a failed pass is reported, never thrown. */
export class SingleFlight {
  private running: Promise<void> | null = null;

  run(work: () => Promise<void>, report: (message: string) => void): Promise<void> {
    this.running ??= work()
      .catch((err: unknown) => { report(err instanceof Error ? err.message : String(err)); })
      .finally(() => { this.running = null; });
    return this.running;
  }
}
