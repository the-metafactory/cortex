class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frames = [];
    this.count = 0;
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples) {
      this.frames.push(samples.slice());
      this.count += samples.length;
      if (this.count >= 2048) {
        const chunk = new Float32Array(this.count);
        let at = 0;
        for (const frame of this.frames) { chunk.set(frame, at); at += frame.length; }
        this.port.postMessage(chunk, [chunk.buffer]);
        this.frames = [];
        this.count = 0;
      }
    }
    return true;
  }
}
registerProcessor("desk-wake-capture", Capture);
