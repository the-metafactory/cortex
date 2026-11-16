export type VoiceProviderId = "browser" | "elevenlabs";

export interface DeskWakeOptions {
  enabled: boolean;
  assistantName?: string;
  detector: "sherpa-2.0.1";
  model: "gigaspeech-3.3m-2024-01-01";
  phrase: string;
  tokens?: string[];
  tokenizerSha256?: string;
  threshold: number;
  score: number;
  preRollMs: number;
  silenceMs: number;
  maxCommandMs: number;
  speechThreshold: number;
}

export interface DeskVoice {
  enabled: boolean;
  input: VoiceProviderId;
  output: VoiceProviderId;
  wake?: DeskWakeOptions;
}
