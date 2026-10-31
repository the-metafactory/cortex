import type { VOICE_PROVIDERS } from "../../../common/types/config";

export type VoiceProviderId = (typeof VOICE_PROVIDERS)[number];

export interface ElevenLabsOptions {
  voiceId: string;
  apiKeyEnv: string;
  envFile?: string;
  ttsModel: string;
  sttModel: string;
  timeoutSeconds: number;
}

export interface VoiceOptions {
  enabled: boolean;
  input: VoiceProviderId;
  output: VoiceProviderId;
  elevenlabs?: ElevenLabsOptions;
}

export type DeskVoice = Omit<VoiceOptions, "elevenlabs">;

export const voiceView = (v: VoiceOptions | undefined): DeskVoice => ({ enabled: v?.enabled ?? true, input: v?.input ?? "browser", output: v?.output ?? "browser" });

export type VoiceResult<T> = { ok: true; value: T } | { ok: false; status: number; line: string };

export type TextReader = (path: string) => Promise<string | null>;

export const readTextFile: TextReader = async (path) => {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : null;
};

export function envFileValue(content: string, name: string): string | null {
  for (const raw of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(raw);
    if (match?.[1] !== name) continue;
    const value = (match[2] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

export async function readVoiceKey(opts: Pick<ElevenLabsOptions, "apiKeyEnv" | "envFile">, env: Record<string, string | undefined> = process.env, read: TextReader = readTextFile): Promise<string | null> {
  if (opts.envFile) {
    const content = await read(opts.envFile).catch(() => null);
    return content === null ? null : envFileValue(content, opts.apiKeyEnv);
  }
  const value = env[opts.apiKeyEnv]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

const API = "https://api.elevenlabs.io/v1";
export const NO_KEY = "Voice is off: no ElevenLabs key is set up on this stack.";
export const UNREACHABLE = "Voice is off: ElevenLabs is unreachable.";
export const NO_QUOTA = "Voice is off: ElevenLabs has no quota left.";
export const KEY_REFUSED = "Voice is off: ElevenLabs refused the key.";

export async function providerFailureLine(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: { status?: unknown } | string } | null;
  const status = typeof body?.detail === "object" && typeof body.detail.status === "string" ? body.detail.status : "";
  if (status === "quota_exceeded" || res.status === 402 || res.status === 429) return NO_QUOTA;
  if (res.status === 401 || res.status === 403) return KEY_REFUSED;
  return `Voice is off: ElevenLabs answered HTTP ${res.status}.`;
}

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ElevenLabsDeps {
  fetchImpl?: Fetch;
  readKey?: (opts: ElevenLabsOptions) => Promise<string | null>;
}

async function call(opts: ElevenLabsOptions, path: string, init: RequestInit, deps: ElevenLabsDeps): Promise<VoiceResult<Response>> {
  const key = await (deps.readKey ?? ((o) => readVoiceKey(o)))(opts);
  if (!key) return { ok: false, status: 503, line: NO_KEY };
  let res: Response;
  try {
    res = await (deps.fetchImpl ?? fetch)(`${API}${path}`, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), "xi-api-key": key },
      signal: AbortSignal.timeout(opts.timeoutSeconds * 1000),
    });
  } catch {
    return { ok: false, status: 502, line: UNREACHABLE };
  }
  if (!res.ok) return { ok: false, status: 502, line: await providerFailureLine(res) };
  return { ok: true, value: res };
}

export async function elevenLabsSpeak(text: string, opts: ElevenLabsOptions, deps: ElevenLabsDeps = {}): Promise<VoiceResult<ArrayBuffer>> {
  const r = await call(opts, `/text-to-speech/${encodeURIComponent(opts.voiceId)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text, model_id: opts.ttsModel }),
  }, deps);
  if (!r.ok) return r;
  try {
    return { ok: true, value: await r.value.arrayBuffer() };
  } catch {
    return { ok: false, status: 502, line: UNREACHABLE };
  }
}

export async function elevenLabsTranscribe(audio: Blob, opts: ElevenLabsOptions, deps: ElevenLabsDeps = {}): Promise<VoiceResult<string>> {
  const form = new FormData();
  form.set("model_id", opts.sttModel);
  form.set("file", audio, "speech.webm");
  const r = await call(opts, "/speech-to-text", { method: "POST", body: form }, deps);
  if (!r.ok) return r;
  const body = (await r.value.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  return text ? { ok: true, value: text } : { ok: false, status: 422, line: "I did not catch that. Try again or type it." };
}
