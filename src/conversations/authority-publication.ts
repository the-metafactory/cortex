import { AsyncLocalStorage } from "node:async_hooks";

export class AuthorityPublication {
  private barrier: Promise<void> = Promise.resolve();
  private revision = 0;
  private readonly owner = new AsyncLocalStorage<{ active: boolean }>();

  get head(): number { return this.revision; }

  async run<T>(run: () => Promise<T>): Promise<T> {
    const prior = this.barrier;
    const next = Promise.withResolvers<undefined>();
    this.barrier = next.promise;
    await prior;
    const owner = { active: true };
    try { return await this.owner.run(owner, run); }
    finally { owner.active = false; next.resolve(undefined); }
  }

  publish<T>(change: () => Promise<T>): Promise<T> {
    this.revision++;
    return this.owner.getStore()?.active ? change() : this.run(change);
  }
}
