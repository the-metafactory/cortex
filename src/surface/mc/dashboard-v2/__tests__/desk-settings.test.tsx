import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsBody } from "../components/desk-settings";
import { changeVips } from "../lib/desk-settings";

const noop = (): void => {};
const added = async (): Promise<boolean> => true;

describe("the Desk settings page", () => {
  it("lists the VIPs with a way to remove each and to add one", () => {
    const html = renderToStaticMarkup(
      <SettingsBody vips={[{ address: "ada@example.org", label: "Ada" }, { address: "@example.ch", label: null }]} note={null} busy={false} onBack={noop} onAdd={added} onRemove={noop} />,
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
    const html = renderToStaticMarkup(<SettingsBody vips={[]} note={null} busy={false} onBack={noop} onAdd={added} onRemove={noop} />);
    expect(html).toContain("No VIPs yet.");
    expect(html).not.toContain("Remove ");
  });

  it("shows why a change failed", () => {
    const html = renderToStaticMarkup(<SettingsBody vips={[]} note="address must be an email address" busy={false} onBack={noop} onAdd={added} onRemove={noop} />);
    expect(html).toContain('role="alert">address must be an email address</p>');
  });

  it("shows the load error in place of the list when the VIPs could not be read", () => {
    const html = renderToStaticMarkup(<SettingsBody vips={null} note="Mission Control did not answer: offline" busy={false} onBack={noop} onAdd={added} onRemove={noop} />);
    expect(html).toContain("Mission Control did not answer: offline");
    expect(html).not.toContain('aria-label="Add a VIP"');
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
    expect(await changeVips({ op: "add", address: "Ada@example.org" }, answering(200, list))).toEqual({ ok: true, vips: list.vips });
    expect(await changeVips({ op: "remove", address: "@example.ch" }, answering(200, { vips: [] }))).toEqual({ ok: true, vips: [] });
    expect(await changeVips({ op: "list" }, answering(200, list))).toEqual({ ok: true, vips: list.vips });
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
