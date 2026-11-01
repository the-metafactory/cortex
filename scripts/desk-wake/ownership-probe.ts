import { fakeWorker } from "./fake-worker";
import { DeskWake, type WakeState } from "../../src/surface/mc/dashboard-v2/lib/desk-wake";
import { DeskWakeSchema, WAKE_BPE_SHA } from "../../src/common/types/desk-wake";

const contexts: AudioContext[] = [];
const streams: MediaStream[] = [];
const options = DeskWakeSchema.parse({ enabled: true, phrase: "HEY IVY", tokens: ["▁HE", "Y", "▁I", "V", "Y"], tokenizerSha256: WAKE_BPE_SHA });
const state = (value: WakeState): void => {
  document.body.dataset.phase = value.phase;
  document.body.dataset.line = value.phase === "off" ? "" : value.line;
};
const controller = new DeskWake(options, {
  state,
  media: {
    getUserMedia: async () => {
      const context = new AudioContext();
      contexts.push(context);
      await context.resume();
      const stream = context.createMediaStreamDestination().stream;
      streams.push(stream);
      document.body.dataset.microphones = String(streams.length);
      return stream;
    },
  } as MediaDevices,
  worker: () => fakeWorker(false),
  transcribe: () => { throw new Error("Ownership probe must not upload audio"); },
  answer: () => Promise.resolve(),
});
document.body.dataset.microphones = "0";
document.getElementById("enable")?.addEventListener("click", () => { void controller.enable(); });
document.getElementById("disable")?.addEventListener("click", () => {
  controller.disable();
  document.body.dataset.ended = String(streams.every(stream => stream.getTracks().every(track => track.readyState === "ended")));
  for (const context of contexts) void context.close();
});
