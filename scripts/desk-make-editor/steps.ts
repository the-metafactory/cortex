import type { Locator, Page } from "playwright";
import type { DraftEditorView } from "../../src/surface/mc/desk/draft-editor-contract";

const isMake = (response: { request(): { method(): string }; url(): string }): boolean => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/desk/drafts";

export async function openMakeEditor(page: Page, conversation: string, discussion: string) {
  await page.getByRole("region", { name: `Ivy conversation: ${conversation}`, exact: true }).waitFor();
  await page.getByText(discussion, { exact: true }).waitFor();
  const making = page.waitForResponse(isMake);
  await page.getByRole("button", { name: "Make", exact: true }).click();
  return { making, editor: page.getByRole("article", { name: "Draft editor", exact: true }) };
}

export function revisionSteps(page: Page, editor: Locator) {
  const revision = async () => Number(await editor.getAttribute("data-revision"));
  return {
    revision,
    async changed(before: number) { await page.waitForFunction(value => Number(document.querySelector('[aria-label="Draft editor"]')?.getAttribute("data-revision")) > value, before); },
    async press(name: string) {
      const before = await revision();
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(value => Number(document.querySelector('[aria-label="Draft editor"]')?.getAttribute("data-revision")) > value, before);
    },
  };
}

export async function reopenOutdatedDraft(page: Page): Promise<void> {
  const reopening = page.waitForResponse(response => response.request().method() === "GET" && /\/api\/desk\/drafts\/[^/]+$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "Reopen draft", exact: true }).click();
  await (await reopening).finished();
  await page.getByText(/Review needed: conversation-changed/).waitFor();
}

export async function restartAndRemake(page: Page, rig: { reopen(): Promise<void> }, title: Locator): Promise<DraftEditorView> {
  await rig.reopen();
  await page.reload();
  const remaking = page.waitForResponse(isMake);
  await page.getByRole("button", { name: "Make", exact: true }).click();
  await title.waitFor();
  return await (await remaking).json() as DraftEditorView;
}

export async function denyRelease(page: Page, rig: { state: { localOnly: boolean } }): Promise<void> {
  rig.state.localOnly = true;
  await page.getByRole("button", { name: "Refresh draft", exact: true }).click();
  await page.getByText("No permitted model is available; the manual draft is unchanged.").waitFor();
  await page.getByRole("button", { name: "Confirm draft" }).click();
  await page.getByText("Policy withholds draft fields in this context. Open the draft in a permitted context before confirming.").waitFor();
}
