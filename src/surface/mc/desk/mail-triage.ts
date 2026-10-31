import type { MailEvidence, SuggestedAction } from "./classify";
import type { DeskEvidence } from "./types";

export interface EvidenceLinks {
  mail?: string;
  note?: string;
}

export const TIMELINE_DAYS = 5;

const SUGGESTIONS: Partial<Record<string, string>> = {
  reply: "Suggested: reply",
  archive: "Suggested: archive",
  task: "Suggested: make it a task",
};

export const suggestionLine = (suggested: SuggestedAction | undefined): string | undefined => (suggested ? SUGGESTIONS[suggested] : undefined);

const bareMessageId = (ref: string): string => ref.replace(/^<|>$/g, "");

export function evidenceUrl(template: string | undefined, kind: "mail" | "note", ref: string): string | undefined {
  if (!template) return undefined;
  return template.replaceAll("{ref}", encodeURIComponent(kind === "mail" ? bareMessageId(ref) : ref));
}

export function evidenceView(evidence: MailEvidence[], onDesk: ReadonlySet<string>, links: EvidenceLinks): DeskEvidence[] {
  return evidence.flatMap((e): DeskEvidence[] => {
    switch (e.kind) {
      case "event":
        return [{ kind: "event", title: e.title, ...(onDesk.has(e.ref) ? { eventKey: e.ref } : {}) }];
      case "mail":
      case "note": {
        const url = evidenceUrl(links[e.kind], e.kind, e.ref);
        return [{ kind: e.kind, title: e.title, ...(url ? { url } : {}) }];
      }
      default:
        return [];
    }
  });
}
