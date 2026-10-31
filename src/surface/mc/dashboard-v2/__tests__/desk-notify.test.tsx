import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { enableNotifications, notifyIfNew, notifyState, wantsHint, dismissHint, type NotifyApi, type NotifyEnv } from "../lib/desk-notify";
import { NotifyHint } from "../components/desk-view";
import type { DeskItem, DeskView } from "../../desk/types";

const item = (n: number, interrupting: boolean): DeskItem => ({
  key: `reminder:desk:${n}`,
  kind: "reminder",
  source: "desk",
  area: null,
  urgency: "now",
  title: `Call the plumber ${n}.`,
  why: `It is due now (${n}).`,
  score: 100 - n,
  actions: [],
  detail: { summary: "s", history: [], refs: [], links: [] },
  ...(interrupting ? { interrupt: { delivery: "off" as const } } : {}),
});

const view = (items: DeskItem[], notifications = true): DeskView => ({
  generatedAt: 0,
  displayName: null,
  topN: 5,
  areas: [],
  items,
  today: [],
  ahead: [],
  vips: [],
  agents: { line: "", working: [], waiting: 0 },
  goals: [],
  notes: [],
  ask: { kinds: [], maps: [] },
  systems: [],
  sources: [],
  chime: false,
  notifications,
  autonomy: { types: [], done: [] },
  corrections: [],
});

interface Shown {
  title: string;
  options?: NotificationOptions;
  fire: () => void;
  closed: boolean;
}

function harness(permission: NotificationPermission, secure = true, answer: NotificationPermission = "granted") {
  const shown: Shown[] = [];
  const store = new Map<string, string>();
  let focused = 0;
  let asked = 0;
  const api = class {
    static permission = permission;
    static async requestPermission(): Promise<NotificationPermission> {
      asked += 1;
      api.permission = answer;
      return answer;
    }
    onclick: Notification["onclick"] = null;
    constructor(title: string, options?: NotificationOptions) {
      const entry: Shown = { title, options, fire: () => this.onclick?.call(this as unknown as Notification, new Event("click")), closed: false };
      shown.push(entry);
      this.close = () => {
        entry.closed = true;
      };
    }
    close: () => void = () => undefined;
  } satisfies NotifyApi;
  const env: NotifyEnv = {
    api,
    secure,
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
    focus: () => {
      focused += 1;
    },
  };
  return { env, shown, store, focused: () => focused, asked: () => asked };
}

describe("Desk browser notifications", () => {
  it("shows exactly one notification per new interrupting item, with title, reason and a stable tag", () => {
    const h = harness("granted");
    const opened: string[] = [];
    const v = view([item(1, true), item(2, false), item(3, true)]);
    expect(notifyIfNew(v, h.env, (k) => opened.push(k))).toEqual(["reminder:desk:1", "reminder:desk:3"]);
    expect(h.shown.map((s) => [s.title, s.options?.body, s.options?.tag])).toEqual([
      ["Call the plumber 1.", "It is due now (1).", "desk:reminder:desk:1"],
      ["Call the plumber 3.", "It is due now (3).", "desk:reminder:desk:3"],
    ]);
    expect(notifyIfNew(v, h.env, (k) => opened.push(k))).toEqual([]);
    expect(h.shown).toHaveLength(2);
  });

  it("focuses the Desk and opens the item when the notification is clicked", () => {
    const h = harness("granted");
    const opened: string[] = [];
    notifyIfNew(view([item(1, true)]), h.env, (k) => opened.push(k));
    h.shown[0]?.fire();
    expect(h.focused()).toBe(1);
    expect(opened).toEqual(["reminder:desk:1"]);
    expect(h.shown[0]?.closed).toBe(true);
  });

  it("attempts nothing when permission is denied or default, the page is plain http, or config turns it off", () => {
    for (const [h, enabled] of [[harness("denied"), true], [harness("default"), true], [harness("granted", false), true], [harness("granted"), false]] as const) {
      expect(notifyIfNew(view([item(1, true)], enabled), h.env, () => undefined)).toEqual([]);
      expect(h.shown).toHaveLength(0);
      expect(h.store.size).toBe(0);
    }
  });

  it("keeps an item unseen when the browser refuses to construct the notification", () => {
    const h = harness("granted");
    const refusing = Object.assign(
      class {
        onclick: Notification["onclick"] = null;
        close(): void {}
        constructor() {
          throw new TypeError("Illegal constructor");
        }
      },
      { permission: "granted" as const, requestPermission: async () => "granted" as const },
    ) satisfies NotifyApi;
    expect(notifyIfNew(view([item(1, true)]), { ...h.env, api: refusing }, () => undefined)).toEqual([]);
    expect(h.store.size).toBe(0);
    expect(notifyIfNew(view([item(1, true)]), h.env, () => undefined)).toEqual(["reminder:desk:1"]);
  });

  it("names the state Settings explains", () => {
    expect(notifyState(false, harness("granted").env)).toBe("off");
    expect(notifyState(true, harness("granted", false).env)).toBe("insecure");
    expect(notifyState(true, { api: null, secure: true })).toBe("unsupported");
    expect(notifyState(true, harness("denied").env)).toBe("denied");
    expect(notifyState(true, null)).toBe("insecure");
  });

  it("asks for permission only from the click, and does not notify items already on the Desk at that moment", async () => {
    const h = harness("default");
    const v = view([item(1, true)]);
    notifyIfNew(v, h.env, () => undefined);
    expect(h.asked()).toBe(0);
    expect(await enableNotifications(v, h.env)).toBe("granted");
    expect(h.asked()).toBe(1);
    expect(notifyIfNew(v, h.env, () => undefined)).toEqual([]);
    expect(notifyIfNew(view([item(1, true), item(2, true)]), h.env, () => undefined)).toEqual(["reminder:desk:2"]);
  });

  it("does not ask again once the browser answered", async () => {
    const h = harness("denied");
    expect(await enableNotifications(view([]), h.env)).toBe("denied");
    expect(h.asked()).toBe(0);
  });

  it("offers the Desk hint once, while permission is still to be asked", () => {
    const h = harness("default");
    expect(wantsHint(true, h.env)).toBe(true);
    expect(wantsHint(false, h.env)).toBe(false);
    expect(wantsHint(true, harness("granted").env)).toBe(false);
    expect(wantsHint(true, null)).toBe(false);
    dismissHint(h.env);
    expect(wantsHint(true, h.env)).toBe(false);
    const html = renderToStaticMarkup(<NotifyHint onEnable={() => undefined} onDismiss={() => undefined} />);
    expect(html).toContain(">Turn on notifications</button>");
    expect(html).toContain(">Not now</button>");
  });
});
