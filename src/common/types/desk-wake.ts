import { z } from "zod";

export const WAKE_BPE_SHA = "c8a2a0129c4ab8e463164c142f82d25649661b122c8cd0b7aab5c9e80b90ad24";
export const DeskWakeSchema = z.object({
  enabled: z.boolean().default(false),
  agentName: z.string().min(1).max(60).default("Assistant"),
  detector: z.literal("sherpa-2.0.1").default("sherpa-2.0.1"),
  model: z.literal("gigaspeech-3.3m-2024-01-01").default("gigaspeech-3.3m-2024-01-01"),
  phrase: z.string().regex(/^[A-Za-z ]{2,60}$/).default("Hey Assistant"),
  tokens: z.array(z.string().min(1).max(30)).min(1).max(80).optional(),
  tokenizerSha256: z.string().optional(),
  threshold: z.number().min(0.01).max(1).default(0.25),
  score: z.number().min(0.1).max(10).default(3),
  preRollMs: z.number().int().min(500).max(3000).default(2000),
  silenceMs: z.number().int().min(300).max(3000).default(900),
  maxCommandMs: z.number().int().min(3000).max(30000).default(15000),
  speechThreshold: z.number().min(0.001).max(0.2).default(0.015),
});

export type DeskWakeOptions = z.infer<typeof DeskWakeSchema>;

export function wakeConfigurationError(options: DeskWakeOptions): string | null {
  if (!options.tokens?.length || options.tokenizerSha256 !== WAKE_BPE_SHA) return "Provision this phrase with scripts/desk-wake/phrase.py and the matched BPE model.";
  const decoded = options.tokens.join("").replaceAll("▁", " ").trim();
  if (decoded !== options.phrase.trim().replace(/\s+/g, " ").toUpperCase()) return "The wake phrase and provisioned tokens differ. Provision the phrase again.";
  return null;
}
