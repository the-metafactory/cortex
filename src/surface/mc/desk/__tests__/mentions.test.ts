import { describe, expect, it } from "bun:test";
import type { GraphRepoRef } from "../../../../common/graph-ref";
import { itemMentions, mentionRepositories, withMentions } from "../mentions";
import type { DeskItem } from "../types";

const APP: GraphRepoRef = { forge: "github", host: "github.com", path: "example/app" };
const MAIL: GraphRepoRef = { forge: "github", host: "github.com", path: "example/mail" };
const LAB: GraphRepoRef = { forge: "gitlab", host: "forge.example.test:8443", path: "group/nested/widget" };
const item = (overrides: Partial<DeskItem> = {}): DeskItem => ({
  key: "ranger:example/app#10", kind: "agent-blocked", source: "ranger", area: null, urgency: "waiting",
  title: "Waiting", why: "Needs a decision", score: 65, actions: [],
  detail: { summary: "Blocked", refs: ["example/app#10"], history: [], links: [] }, ...overrides,
});

describe("Desk item mentions", () => {
  it("preserves exact substrings for full, short, bare and node forms", () => {
    expect(itemMentions(item({ title: "PR other/exporter#12 needs mail#11, #14, node 3475 and node #3476; Node  #3477." }), [APP, MAIL])).toEqual([
      { text: "other/exporter#12", url: "https://github.com/other/exporter/issues/12" },
      { text: "mail#11", url: "https://github.com/example/mail/issues/11" },
      { text: "#14", url: "https://github.com/example/app/issues/14" },
      { text: "node 3475", url: "https://github.com/example/app/issues/3475" },
      { text: "node #3476", url: "https://github.com/example/app/issues/3476" },
      { text: "Node  #3477", url: "https://github.com/example/app/issues/3477" },
    ]);
  });

  it("leaves capitalized Node runtime versions plain and accepts explicit node references", () => {
    expect(itemMentions(item({ title: "CI fails on Node 18, Node 20.19.0, NODE 22 LTS and Node.js 24." }), [APP])).toEqual([]);
    expect(itemMentions(item({ title: "Compare node 18, node #20, Node #22 and NODE #24." }), [APP])).toEqual([
      { text: "node 18", url: "https://github.com/example/app/issues/18" },
      { text: "node #20", url: "https://github.com/example/app/issues/20" },
      { text: "Node #22", url: "https://github.com/example/app/issues/22" },
      { text: "NODE #24", url: "https://github.com/example/app/issues/24" },
    ]);
  });

  it("reads every published text field and choice, deduplicating identical mentions", () => {
    const row = item({ title: "mail#1", why: "mail#2", detail: { summary: "mail#3", refs: [], history: ["mail#90"], links: [] },
      question: { condition: "mail#91", reason: "mail#4" },
      explanation: { sentence: "mail#5", choices: [{ label: "mail#6", consequence: "mail#7 mail#1", ruling: "mail#92" }] },
    });
    expect(itemMentions(row, [MAIL])).toEqual([1, 2, 3, 4, 5, 6, 7].map(n => ({ text: `mail#${n}`, url: `https://github.com/example/mail/issues/${n}` })));
  });

  it("omits unknown and ambiguous short names without falling back to local references", () => {
    expect(itemMentions(item({ title: "missing#11 mail#12" }), [MAIL, { ...MAIL, path: "other/mail" }])).toEqual([]);
    expect(itemMentions(item({ title: "mail#12 example/mail#13" }), [MAIL, { ...MAIL, host: "github.example.test" }])).toEqual([]);
    expect(itemMentions(item({ title: "MAIL#12" }), [MAIL, MAIL])).toEqual([{ text: "MAIL#12", url: "https://github.com/example/mail/issues/12" }]);
  });

  it("uses GitLab and GitHub enterprise hosts from known repositories and the item's own ref", () => {
    const enterprise = { ...APP, host: "github.example.test" };
    const row = item({ title: "widget#5 group/nested/widget#6 #7 node 8 node #9", detail: { summary: "", refs: ["gitlab:forge.example.test:8443/group/nested/widget#10"], history: [], links: [] } });
    expect(itemMentions(row, [LAB])).toEqual(["widget#5", "group/nested/widget#6", "#7", "node 8", "node #9"].map((text, i) => ({ text, url: `https://forge.example.test:8443/group/nested/widget/-/issues/${i + 5}` })));
    expect(itemMentions(item({ title: "app#4 example/app#5", detail: { summary: "", refs: [], history: [], links: [] } }), [enterprise])).toEqual([
      { text: "app#4", url: "https://github.example.test/example/app/issues/4" },
      { text: "example/app#5", url: "https://github.example.test/example/app/issues/5" },
    ]);
  });

  it("requires an item's own repository for local references and never infers it from its area", () => {
    const row = item({ area: "work", title: "#1 node 2 node #3 mail#4", detail: { summary: "", refs: ["outline-row"], history: [], links: [] } });
    expect(itemMentions(row, [APP, MAIL])).toEqual([{ text: "mail#4", url: "https://github.com/example/mail/issues/4" }]);
    expect(itemMentions(item({ title: "#5", detail: { summary: "", refs: ["github:github.com/example/app#10"], history: [], links: [] } }), [])).toEqual([{ text: "#5", url: "https://github.com/example/app/issues/5" }]);
  });

  it("does not extract partial references from URLs, paths, malformed tokens or unsafe repository values", () => {
    const row = item({ title: "https://evil.test/mail#1 /mail#2 x/mail#3 other/path/mail#4 mail#0 #01 #12abc node 0 #9007199254740992" });
    expect(itemMentions(row, [MAIL])).toEqual([{ text: "x/mail#3", url: "https://github.com/x/mail/issues/3" }]);
    for (const host of ["https://evil.test", "user@evil.test", "evil.test/path", "forge.example.test:99999"]) {
      expect(itemMentions(item({ title: "widget#1" }), [{ ...LAB, host }])).toEqual([]);
    }
    expect(itemMentions(item({ title: "widget#1" }), [{ ...LAB, path: "group/../widget" }])).toEqual([]);
  });

  it("excludes mail content and adds only the optional array of text and url", () => {
    const row = item({ title: "mail#1" });
    expect(withMentions(row, [MAIL])).toEqual({ ...row, mentions: [{ text: "mail#1", url: "https://github.com/example/mail/issues/1" }] });
    const plain = item();
    expect(withMentions(plain, [MAIL])).toBe(plain);
    expect(withMentions(plain, [MAIL])).not.toHaveProperty("mentions");
    for (const kind of ["mail", "mail-rule", "mail-waiting", "mail-handoff", "dmarc"] as const) expect(withMentions({ ...row, kind }, [MAIL])).toEqual({ ...row, kind });
  });

  it("collects repository identities from areas, conversation projects and all Ranger entries", () => {
    expect(mentionRepositories([{ repos: ["example/app", "example/", "github:github.com/example/app"] }], [
      { forge: { kind: "github", repo: "example/mail" } }, { forge: { kind: "gitlab", host: LAB.host, repo: LAB.path } }, {},
    ], { maps: [{ key: "map", repo: "example/map" }], current: [{ repo: "example/current", nodeId: "1", title: "", status: "running" }], needsYou: [{ key: "node", repo: "example/blocked", nodeId: "2", title: "", status: "blocked" }] })).toEqual([
      APP, MAIL, LAB, { ...APP, path: "example/map" }, { ...APP, path: "example/blocked" }, { ...APP, path: "example/current" },
    ]);
  });
});
