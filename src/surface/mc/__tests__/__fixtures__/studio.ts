import type { IvyNote } from "../../desk/studio/format";
import type { StudioThreadView } from "../../desk/studio/view";

export const studioNote = (at: string, over: Partial<IvyNote> = {}): IvyNote => ({ at, trigger: "Stale thread: unchanged for 6 days", model: "cloud", kind: "note", status: "open", sample: true, text: "A thought.", ...over });

export const studioThread = (slug: string, over: Partial<StudioThreadView> = {}): StudioThreadView => ({
  slug,
  path: `threads/${slug}.md`,
  type: "question",
  areas: ["lab"],
  state: "active",
  opened: "2026-10-20",
  thinkTonight: false,
  question: `What about ${slug}?`,
  stand: "Not settled.",
  notes: [],
  responses: [],
  material: [],
  log: [],
  outcomeText: "",
  policy: "cloud",
  overCap: false,
  ...over,
});
