import type { ClassifierConfig } from "../classify";
import type { StudioOptions } from "../types";
import { getStudioDraft } from "./draft";
import type { StudioWriteInput } from "./writer";
import { sessionMessages, sessionThread, type SessionDraftInput, type SessionPrompt } from "./session";
import type { StudioThreadView } from "./view";
import type { ActContext } from "./acts";

type DraftForThinking = { ok: true; draft: Pick<SessionDraftInput, "revision" | "text">; thread: StudioThreadView } | { ok: false; error: string };

const UNREADABLE = "The thread draft could not be read, so nothing was sent to a model. Your text is saved; retry the same turn.";

const POLICY_MOVED = "The thread's model policy changed while its draft was read, so nothing was sent to a model. Your text is saved; retry the same turn.";

export async function readDraftForThinking(
  input: { options: StudioOptions; areas: StudioWriteInput["areas"]; assistantName: string; thread: string },
  resolve: () => Promise<Pick<ActContext, "view">>,
): Promise<DraftForThinking> {
  const before = sessionThread(await resolve(), input.thread);
  if (!before) return { ok: false, error: UNREADABLE };
  let read;
  try { read = await getStudioDraft(input); }
  catch (err) {
    process.stderr.write(`studio draft read for thinking failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return { ok: false, error: UNREADABLE };
  }
  if (!read.ok) return { ok: false, error: UNREADABLE };
  const after = sessionThread(await resolve(), input.thread);
  if (!after) return { ok: false, error: UNREADABLE };
  if (after.policy !== before.policy) return { ok: false, error: POLICY_MOVED };
  return { ok: true, draft: { revision: read.draft.revision, text: read.draft.text }, thread: after };
}

function inputBound(prompt: SessionPrompt, assistantName: string): number {
  return sessionMessages(prompt, assistantName).reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0);
}

export function refuseUnfit(config: ClassifierConfig, prompt: SessionPrompt, assistantName: string): string | null {
  const { contextTokens, maxOutputTokens } = config;
  if (contextTokens === undefined || maxOutputTokens === undefined) {
    return "This model's context size or reserved answer size is not configured (contextTokens and maxOutputTokens), so the draft cannot be checked against it. Nothing was sent. Your text is saved.";
  }
  const needed = inputBound(prompt, assistantName) + maxOutputTokens;
  if (needed <= contextTokens) return null;
  return `The thread draft with its context and this conversation is too large for the permitted model: it needs at most ${needed} tokens including ${maxOutputTokens} reserved for the answer, and the model holds ${contextTokens}. Nothing was sent and the draft was not shortened. Shorten the draft or the conversation, or close and save the exchange. Your text is saved.`;
}
