export class WakeBuffer {
  private frames: Float32Array[] = [];
  private length = 0;
  constructor(readonly capacity: number) {}
  push(samples: Float32Array): void {
    this.frames.push(samples.slice());
    this.length += samples.length;
    while (this.length > this.capacity) {
      const first = this.frames[0];
      if (!first) break;
      const excess = this.length - this.capacity;
      if (first.length <= excess) { this.frames.shift(); this.length -= first.length; }
      else { this.frames[0] = first.slice(excess); this.length -= excess; }
    }
  }
  take(): Float32Array {
    const result = new Float32Array(this.length);
    let at = 0;
    for (const frame of this.frames) { result.set(frame, at); at += frame.length; }
    return result;
  }
  clear(): void { this.frames = []; this.length = 0; }
}

export class CommandEndpoint {
  private duration = 0;
  private quiet = 0;
  private speech = 0;
  constructor(private readonly options: { silenceMs: number; maxCommandMs: number; speechThreshold: number }) {}
  push(samples: Float32Array, rate: number): "continue" | "empty" | "complete" {
    const ms = samples.length / rate * 1000;
    this.duration += ms;
    const rms = Math.sqrt(samples.reduce((sum, n) => sum + n * n, 0) / Math.max(1, samples.length));
    if (rms >= this.options.speechThreshold) { this.quiet = 0; this.speech += ms; }
    else this.quiet += ms;
    if (this.duration >= this.options.maxCommandMs || (this.speech >= 100 && this.quiet >= this.options.silenceMs)) return this.speech >= 100 ? "complete" : "empty";
    if (this.speech < 100 && this.duration >= Math.min(4000, this.options.maxCommandMs)) return "empty";
    return "continue";
  }
}

export function withoutWakePhrase(text: string, phrase: string): string {
  const words = phrase.trim().split(/\s+/).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return text.replace(new RegExp(`^\\s*${words.join("[\\s,.:;!?-]+")}(?=$|[\\s,.:;!?-])[\\s,.:;!?-]*`, "i"), "").trim();
}
