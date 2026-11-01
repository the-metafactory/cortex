import { DeskWakeSchema, WAKE_BPE_SHA } from "../../src/common/types/desk-wake";

export async function probeEngine(): Promise<unknown> {
  const context = new AudioContext();
  const results: { fixture: string; wakes: number; expected: number }[] = [];
  try {
    for (const fixture of [
      { name: "public-speech.wav", phrase: "EARLY NIGHTFALL", tokens: ["▁E", "AR", "LY", "▁", "N", "IGHT", "F", "AL", "L"], expected: 1 },
      { name: "hey-ivy.wav", phrase: "HEY IVY", tokens: ["▁HE", "Y", "▁I", "V", "Y"], expected: 0 },
      { name: "non-wake.wav", phrase: "HEY IVY", tokens: ["▁HE", "Y", "▁I", "V", "Y"], expected: 0 },
    ]) {
      const worker = new Worker("/wake/worker.js");
      let ready = false;
      let processed = 0;
      let wakes = 0;
      let error = "";
      const waitFor = async (claim: () => boolean): Promise<void> => {
        const start = performance.now();
        while (!claim()) {
          if (error) throw new Error(error);
          if (performance.now() - start > 45000) throw new Error("Sherpa fixture timed out");
          await new Promise(resolve => setTimeout(resolve, 5));
        }
      };
      worker.addEventListener("error", event => { error = event.message; });
      worker.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
        if (!data || typeof data !== "object" || !("type" in data)) return;
        if (data.type === "ready") ready = true;
        if (data.type === "processed" && "through" in data && typeof data.through === "number") processed = data.through;
        if (data.type === "wake") wakes++;
        if (data.type === "error" && "message" in data && typeof data.message === "string") error = data.message;
      });
      try {
        worker.postMessage({ type: "init", options: DeskWakeSchema.parse({ phrase: fixture.phrase, tokens: fixture.tokens, tokenizerSha256: WAKE_BPE_SHA }) });
        await waitFor(() => ready);
        worker.postMessage({ type: "reset", epoch: 1 });
        const response = await fetch(`/fixtures/${fixture.name}`);
        const decoded = await context.decodeAudioData(await response.arrayBuffer());
        const pcm = decoded.getChannelData(0);
        const samplesWithTail = new Float32Array(pcm.length + decoded.sampleRate);
        samplesWithTail.set(pcm);
        for (let at = 0; at < samplesWithTail.length; at += 1600) {
          const samples = samplesWithTail.slice(at, at + 1600);
          const through = at + samples.length;
          worker.postMessage({ type: "audio", samples, rate: decoded.sampleRate, through }, [samples.buffer]);
          await waitFor(() => processed >= through);
        }
        results.push({ fixture: fixture.name, wakes, expected: fixture.expected });
        if (wakes !== fixture.expected) throw new Error(`Sherpa fixture ${fixture.name}: ${wakes} wakes, expected ${fixture.expected}`);
      } finally { worker.terminate(); }
    }
  } finally { await context.close(); }
  return { results, syntheticMiss: "retained; does not establish live phrase accuracy" };
}
