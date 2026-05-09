/**
 * Scan the session's events for artefact references — branch / PR / issue.
 *
 * Per migration addendum Decision 11:
 * - Branch: first match of `git checkout -b <name>` or `git switch -c <name>`
 *   in tool_use args.
 * - PR URL: `github.com/<org>/<repo>/pull/<n>` anywhere in tool_use args
 *   or tool_result output.
 * - Issue: `<repo>#<n>` or `github.com/<org>/<repo>/issues/<n>`.
 *
 * Returns the most recent of each (later events override earlier ones).
 * MIG-4+ may extend with PR-status fetcher, diff summary, etc.
 */

import { useMemo } from "react";
import type { McEvent } from "../../types";

export interface Artefacts {
  branch: string | null;
  prUrl: string | null;
  issueRef: string | null;
}

const BRANCH_RE = /\bgit\s+(?:checkout\s+-b|switch\s+-c)\s+(\S+)/;
const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
const ISSUE_REF_RE = /\b([\w.-]+)#(\d+)/;
const ISSUE_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+/;

export function useArtefacts(events: McEvent[]): Artefacts {
  return useMemo(() => {
    let branch: string | null = null;
    let prUrl: string | null = null;
    let issueRef: string | null = null;

    for (const ev of events) {
      const text = serialiseSearchableText(ev);
      if (!text) continue;
      const b = text.match(BRANCH_RE);
      if (b && b[1]) branch = b[1];
      const p = text.match(PR_URL_RE);
      if (p) prUrl = p[0];
      const iUrl = text.match(ISSUE_URL_RE);
      if (iUrl) issueRef = iUrl[0];
      else {
        const i = text.match(ISSUE_REF_RE);
        if (i) issueRef = i[0];
      }
    }
    return { branch, prUrl, issueRef };
  }, [events]);
}

/**
 * Flatten an event into a single string we can regex over. Walks
 * `payload.message.content[]` blocks and concatenates all text-bearing
 * fields. Defensive about shape — unknown event types contribute their
 * `payload` JSON-stringified.
 */
function serialiseSearchableText(ev: McEvent): string {
  if (ev.type === "stream-json.assistant" || ev.type === "stream-json.user") {
    const message = (ev.payload as { message?: { content?: unknown } })?.message;
    if (!message || !Array.isArray(message.content)) return "";
    const parts: string[] = [];
    for (const block of message.content as Array<Record<string, unknown>>) {
      if (!block) continue;
      if (typeof block["text"] === "string") parts.push(block["text"] as string);
      if (block["type"] === "tool_use") {
        const input = block["input"];
        if (input && typeof input === "object") parts.push(JSON.stringify(input));
      }
      if (block["type"] === "tool_result") {
        const content = block["content"];
        if (typeof content === "string") parts.push(content);
        else if (Array.isArray(content)) {
          for (const sub of content) {
            if (sub && typeof (sub as { text?: string }).text === "string") {
              parts.push((sub as { text: string }).text);
            }
          }
        }
      }
    }
    return parts.join("\n");
  }
  if (ev.type === "operator.input") {
    const text = (ev.payload as { text?: string })?.text;
    return typeof text === "string" ? text : "";
  }
  return "";
}
