let releasing: Promise<void> = Promise.resolve();

export async function ownMicrophone(signal: AbortSignal, locks: LockManager | undefined = navigator.locks): Promise<() => void> {
  if (!locks) throw new Error("This browser cannot coordinate microphone use across tabs.");
  await releasing;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const held = locks.request("cortex-desk-microphone", { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error("Another Desk tab is using the microphone. Disable it there first.")); return; }
      await new Promise<void>((release) => {
        const relinquish = (): void => { release(); releasing = held.then(() => undefined, () => undefined); };
        signal.addEventListener("abort", relinquish, { once: true });
        if (signal.aborted) { relinquish(); reject(signal.reason); return; }
        resolve(relinquish);
      });
    });
    void held.catch(reject);
  });
}
