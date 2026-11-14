import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelPicker } from "../components/desk-conversation";
import { entryViews, type ConversationDetail } from "../lib/conversations";

const codex = { id: "codex", provider: "openai-codex", model: "gpt-test" };
const claude = { id: "claude", provider: "anthropic", model: "claude-test" };
const render = (models: ConversationDetail["models"]): string => renderToStaticMarkup(<ModelPicker models={models} disabled={false} onChoose={() => undefined} />);

describe("the conversation's cloud model", () => {
  it("offers a choice between several cloud models, with the first as the default", () => {
    const html = render({ cloud: [codex, claude], chosen: null, using: "codex" });
    expect(html).toContain("<select");
    expect(html).toContain("Default · openai-codex/gpt-test");
    expect(html).toContain("claude · anthropic/claude-test");
    expect(html).not.toContain("role=\"alert\"");
  });

  it("names the single cloud model without a choice", () => {
    const html = render({ cloud: [codex], chosen: null, using: "codex" });
    expect(html).not.toContain("<select");
    expect(html).toContain("Cloud model openai-codex/gpt-test");
  });

  it("says when the chosen model is no longer configured instead of switching", () => {
    const html = render({ cloud: [codex], chosen: "claude", using: null });
    expect(html).toContain("<select");
    expect(html).toContain("Default · openai-codex/gpt-test");
    expect(html).toContain("claude · no longer configured");
    expect(html).toContain("no other model is used");
  });

  it("shows which model answered a turn and which one failed", () => {
    expect(entryViews({ id: "1", kind: "message", role: "assistant", text: "hi", model: "anthropic/claude-test" })).toEqual([{ kind: "message", who: "ivy", text: "hi", note: "anthropic/claude-test" }]);
    expect(entryViews({ id: "2", kind: "message", role: "assistant", error: "not signed in", model: "anthropic/claude-test" })).toEqual([{ kind: "failure", text: "No answer on anthropic/claude-test: not signed in" }]);
  });
});
