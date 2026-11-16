import type { DeskItem, DeskOutcome } from "./types";

type Suggesting = Pick<DeskItem, "actions" | "attention">;

function suggestedOutcome(item: Suggesting): DeskOutcome | null {
  const has = (id: string, primary = false): boolean => item.actions.some((action) => action.id === id && (!primary || action.role === "primary"));
  if (has("meeting.show")) return "attach";
  if (has("mail.draft", true)) return "draft";
  if (item.attention === "update" || has("mail.archive", true)) return "archive";
  return null;
}

export function withMailOutcome(item: DeskItem): DeskItem {
  if (item.kind !== "mail") return item;
  const outcome = suggestedOutcome(item);
  return outcome === null ? item : { ...item, outcome };
}
