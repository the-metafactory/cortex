import type { ThreadOutcome, ThreadType } from "./format";

export const YES_ANSWERS = ["yes", "not sure", "no"] as const;

export const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const TYPE_LABEL: Record<ThreadType, string> = { question: "Question", topic: "Topic", making: "Making" };
const OUTCOME_LABEL: Record<ThreadOutcome, string> = { decided: "Decided", shipped: "Shipped", dropped: "Dropped" };
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export const dayMonth = (isoDate: string): string => `${Number(isoDate.slice(8, 10))} ${MONTHS[Number(isoDate.slice(5, 7)) - 1] ?? ""}`;

export const outcomeLabel = (t: { outcome?: ThreadOutcome }): string => (t.outcome ? OUTCOME_LABEL[t.outcome] : "Closed");

export const withHref = (href: string | undefined): { href?: string } => {
  const safe = safeHref(href);
  return safe ? { href: safe } : {};
};

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  try {
    return SAFE_SCHEMES.has(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}
