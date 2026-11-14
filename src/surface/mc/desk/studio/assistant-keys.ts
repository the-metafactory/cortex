import { NOTES_HEADING } from "./format";
import { finish, mergeNotesSections, sectionsOf } from "./edit";

export { NOTES_HEADING };
export const CONVERSATION_TRIGGER = "Conversation";
export const CONVERSATION_MATERIAL = "Conversation";

const LEGACY_TRIGGER = /^trigger:[ \t]*Ivy conversation[ \t]*$/;
const LEGACY_MATERIAL = /^([-*][ \t]+)Ivy conversation:/;

/** A thread file with the old assistant keys renamed: the notes heading, the conversation trigger and the conversation material line. */
export function migrateThreadKeys(text: string): string {
  const merged = mergeNotesSections(text);
  const lines = merged.replace(/\r\n/g, "\n").split("\n");
  let changed = merged !== text;
  for (const s of sectionsOf(lines)) {
    for (let i = s.head + 1; i < s.end; i++) {
      const line = lines[i] ?? "";
      const next = s.key === "notes" && LEGACY_TRIGGER.test(line) ? `trigger: ${CONVERSATION_TRIGGER}`
        : s.key === "material" ? line.replace(LEGACY_MATERIAL, `$1${CONVERSATION_MATERIAL}:`)
        : line;
      if (next !== line) {
        lines[i] = next;
        changed = true;
      }
    }
  }
  return changed ? finish(lines) : text;
}
