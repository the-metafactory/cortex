type Stop = () => Promise<void>;
type Open = (send: (frame: string) => Promise<void>, close: () => void) => Promise<Stop>;

export function sseResponse(requestSignal: AbortSignal, open: Open): Response {
  const cancelled = new AbortController();
  const signal = AbortSignal.any([requestSignal, cancelled.signal]);
  const encoder = new TextEncoder();
  let space = Promise.withResolvers<undefined>();
  const stream = new ReadableStream<Uint8Array>({
    start: async controller => {
      let stop: Stop | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const state = { closed: false };
      const cleanup = (): void => {
        state.closed = true;
        clearInterval(heartbeat);
        signal.removeEventListener("abort", close);
        space.resolve(undefined);
        void stop?.();
      };
      const close = (): void => {
        if (state.closed) return;
        cleanup();
        if (!cancelled.signal.aborted) controller.close();
      };
      const send = async (frame: string): Promise<void> => {
        while (!state.closed && controller.desiredSize !== null && controller.desiredSize <= 0) await space.promise;
        if (!state.closed) controller.enqueue(encoder.encode(frame));
      };
      signal.addEventListener("abort", close, { once: true });
      try {
        stop = await open(send, close);
        if (state.closed) { await stop(); return; }
        if (signal.aborted) { close(); return; }
        heartbeat = setInterval(() => {
          if (controller.desiredSize !== null && controller.desiredSize > 0) controller.enqueue(encoder.encode(": keepalive\n\n"));
        }, 15_000);
      } catch (error) {
        if (state.closed) return;
        cleanup();
        console.error("conversations: response stream failed", error);
        controller.error(error);
      }
    },
    pull: () => { space.resolve(undefined); space = Promise.withResolvers<undefined>(); },
    cancel: () => { cancelled.abort(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
