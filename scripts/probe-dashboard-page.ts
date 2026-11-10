import type { Browser, Page } from "playwright";

export interface DashboardProbe { readonly page: Page; readonly load: () => Promise<void> }

export async function openDashboardProbe(browser: Browser, url: URL): Promise<DashboardProbe> {
  const page = await browser.newPage();
  page.on("pageerror", error => { throw error; });
  const load = async (): Promise<void> => { await page.goto(url.toString()); await page.waitForSelector("body[data-mounted]", { state: "attached" }); };
  return { page, load };
}
