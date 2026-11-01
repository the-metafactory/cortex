import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailSweeps, previewLabel, SweepPreview, sweepsInArea } from "../components/desk-mail-sweeps";
import { submitMailAction } from "../lib/desk-action";
import type { MailSweepView } from "../../desk/mail-sweep";

const BUNDLE: MailSweepView = {
  id: "bundle:archive:abc", kind: "bundle", basis: "similar", target: "archive", label: "similar content", title: "4 mails like “Weekly ITIL statistics”: archive all?",
  why: "Archived like 3 similar mails from OTRS.", area: "work",
  mails: ["a", "b", "c", "d"].map((id) => ({ key: `mail:${id}`, subject: `Statistics ${id}`, from: "OTRS", at: "2026-11-01T08:00:00.000Z" })),
};

describe("bundles and sweeps on the stream", () => {
  it("shows the count, what was learned, three mails and the preview button", () => {
    const html = renderToStaticMarkup(<MailSweeps sweeps={[BUNDLE]} onPreview={() => {}} />);
    expect(html).toContain("4 like these");
    expect(html).toContain("<b>Learned </b>Archived like 3 similar mails from OTRS.");
    expect(html).toContain("OTRS: Statistics c");
    expect(html).not.toContain("OTRS: Statistics d");
    expect(html).toContain("and 1 more");
    expect(html).toContain(">Preview and archive 4<");
    expect(previewLabel({ ...BUNDLE, target: "junk" }, 2)).toBe("Preview and move to Spam 2");
  });

  it("filters by area and keeps cross-area groups", () => {
    expect(sweepsInArea([BUNDLE, { ...BUNDLE, id: "x", area: null }], "home").map((s) => s.id)).toEqual(["x"]);
    expect(sweepsInArea([BUNDLE], "all")).toHaveLength(1);
  });

  it("previews every mail ticked, with one confirm button", () => {
    const html = renderToStaticMarkup(<SweepPreview sweep={BUNDLE} busy={false} onConfirm={() => {}} onCancel={() => {}} />);
    expect(html.match(/type="checkbox" checked=""/g)).toHaveLength(4);
    expect(html).toContain(">Archive 4<");
    expect(html).toContain("Each one is logged as an archive decision.");
  });

  it("posts the sweep with exactly the ticked keys, and the Undo for the whole sweep", async () => {
    const calls: unknown[] = [];
    const fake = async (_path: string, init: RequestInit): Promise<Response> => {
      calls.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true, message: "Archived 3 mails." });
    };
    expect(await submitMailAction({ action: "sweep", sweep: BUNDLE.id, keys: ["mail:a", "mail:c", "mail:d"] }, fake)).toMatchObject({ ok: true, text: "Archived 3 mails." });
    await submitMailAction({ action: "sweep.undo", sweep: "s1" }, fake);
    expect(calls).toEqual([{ action: "sweep", sweep: BUNDLE.id, keys: ["mail:a", "mail:c", "mail:d"] }, { action: "sweep.undo", sweep: "s1" }]);
  });
});
