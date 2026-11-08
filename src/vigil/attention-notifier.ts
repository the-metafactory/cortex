import { publishReconcileDelta, type AttentionDelta } from "../surface/mc/attention-notify";

type PublishDelta = Parameters<typeof publishReconcileDelta>[2];

export interface AttentionNotifier {
  publish(delta: AttentionDelta): Promise<void>;
  drain(): Promise<void>;
}

export function createAttentionNotifier(opts: {
  publish: PublishDelta | undefined;
  principal: string;
  log: { warn(message: string): void };
}): AttentionNotifier {
  let queue: Promise<void> = Promise.resolve();
  const publish = (delta: AttentionDelta): Promise<void> => {
    const send = opts.publish;
    if (!send || (delta.opened.length === 0 && delta.resolved.length === 0)) return queue;
    queue = queue.then(async () => {
      try {
        await publishReconcileDelta(delta, {
          source: { principal: opts.principal, agent: "cortex", instance: "local" },
        }, send);
      } catch (err) {
        opts.log.warn(`vigil: attention notification failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    return queue;
  };
  return { publish, drain: () => queue };
}
