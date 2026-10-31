import { describe, expect, it } from "bun:test";
import { McSchema } from "../../../common/types/config";
import { handleDeskSpeak, handleDeskTranscribe } from "../api/desk-voice";
import type { DeskOptions, DeskRuntime } from "../desk/compose";
import { HandledLedger } from "../desk/actions";
import { isBriefingRequest, selectItems, spokenBriefing } from "../desk/present";
import type { DeskItem, DeskView } from "../desk/types";
import { envFileValue, KEY_REFUSED, resolveVoice, NO_KEY, NO_QUOTA, readVoiceKey, UNREACHABLE, type ElevenLabsOptions } from "../desk/voice";

const ELEVEN: ElevenLabsOptions = { voiceId: "voice12345", apiKeyEnv: "ELEVENLABS_API_KEY", ttsModel: "eleven_turbo_v2_5", sttModel: "scribe_v1", timeoutSeconds: 5 };
const DESK: DeskOptions = { enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [], sources: [], voice: { enabled: true, input: "elevenlabs", output: "elevenlabs", elevenlabs: ELEVEN } };
const runtime = (options: DeskOptions = DESK): DeskRuntime => ({ options, ledger: new HandledLedger() });
const speak = (text: string): Request => new Request("http://mc/api/desk/voice/speak", { method: "POST", body: JSON.stringify({ text }) });
const key = async (): Promise<string> => "k-test";

describe("desk voice key", () => {
  it("reads a variable from an env file without exposing anything else", () => {
    expect(envFileValue("# c\nOTHER=x\nexport ELEVENLABS_API_KEY=\"abc123\"\n", "ELEVENLABS_API_KEY")).toBe("abc123");
    expect(envFileValue("ELEVENLABS_API_KEY=\n", "ELEVENLABS_API_KEY")).toBeNull();
    expect(envFileValue("OTHER=x\n", "ELEVENLABS_API_KEY")).toBeNull();
  });

  it("prefers the env file when one is set, else the process environment", async () => {
    const read = async (): Promise<string> => "ELEVENLABS_API_KEY='from-file'\n";
    expect(await readVoiceKey({ apiKeyEnv: "ELEVENLABS_API_KEY", envFile: "/x/.env" }, {}, read)).toBe("from-file");
    expect(await readVoiceKey({ apiKeyEnv: "ELEVENLABS_API_KEY" }, { ELEVENLABS_API_KEY: " from-env " })).toBe("from-env");
    expect(await readVoiceKey({ apiKeyEnv: "ELEVENLABS_API_KEY", envFile: "/missing" }, {}, async () => null)).toBeNull();
  });
});

describe("desk voice config", () => {
  it("expands the env file path only", () => {
    const voice = { enabled: true, input: "browser" as const, output: "elevenlabs" as const, elevenlabs: { ...ELEVEN, envFile: "~/.claude/.env" } };
    expect(resolveVoice(voice, (p) => p.replace("~", "/home/x")).elevenlabs?.envFile).toBe("/home/x/.claude/.env");
    expect(resolveVoice(DESK.voice ?? voice, (p) => `X${p}`)).toBe(DESK.voice ?? voice);
  });

  it("defaults to browser speech in and out", () => {
    expect(McSchema.parse({}).desk.voice).toEqual({ enabled: true, input: "browser", output: "browser" });
  });

  it("refuses ElevenLabs without its block", () => {
    const r = McSchema.safeParse({ desk: { voice: { output: "elevenlabs" } } });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("mc.desk.voice.elevenlabs is required");
  });
});

describe("POST /api/desk/voice/speak", () => {
  it("returns the provider's audio and sends the key only as a header", async () => {
    const seen: { url: string; key: string | null; body: string }[] = [];
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      seen.push({ url, key: new Headers(init.headers).get("xi-api-key"), body: typeof init.body === "string" ? init.body : "" });
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });
    };
    const res = await handleDeskSpeak(speak("Two things need you."), runtime(), { fetchImpl, readKey: key });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seen).toEqual([{ url: expect.stringContaining("/text-to-speech/voice12345"), key: "k-test", body: expect.stringContaining("Two things need you.") }]);
  });

  it("says why in one line when the provider has no quota", async () => {
    const fetchImpl = async (): Promise<Response> => Response.json({ detail: { status: "quota_exceeded", message: "..." } }, { status: 401 });
    const res = await handleDeskSpeak(speak("hi"), runtime(), { fetchImpl, readKey: key });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: NO_QUOTA });
  });

  it("separates a refused key, an unreachable provider and a missing key", async () => {
    const refused = await handleDeskSpeak(speak("hi"), runtime(), { fetchImpl: async () => Response.json({ detail: { status: "invalid_api_key" } }, { status: 401 }), readKey: key });
    expect((await refused.json()).error).toBe(KEY_REFUSED);
    const down = await handleDeskSpeak(speak("hi"), runtime(), { fetchImpl: async () => Promise.reject(new Error("ECONNREFUSED")), readKey: key });
    expect((await down.json()).error).toBe(UNREACHABLE);
    const none = await handleDeskSpeak(speak("hi"), runtime(), { readKey: async () => null });
    expect(none.status).toBe(503);
    expect((await none.json()).error).toBe(NO_KEY);
  });

  it("refuses when the stack speaks through the browser", async () => {
    const res = await handleDeskSpeak(speak("hi"), runtime({ ...DESK, voice: { enabled: true, input: "browser", output: "browser" } }), { readKey: key });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/desk/voice/transcribe", () => {
  it("returns the provider's transcript", async () => {
    const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
      expect(url).toEndWith("/speech-to-text");
      expect((init.body as FormData).get("model_id")).toBe("scribe_v1");
      return Response.json({ text: " what needs me " });
    };
    const req = new Request("http://mc/api/desk/voice/transcribe", { method: "POST", body: new Blob([new Uint8Array([9, 9])], { type: "audio/webm" }) });
    const res = await handleDeskTranscribe(req, runtime(), { fetchImpl, readKey: key });
    expect(await res.json()).toEqual({ ok: true, text: "what needs me" });
  });

  it("refuses an oversized recording before reading it", async () => {
    const req = new Request("http://mc/api/desk/voice/transcribe", { method: "POST", headers: { "content-length": String(11 * 1024 * 1024) }, body: "x" });
    expect((await handleDeskTranscribe(req, runtime(), { readKey: key })).status).toBe(413);
  });

  it("stops reading a chunked recording once it passes the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(4 * 1024 * 1024));
        if (pulled > 10) controller.close();
      },
    });
    const req = new Request("http://mc/api/desk/voice/transcribe", { method: "POST", body: stream });
    expect((await handleDeskTranscribe(req, runtime(), { readKey: key })).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(4);
  });

  it("refuses an empty recording", async () => {
    const req = new Request("http://mc/api/desk/voice/transcribe", { method: "POST", body: "" });
    expect((await handleDeskTranscribe(req, runtime(), { readKey: key })).status).toBe(400);
  });
});

const NOW = new Date("2026-10-31T10:00:00").getTime();
const item = (n: number, area: string): DeskItem => ({
  key: `k${n}`,
  kind: "escalation",
  source: "vigil",
  area,
  urgency: "today",
  title: `The ${area} task ${n} is blocked.`,
  why: `It waited since ${n} o'clock`,
  score: 100 - n,
  actions: [],
  detail: { summary: "", history: [], refs: [], links: [] },
});
const VIEW = {
  generatedAt: NOW,
  displayName: "JC",
  topN: 5,
  areas: [{ id: "work", label: "Work", color: "" }, { id: "home", label: "Home", color: "" }],
  items: [item(1, "work"), item(2, "home"), item(3, "work")],
  agents: { line: "1 agent working, 2 waiting on you", working: [], waiting: 2 },
  sources: [{ id: "vigil", ok: true }],
} as unknown as DeskView;

describe("spoken briefing", () => {
  it("knows a briefing request when it hears one", () => {
    expect(isBriefingRequest("What needs me?")).toBe(true);
    expect(isBriefingRequest("brief me")).toBe(true);
    expect(isBriefingRequest("give me my briefing")).toBe(true);
    expect(isBriefingRequest("remind me to call Daniela at 5")).toBe(false);
    expect(isBriefingRequest("remind me to send the brief to Anna")).toBe(false);
    expect(isBriefingRequest("move the briefing to 3")).toBe(false);
    expect(isBriefingRequest("Ivy, what's up today?")).toBe(true);
    expect(isBriefingRequest("what's on Anna's agenda")).toBe(false);
    expect(isBriefingRequest("what is new in the release")).toBe(false);
    expect(isBriefingRequest("what should I do about the leak")).toBe(false);
  });

  it("mentions only the filtered area's items", () => {
    const text = spokenBriefing(VIEW, selectItems(VIEW, "home", new Set()), "Home");
    expect(text).toContain("home task 2");
    expect(text).not.toContain("work task");
    expect(text).not.toContain("agent working");
    expect(text).toStartWith("Good morning, JC. 1 thing needs you in Home.");
  });

  it("reads every area with agents when no filter is set", () => {
    const text = spokenBriefing(VIEW, selectItems(VIEW, "all", new Set()), null);
    expect(text).toContain("First: the work task 1 is blocked. It waited since 1 o'clock.");
    expect(text).toContain("Second: the home task 2 is blocked.");
    expect(text).toContain("1 agent working, 2 waiting on you.");
  });

  it("says so when nothing in the area needs the person", () => {
    const text = spokenBriefing(VIEW, selectItems(VIEW, "home", new Set(["k2"])), "Home");
    expect(text).toBe("Good morning, JC. Nothing needs you in Home right now.");
  });
});
