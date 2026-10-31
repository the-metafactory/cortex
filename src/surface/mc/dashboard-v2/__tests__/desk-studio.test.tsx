import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskModeSwitch, DeskStudio, ortho, takeLastLook } from "../components/desk-studio";
import { deskSearch, readDeskLocation } from "../hooks/use-desk-studio";
import type { StudioThreadView, StudioView } from "../../desk/studio/view";

const AT = Date.parse("2026-10-31T09:00:00+01:00");

const thread = (slug: string, place: number, over: Partial<StudioThreadView> = {}): StudioThreadView => ({
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
  material: [{ kind: "file", label: "Shared brief" }],
  log: [],
  outcomeText: "",
  policy: "cloud",
  overCap: false,
  place,
  ...over,
});

const STUDIO: StudioView = {
  maxActive: 3,
  areas: [{ id: "lab", label: "Lab", color: "#7c3aed", policy: "cloud" }],
  active: [
    thread("one", 1, { notes: [{ at: "2026-10-31T03:12:00+01:00", trigger: "Stale thread: unchanged for 6 days", model: "cloud", kind: "note", status: "open", sample: true, text: "t" }] }),
    thread("two", 2),
  ],
  parked: [thread("shelf", 0, { state: "parked", place: undefined })],
  closed: [],
  inbox: [{ id: "idea", path: "inbox/idea.md", at: "2026-10-30T18:20:00+01:00", via: "voice", text: "An idea", target: { place: "new", reason: "It matches no thread." } }],
  proposals: [],
  problems: [{ path: "threads/bad.md", reason: "has no ## Question" }],
};

describe("the Studio board", () => {
  const html = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread={null} onOpenThread={() => {}} at={AT} />);

  it("shows each active thread as a card and the empty place as free", () => {
    expect([...html.matchAll(/data-card="([^"]+)"/g)].map((m) => m[1])).toEqual(["one", "two"]);
    expect(html).toContain('data-free="3"');
    expect(html).toContain("Place 3 is free");
    expect(html).toContain("Ivy waits on you");
  });

  it("writes each line as a sentence too, for the phone layout", () => {
    expect(html).toContain("Ivy would make it a thread in place 3.");
    expect(html).toContain("Why: It matches no thread.");
    expect(html).toContain("Shares a source with “What about two”: Shared brief.");
  });

  it("keeps parked threads, the decision journal and file problems on the page", () => {
    expect(html).toContain("What about shelf?");
    expect(html).toContain("Decision journal");
    expect(html).toContain("1 Studio file could not be read.");
  });

  it("shows the thread page in place of the board when a thread is open", () => {
    const open = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread="two" onOpenThread={() => {}} at={AT} />);
    expect(open).toContain('data-thread="two"');
    expect(open).not.toContain('aria-label="Thread board"');
    expect(open).toContain("Where I stand");
    expect(open).toContain("Relates to");
    expect(open).toContain("What about one?");
    expect(open).toContain("Shares a source: Shared brief.");
    expect(open).toContain("Log <span");
  });

  it("renders Keep, Discuss and Dismiss on Ivy's ghosts but disabled", () => {
    const idea = { at: "2026-10-31T04:05:00+01:00", trigger: "Fits the week's post", model: "cloud", kind: "idea" as const, status: "open" as const, sample: true, text: "Draft it?" };
    const studio: StudioView = { ...STUDIO, active: [thread("one", 1, { notes: [idea] }), thread("two", 2)] };
    const open = renderToStaticMarkup(<DeskStudio studio={studio} thread="one" onOpenThread={() => {}} at={AT} />);
    const buttons = [...open.matchAll(/<button type="button" class="desk-btn[^"]*" disabled="" title="[^"]+">([^<]+)</g)].map((m) => m[1]);
    expect(buttons).toEqual(["Close with an outcome", "Keep", "Discuss", "Dismiss"]);
  });

  it("says when the open thread is not in the Studio", () => {
    const open = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread="gone" onOpenThread={() => {}} at={AT} />);
    expect(open).toContain("This thread is not in the Studio.");
  });
});

describe("the Day | Studio switch", () => {
  it("shows Day and Studio with the current view selected when the stack has a Studio", () => {
    const html = renderToStaticMarkup(<DeskModeSwitch hasStudio inStudio onGo={() => {}} />);
    expect([...html.matchAll(/aria-selected="(true|false)">([^<]+)</g)].map((m) => [m[2], m[1]])).toEqual([["Day", "false"], ["Studio", "true"]]);
  });

  it("renders nothing without a Studio", () => {
    expect(renderToStaticMarkup(<DeskModeSwitch hasStudio={false} inStudio={false} onGo={() => {}} />)).toBe("");
  });
});

describe("the Studio location", () => {
  it("reads the view from the URL and ignores a thread outside the Studio", () => {
    expect(readDeskLocation("?desk=studio&thread=one")).toEqual({ mode: "studio", thread: "one" });
    expect(readDeskLocation("?thread=one")).toEqual({ mode: "day", thread: null });
    expect(readDeskLocation("?desk=nonsense")).toEqual({ mode: "day", thread: null });
  });

  it("writes the view into the URL and keeps other parameters", () => {
    expect(deskSearch("?legacy=0", { mode: "studio", thread: "one" })).toBe("?legacy=0&desk=studio&thread=one");
    expect(deskSearch("?desk=studio&thread=one", { mode: "day", thread: null })).toBe("");
  });
});

describe("the last look", () => {
  it("returns the previous look and stores the new one", () => {
    const data = new Map<string, string>([["desk.studio.lastLook", "100"]]);
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
    expect(takeLastLook(store, 200)).toBe(100);
    expect(data.get("desk.studio.lastLook")).toBe("200");
  });

  it("treats a missing or broken value as no look", () => {
    const store = { getItem: () => "garbage", setItem: () => {} };
    expect(takeLastLook(store, 200)).toBeNull();
    expect(takeLastLook(null, 200)).toBeNull();
  });
});

describe("board lines", () => {
  it("draws an orthogonal path with rounded corners", () => {
    expect(ortho([[0, 0], [20, 0], [20, 20]])).toBe("M0,0 L10,0 Q20,0 20,10 L20,20");
  });
});
