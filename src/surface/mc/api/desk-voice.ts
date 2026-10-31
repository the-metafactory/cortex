import type { DeskRuntime } from "../desk/compose";
import { elevenLabsSpeak, elevenLabsTranscribe, type ElevenLabsDeps, type ElevenLabsOptions } from "../desk/voice";

const noStore = { "Cache-Control": "no-store" };
const fail = (status: number, error: string): Response => Response.json({ ok: false, error }, { status, headers: noStore });
const MAX_SPEAK = 2000;
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

const elevenLabs = (runtime: DeskRuntime | undefined, direction: "input" | "output"): Response | ElevenLabsOptions => {
  const desk = runtime?.options;
  if (!desk?.enabled) return fail(409, "The Desk is turned off on this stack.");
  const voice = desk.voice;
  if (voice?.enabled === false) return fail(409, "Voice is turned off on this stack.");
  if (voice?.[direction] !== "elevenlabs" || !voice.elevenlabs) return fail(409, `Voice ${direction} does not use ElevenLabs on this stack.`);
  return voice.elevenlabs;
};

export async function handleDeskSpeak(req: Request, runtime: DeskRuntime | undefined, deps: ElevenLabsDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const opts = elevenLabs(runtime, "output");
  if (opts instanceof Response) return opts;
  const body = (await req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return fail(400, "There is nothing to say.");
  if (text.length > MAX_SPEAK) return fail(400, `That is longer than ${MAX_SPEAK} characters.`);
  const r = await elevenLabsSpeak(text, opts, deps);
  if (!r.ok) return fail(r.status, r.line);
  return new Response(r.value, { headers: { ...noStore, "content-type": "audio/mpeg" } });
}

export async function handleDeskTranscribe(req: Request, runtime: DeskRuntime | undefined, deps: ElevenLabsDeps = {}): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const opts = elevenLabs(runtime, "input");
  if (opts instanceof Response) return opts;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_AUDIO_BYTES) return fail(413, "That recording is too long.");
  const audio = await req.blob().catch(() => null);
  if (!audio || audio.size === 0) return fail(400, "No audio arrived.");
  if (audio.size > MAX_AUDIO_BYTES) return fail(413, "That recording is too long.");
  const r = await elevenLabsTranscribe(audio, opts, deps);
  if (!r.ok) return fail(r.status, r.line);
  return Response.json({ ok: true, text: r.value }, { headers: noStore });
}
