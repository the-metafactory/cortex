class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.count = 0;
    this.credits = 8;
    this.dropped = 0;
    this.epoch = 0;
    this.port.onmessage = ({ data }) => {
      if (data === "ack") this.credits = Math.min(8, this.credits + 1);
      else if (data?.type === "reset") { this.epoch = data.epoch; this.frames = []; this.count = 0; this.dropped = 0; }
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      if (!this.credits) { this.dropped += samples.length; return true; }
      this.frames.push(samples.slice());
      this.count += samples.length;
      if (this.count >= 2048) {
        const chunk = new Float32Array(this.count);
        let at = 0;
        for (const frame of this.frames) { chunk.set(frame, at); at += frame.length; }
        this.port.postMessage({ samples: chunk, dropped: this.dropped, epoch: this.epoch }, [chunk.buffer]);
        this.credits--;
        this.dropped = 0;
        this.frames = [];
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("desk-wake-capture", Capture);
