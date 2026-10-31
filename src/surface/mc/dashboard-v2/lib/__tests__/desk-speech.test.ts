import { describe, expect, it } from "bun:test";
import { browserInput, elevenLabsOutput, NO_ANSWER, NO_MIC, NO_RECOGNITION, SpeechFailure, speechFor, voiceTurn, type SpeechEnv, type SpeechOut } from "../desk-speech";
import { NO_QUOTA } from "../../../desk/voice";
import { isBriefingRequest } from "../../../desk/present";

class FakeOut implements SpeechOut {
  said: string[] = [];
  constructor(private readonly failure: string | null = null) {}
  async speak(text: string): Promise<void> {
    if (this.failure) throw new SpeechFailure(this.failure);
    this.said.push(text);
  }
  stop(): void {}
}

const turnDeps = (output: SpeechOut, asked: string[] = []) => ({
  briefing: () => "Good morning. 2 things need you in Work.",
  isBriefing: isBriefingRequest,
  ask: async (said: string) => {
    asked.push(said);
    return "I drafted this reminder: call Daniela. Confirm it on screen.";
  },
  output,
});

describe("voiceTurn with a fake provider", () => {
  it("answers a briefing request in text and speech", async () => {
    const out = new FakeOut();
    const turn = await voiceTurn("what needs me", turnDeps(out));
    expect(turn).toEqual({ answer: "Good morning. 2 things need you in Work.", fallback: null });
    expect(out.said).toEqual([turn.answer]);
  });

  it("hands anything else to the ask pipeline", async () => {
    const asked: string[] = [];
    const turn = await voiceTurn("remind me to call Daniela at 5", turnDeps(new FakeOut(), asked));
    expect(asked).toEqual(["remind me to call Daniela at 5"]);
    expect(turn.answer).toContain("call Daniela");
  });

  it("answers in one line when the ask pipeline throws", async () => {
    const out = new FakeOut();
    const turn = await voiceTurn("remind me", { ...turnDeps(out), ask: async () => Promise.reject(new Error("boom")) });
    expect(turn).toEqual({ answer: NO_ANSWER, fallback: null });
    expect(out.said).toEqual([]);
  });

  it("falls back to text and says why in one line when the provider fails", async () => {
    const turn = await voiceTurn("what needs me", turnDeps(new FakeOut(NO_QUOTA)));
    expect(turn.answer).toBe("Good morning. 2 things need you in Work.");
    expect(turn.fallback).toBe(`${NO_QUOTA} Answering in text.`);
    expect(turn.fallback).not.toContain("\n");
  });
});

type Handler = ((e: never) => void) | null;
class FakeRecognition {
  static last: FakeRecognition | null = null;
  continuous = false;
  interimResults = false;
  lang = "";
  onresult: Handler = null;
  onerror: Handler = null;
  onend: (() => void) | null = null;
  started = false;
  constructor() {
    FakeRecognition.last = this;
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.onend?.();
  }
  abort(): void {}
  hear(...parts: string[]): void {
    const results = Object.assign(parts.map((transcript) => ({ 0: { transcript } })), { length: parts.length });
    (this.onresult as ((e: unknown) => void) | null)?.({ results });
  }
  fail(error: string): void {
    (this.onerror as ((e: unknown) => void) | null)?.({ error });
  }
}

describe("browser speech input", () => {
  it("shows the transcript live and returns it on release", async () => {
    const env = { SpeechRecognition: FakeRecognition } as unknown as SpeechEnv;
    const live: string[] = [];
    const session = browserInput(env).listen((t) => live.push(t));
    const rec = FakeRecognition.last;
    expect(rec?.started).toBe(true);
    expect(rec?.interimResults).toBe(true);
    rec?.hear("what");
    rec?.hear("what", " needs me");
    expect(live).toEqual(["what", "what needs me"]);
    expect(await session.stop()).toBe("what needs me");
  });

  it("says why when the browser cannot listen", async () => {
    expect(() => browserInput({}).listen(() => undefined)).toThrow(NO_RECOGNITION);
    const session = browserInput({ webkitSpeechRecognition: FakeRecognition } as unknown as SpeechEnv).listen(() => undefined);
    FakeRecognition.last?.fail("not-allowed");
    await expect(session.stop()).rejects.toThrow(NO_MIC);
  });
});

describe("ElevenLabs speech output", () => {
  it("turns the server's refusal line into a SpeechFailure", async () => {
    const env: SpeechEnv = { fetch: (async () => Response.json({ ok: false, error: NO_QUOTA }, { status: 502 })) as unknown as typeof fetch };
    const err = await elevenLabsOutput(env).speak("hi").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechFailure);
    expect((err as SpeechFailure).line).toBe(NO_QUOTA);
  });

  it("is chosen per direction from the stack config", async () => {
    const env: SpeechEnv = { fetch: (async () => Promise.reject(new Error("down"))) as unknown as typeof fetch };
    const mixed = speechFor({ enabled: true, input: "browser", output: "elevenlabs" }, env);
    expect(() => mixed.input.listen(() => undefined)).toThrow(NO_RECOGNITION);
    await expect(mixed.output.speak("x")).rejects.toThrow("Voice is off: Mission Control did not answer.");
  });
});
