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

const TOO_LONG = Symbol("too long");

async function readCapped(req: Request, max: number): Promise<Blob | null | typeof TOO_LONG> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return TOO_LONG;
  if (!req.body) return null;
  const reader = req.body.getReader();
  const chunks: BlobPart[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        return TOO_LONG;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return new Blob(chunks, { type: req.headers.get("content-type") ?? "application/octet-stream" });
}

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
  const audio = await readCapped(req, MAX_AUDIO_BYTES);
  if (audio === TOO_LONG) return fail(413, "That recording is too long.");
  if (!audio || audio.size === 0) return fail(400, "No audio arrived.");
  const r = await elevenLabsTranscribe(audio, opts, deps);
  if (!r.ok) return fail(r.status, r.line);
  return Response.json({ ok: true, text: r.value }, { headers: noStore });
}
