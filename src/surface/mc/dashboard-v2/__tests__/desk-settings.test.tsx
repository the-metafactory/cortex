import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsBody } from "../components/desk-settings";
import { changeSenders, changeVips, type SenderRow } from "../lib/desk-settings";
import { NOTIFY_LINE, type NotifyState } from "../lib/desk-notify";

const noop = (): void => {};
const added = async (): Promise<boolean> => true;
const list = (rows: SenderRow[] | null, note: string | null = null) => ({ rows, note, onAdd: added, onRemove: noop });
const none = list([]);

describe("the Desk settings page", () => {
  it("labels six vertical tabs and their retained panels while selecting only one page", () => {
    const html = renderToStaticMarkup(<SettingsBody group="vips" vips={none} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain('role="tablist" aria-label="Settings groups" aria-orientation="vertical"');
    expect(html).toContain('aria-selected="true" aria-controls="settings-panel-vips" tabindex="0"');
    expect(html).toContain('id="settings-panel-calendars" role="tabpanel" aria-labelledby="settings-tab-calendars" hidden=""');
    expect(html.match(/role="tab"/g)).toHaveLength(6);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(6);
    expect(html.match(/ hidden=""/g)).toHaveLength(5);
  });
  it("lists the VIPs with a way to remove each and to add one", () => {
    const html = renderToStaticMarkup(
      <SettingsBody vips={list([{ address: "ada@example.org", label: "Ada" }, { address: "@example.ch", label: null }])} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />,
    );
    expect(html).toContain("<h1 class=\"desk-set-h\">Settings</h1>");
    expect(html).toContain("<h2>VIPs</h2>");
    expect(html).toContain("Ada<small>ada@example.org</small>");
    expect(html).toContain("@example.ch");
    expect(html).toContain('aria-label="Remove ada@example.org"');
    expect(html).toContain('aria-label="Remove @example.ch"');
    expect(html).toContain('aria-label="Add a VIP"');
    expect(html).toContain("Back to the Desk");
  });

  it("says how to add the first VIP when there are none", () => {
    const html = renderToStaticMarkup(<SettingsBody vips={list([])} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain("No VIPs yet.");
    expect(html).not.toContain("Remove ");
  });

  it("shows why a change failed", () => {
    const html = renderToStaticMarkup(<SettingsBody vips={list([], "address must be an email address")} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain('role="alert">address must be an email address</p>');
  });

  it("offers to turn notifications on only while the browser has not been asked", () => {
    const body = (notify: NotifyState): string => renderToStaticMarkup(<SettingsBody vips={list([])} unimportant={none} busy={false} onBack={noop} notify={notify} onEnableNotify={noop} />);
    expect(body("default")).toContain(">Turn on notifications</button>");
    for (const state of ["granted", "denied", "insecure", "off", "unsupported"] as const) {
      expect(body(state)).not.toContain(">Turn on notifications</button>");
      expect(body(state)).toContain(NOTIFY_LINE[state]);
    }
    expect(body("insecure")).toContain("plain http");
    expect(body("denied")).toContain("blocks notifications");
  });

  it("shows the load error in place of the list when the VIPs could not be read", () => {
    const html = renderToStaticMarkup(<SettingsBody vips={list(null, "Mission Control did not answer: offline")} unimportant={none} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />);
    expect(html).toContain("Mission Control did not answer: offline");
    expect(html).not.toContain('aria-label="Add a VIP"');
  });
});

describe("the unimportant senders on the settings page", () => {
  it("lists them with a way to remove each and to add one, next to the VIPs", () => {
    const html = renderToStaticMarkup(
      <SettingsBody vips={none} unimportant={list([{ address: "gitlab@gitlab.example", label: "GitLab" }])} busy={false} onBack={noop} notify="granted" onEnableNotify={noop} />,
    );
    expect(html).toContain("<h2>Unimportant senders</h2>");
    expect(html).toContain("GitLab<small>gitlab@gitlab.example</small>");
    expect(html).toContain('aria-label="Remove gitlab@gitlab.example"');
    expect(html).toContain('aria-label="Add an unimportant sender"');
    expect(html).toContain("No VIPs yet.");
  });

  it("changes the list through its own route", async () => {
    const seen: string[] = [];
    const fake = async (path: string, init: RequestInit) => {
      seen.push(`${init.method} ${path}`);
      return Response.json({ unimportant: [] });
    };
    expect(await changeSenders("unimportant", { op: "remove", address: "@gitlab.example" }, fake)).toEqual({ ok: true, rows: [] });
    expect(seen).toEqual(["DELETE /api/desk/unimportant?address=%40gitlab.example"]);
  });
});

describe("changeVips", () => {
  const seen: { path: string; method: string | undefined; body: unknown }[] = [];
  const answering = (status: number, reply: unknown) => async (path: string, init: RequestInit) => {
    seen.push({ path, method: init.method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(reply), { status });
  };

  it("adds, removes and lists through the VIP API and returns the stored list", async () => {
    seen.length = 0;
    const list = { vips: [{ address: "ada@example.org", label: null }] };
    expect(await changeVips({ op: "add", address: "Ada@example.org" }, answering(200, list))).toEqual({ ok: true, rows: list.vips });
    expect(await changeVips({ op: "remove", address: "@example.ch" }, answering(200, { vips: [] }))).toEqual({ ok: true, rows: [] });
    expect(await changeVips({ op: "list" }, answering(200, list))).toEqual({ ok: true, rows: list.vips });
    expect(seen).toEqual([
      { path: "/api/desk/vips", method: "POST", body: { address: "Ada@example.org", label: null } },
      { path: "/api/desk/vips?address=%40example.ch", method: "DELETE", body: null },
      { path: "/api/desk/vips", method: "GET", body: null },
    ]);
  });

  it("returns the server's reason, or one line, when a change fails", async () => {
    expect(await changeVips({ op: "add", address: "nope" }, answering(400, { error: "address must be an email address or a domain such as @example.ch" })))
      .toEqual({ ok: false, text: "address must be an email address or a domain such as @example.ch" });
    expect(await changeVips({ op: "remove", address: "x@y.ch" }, answering(500, null))).toEqual({ ok: false, text: "Mission Control answered HTTP 500." });
    expect(await changeVips({ op: "list" }, async () => { throw new Error("offline"); })).toEqual({ ok: false, text: "Mission Control did not answer: offline" });
  });
});
