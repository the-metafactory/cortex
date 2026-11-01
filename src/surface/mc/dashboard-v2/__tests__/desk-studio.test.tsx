import { StudioSessionPanel, type StudioSessionControls } from "../components/desk-studio-session";
import { waitsOnYou } from "../../desk/studio/board";
import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DeskModeSwitch, DeskStudio, ortho, takeLastLook } from "../components/desk-studio";
import { OpenSheet } from "../components/desk-studio-acts";
import { deskSearch, readDeskLocation } from "../hooks/use-desk-studio";
import { requestIdFor } from "../hooks/use-studio-act";
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
  responses: [],
  material: [{ kind: "file", label: "Shared brief" }],
  log: [],
  outcomeText: "",
  policy: "cloud",
  overCap: false,
  place,
  ...over,
});

const STUDIO: StudioView = {
  personas: ["A skeptic"],
  thinking: { kind: "ready", dailyRuns: { local: 5, cloud: 5 }, runs: [] },
  maxActive: 3,
  yesFilter: { questions: ["Is this mine to do?", "Does it fit my capacity?", "What will I stop doing for it?"], fromConfig: false },
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

  it("makes Keep, Discuss, Talk it through, Dismiss and Close live", () => {
    const idea = { at: "2026-10-31T04:05:00+01:00", trigger: "Fits the week's post", model: "cloud", kind: "idea" as const, status: "open" as const, sample: true, text: "Draft it?" };
    const studio: StudioView = { ...STUDIO, active: [thread("one", 1, { notes: [idea] }), thread("two", 2)] };
    const open = renderToStaticMarkup(<DeskStudio studio={studio} thread="one" onOpenThread={() => {}} onDiscuss={() => {}} at={AT} />);
    const disabled = [...open.matchAll(/<button type="button" class="desk-btn[^"]*" disabled="" title="[^"]+">([^<]+)</g)].map((m) => m[1]);
    expect(disabled).toEqual([]);
    expect(open).toContain(">Discuss</button>");
    expect(open).toContain(">Talk it through</button>");
    expect(open).toContain(">Close with an outcome</button>");
    expect(open).toContain(">Keep</button>");
    expect(open).toContain(">Dismiss</button>");
    expect(open).toContain(">Think tonight</button>");
    expect(open).toContain(">Park</button>");
  });

  it("explains a spent budget on every thinking button and retains queued deferrals", () => {
    const studio: StudioView = { ...STUDIO, thinking: { kind: "ready", dailyRuns: { local: 0, cloud: 0 }, runs: [{ runUuid: "run-1", params: { thread: "one", mode: "red-team", requestId: "request-1" }, status: "queued", reason: "Deferred until tomorrow: the cloud daily run budget is spent", startedAt: null, policy: null }] } };
    const html = renderToStaticMarkup(<DeskStudio studio={studio} thread="one" onOpenThread={() => {}} at={AT} />);
    expect(html).toContain("Red team · budget spent");
    expect(html).toContain("Think now · budget spent");
    expect(html).toContain("Pending: red team");
    expect(html).toContain("Deferred until tomorrow");
    expect(html).toContain("What would A skeptic say?");
  });

  it("asks for a response while Ivy waits, and not after one", () => {
    const waiting = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread="one" onOpenThread={() => {}} at={AT} />);
    expect(waiting).toContain("Send my response");
    const answered: StudioView = { ...STUDIO, active: [thread("one", 1, { notes: STUDIO.active[0]?.notes ?? [], responses: [{ at: "2026-10-31T08:00:00+01:00", text: "Yes." }] }), thread("two", 2)] };
    const html = renderToStaticMarkup(<DeskStudio studio={answered} thread="one" onOpenThread={() => {}} at={AT} />);
    expect(html).not.toContain("Send my response");
    expect(html).toContain("You answered");
  });

  it("shows Ivy's proposed relation with Keep and Dismiss in Relates to", () => {
    const rel = { at: "2026-10-31T05:00:00+01:00", trigger: "Shared theme", model: "cloud", kind: "relation" as const, status: "open" as const, sample: false, relates: { kind: "goal", label: "G5: one post a week" }, text: "It feeds the weekly post." };
    const studio: StudioView = { ...STUDIO, active: [thread("one", 1, { notes: [rel] }), thread("two", 2)] };
    const html = renderToStaticMarkup(<DeskStudio studio={studio} thread="one" onOpenThread={() => {}} at={AT} />);
    expect(html).toContain("Ivy proposes</h5>");
    expect(html).toContain("goal: G5: one post a week");
    expect(html).toContain("It feeds the weekly post.");
  });

  it("offers to open a capture and to bring a parked thread back", () => {
    const html = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread={null} onOpenThread={() => {}} at={AT} />);
    expect(html).toContain(">Make it a thread</button>");
    expect(html).toContain(">Bring back</button>");
  });

  it("says when the open thread is not in the Studio", () => {
    const open = renderToStaticMarkup(<DeskStudio studio={STUDIO} thread="gone" onOpenThread={() => {}} at={AT} />);
    expect(open).toContain("This thread is not in the Studio.");
  });
});

describe("the open sheet", () => {
  const acts = { pending: false, note: null, send: async () => ({ ok: true, text: "" }) };
  const capture = { kind: "open" as const, from: "capture" as const, id: "idea", question: "An idea", area: "lab", reason: "It matches no thread." };

  it("prefills the area and reason and shows where the Yes-filter comes from", () => {
    const html = renderToStaticMarkup(<OpenSheet request={capture} studio={STUDIO} acts={acts} onDone={() => {}} />);
    expect(html).toContain("Placed under Lab: It matches no thread.");
    expect(html).toContain("Is this mine to do?");
    expect(html).toContain("This is the default set.");
    expect(html).toContain("What will I stop doing for it?</span><input");
    expect(html).not.toContain("Choose a thread to park");
    expect(html).toContain(">Open the thread</button>");
  });

  it("names the config when the filter comes from it", () => {
    const own: StudioView = { ...STUDIO, yesFilter: { questions: ["Is it a whole Yes?"], fromConfig: true } };
    const html = renderToStaticMarkup(<OpenSheet request={capture} studio={own} acts={acts} onDone={() => {}} />);
    expect(html).toContain("Is it a whole Yes?");
    expect(html).toContain("come from your settings");
  });

  it("requires a thread to park when every place is in use", () => {
    const full: StudioView = { ...STUDIO, maxActive: 2 };
    const html = renderToStaticMarkup(<OpenSheet request={capture} studio={full} acts={acts} onDone={() => {}} />);
    expect(html).toContain("All 2 places are in use");
    expect(html).toContain("Pick the thread to park below.");
    expect(html).toContain('role="radio" aria-checked="false">What about one?');
    expect(html).toMatch(/disabled="" aria-busy="false">Choose one to park first</);
  });
});

describe("the request id", () => {
  it("reuses the id only for a retry of the same uncertain act", () => {
    let n = 0;
    const make = () => `id-${++n}`;
    expect(requestIdFor({ key: "a", id: "kept-id" }, "a", make)).toBe("kept-id");
    expect(requestIdFor({ key: "a", id: "kept-id" }, "b", make)).toBe("id-1");
    expect(requestIdFor(null, "a", make)).toBe("id-2");
  });
});

describe("the Desk view switch", () => {
  it("shows Day Catch-up Balance and Studio with the current view selected", () => {
    const html = renderToStaticMarkup(<DeskModeSwitch hasStudio inStudio onGo={() => {}} />);
    expect([...html.matchAll(/aria-selected="(true|false)">([^<]+)</g)].map((m) => [m[2], m[1]])).toEqual([["Day", "false"], ["Catch-up", "false"], ["Balance", "false"], ["Studio", "true"]]);
  });

  it("keeps Day and Balance reachable without a Studio", () => {
    const html = renderToStaticMarkup(<DeskModeSwitch hasStudio={false} inStudio={false} inBalance onGo={() => undefined} />);
    expect([...html.matchAll(/aria-selected="(true|false)">([^<]+)</g)].map(m => [m[2], m[1]])).toEqual([["Day", "false"], ["Catch-up", "false"], ["Balance", "true"]]);
    expect(html).not.toContain(">Studio</button>");
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


it("a recovered unanswered Studio turn can retry with an empty composer", () => {
  const controls: StudioSessionControls = {
    session: { id: "00000000-0000-4000-8000-000000000001", thread: "one", scope: { kind: "thread" }, original: "A paper glider?", stand: "Try it.", policy: "local", phase: { kind: "open" }, turns: [{ id: "00000000-0000-4000-8000-000000000002", text: "Try another fold.", answer: null, model: "local", policy: "local" }] },
    recoverable: [], remaining: false, chosen: null, retrying: false, resumeId: null, draft: "", reword: "", pending: false, error: null,
    setDraft: () => {}, setReword: () => {}, start: () => {}, send: async () => {}, end: async () => {}, load: async () => {}, saveRemaining: async () => {}, copyRemaining: async () => {},
  };
  const html = renderToStaticMarkup(<StudioSessionPanel controls={controls} voice={{ enabled: false, input: "browser", output: "browser" }} location="studio:one" />);
  expect(html).toContain('<button class="desk-btn pri">Retry saved turn</button>');
  expect(html).toContain("Retry saved turn sends the original saved text.");
});

it("keeps the response form available after Keep or Dismiss without changing the ambient badge", () => {
  const statuses: StudioThreadView["notes"][number]["status"][] = ["kept", "dismissed"];
  for (const status of statuses) {
    const notes: StudioThreadView["notes"] = [{ at: "2026-10-31T03:12:00.500Z", trigger: "A synthetic idea", model: "local", kind: "idea", status, sample: false, text: "Compare two wings." }];
    const subject = thread("owned", 1, { notes });
    const studio: StudioView = { ...STUDIO, active: [subject], parked: [] };
    expect(waitsOnYou(subject)).toBe(false);
    const html = renderToStaticMarkup(<DeskStudio studio={studio} thread="owned" onOpenThread={() => {}} at={AT} />);
    expect(html).toContain("Send my response");
    expect(html).not.toContain("Ivy waits on you: answer the note");
    const closed: StudioView = { ...studio, active: [], closed: [{ ...subject, state: "closed", outcome: "shipped" }] };
    expect(renderToStaticMarkup(<DeskStudio studio={closed} thread="owned" onOpenThread={() => {}} at={AT} />)).not.toContain("Send my response");
  }
});
it("clears the response form and badge for a validated same-second reply", () => {
  const notes: StudioThreadView["notes"] = [{ at: "2026-10-31T03:12:00.500Z", trigger: "A synthetic idea", model: "local", kind: "idea", status: "open", sample: false, text: "Compare two wings." }];
  const subject = thread("owned", 1, { notes, responses: [{ at: "2026-10-31T03:12:00Z", re: notes[0]?.at, text: "Use the small wing." }] });
  expect(waitsOnYou(subject)).toBe(false);
  const studio: StudioView = { ...STUDIO, active: [subject], parked: [] };
  const html = renderToStaticMarkup(<DeskStudio studio={studio} thread="owned" onOpenThread={() => {}} at={AT} />);
  expect(html).not.toContain("Send my response");
});
