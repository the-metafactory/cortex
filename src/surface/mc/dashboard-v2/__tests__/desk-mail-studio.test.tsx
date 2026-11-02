import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MailStudioBox, newStudioPick, studioBody, withProposal } from "../components/desk-mail-studio";
import { fetchMailThreadProposal } from "../lib/desk-action";

const PROPOSAL = { thread: "engines", reason: "It is about engines.", threads: [{ slug: "engines", question: "What can engines make?" }, { slug: "home", question: "How do we live?" }], canIncludeText: true };
const noop = (): void => undefined;

describe("Add to thread picker", () => {
  it("preselects the proposal, shows its reason and offers the Studio inbox", () => {
    const pick = withProposal(newStudioPick("mail:w1"), PROPOSAL);
    const html = renderToStaticMarkup(<MailStudioBox pick={pick} sending={false} onChoose={noop} onIncludeText={noop} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain("Suggested: “What can engines make?”. It is about engines.");
    expect(html).toContain("Studio inbox");
    expect(html).toContain("Include the text");
    expect(html).toMatch(/<option value="engines" selected="">/);
  });

  it("sends the filer's reason only when the principal kept its thread", () => {
    const pick = withProposal(newStudioPick("mail:w1"), PROPOSAL);
    expect(studioBody(pick)).toMatchObject({ action: "studio.add", key: "mail:w1", thread: "engines", reason: "It is about engines.", includeText: false });
    expect(studioBody({ ...pick, thread: null, includeText: true })).toEqual({ action: "studio.add", key: "mail:w1", requestId: pick.requestId, thread: null, includeText: true });
  });

  it("returns the server's refusal as a line", async () => {
    const fake = async (): Promise<Response> => Response.json({ ok: false, error: "The Studio is not set up on this stack." }, { status: 409 });
    expect(await fetchMailThreadProposal("mail:w1", fake)).toEqual({ ok: false, text: "The Studio is not set up on this stack." });
  });
});
