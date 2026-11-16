import { describe, expect, it } from "bun:test";
import fixture from "./__fixtures__/desk-parser-prompts.json";
import { parseWithCommand, type ParserRequest } from "../desk/ask";
import { PARSER_SYSTEM, buildPrompt, parserMessages, type ParserPromptRequest } from "../desk/parser-prompt";

const cases = Object.entries(fixture) as [string, { request: ParserPromptRequest; prompt: string }][];

describe("the parser prompt", () => {
  for (const [name, { request, prompt }] of cases) {
    it(`equals the adapter's prompt for ${name}`, () => {
      expect(buildPrompt(request)).toBe(prompt);
    });
  }

  it("sends a system and a user message with each parse", async () => {
    const request: ParserRequest = { ...fixture.create.request, kinds: ["reminder", "note"], maps: [] };
    let stdin = "";
    await parseWithCommand(["p"], request, async (_argv, input) => ((stdin = input), "null"), 1000);
    const sent = JSON.parse(stdin);
    expect(sent.text).toBe(request.text);
    expect(sent.messages).toEqual([
      { role: "system", content: PARSER_SYSTEM },
      { role: "user", content: buildPrompt(request) },
    ]);
  });

  it("uses the parent prompt for a balance-parent request", () => {
    const { request, prompt } = fixture.parent;
    const messages = parserMessages(request as ParserPromptRequest);
    expect(messages[1]).toEqual({ role: "user", content: prompt });
  });
});
