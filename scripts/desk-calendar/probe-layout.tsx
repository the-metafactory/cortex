import { chromium } from "playwright";
import { renderToStaticMarkup } from "react-dom/server";
import { AheadStrip } from "../../src/surface/mc/dashboard-v2/components/desk-view";
import type { DeskEvent } from "../../src/surface/mc/desk/types";

const title = "CalendarTitleWithoutBreaks".repeat(12);
const events: DeskEvent[] = Array.from({ length: 4 }, (_, index) => ({
  key: `layout-${index}`,
  at: Date.UTC(2026, 10, 2 + index, 12),
  title,
  area: null,
  kind: index % 2 === 0 ? "meeting" : "all-day",
  ...(index % 2 === 0 ? { color: "#123456" } : {}),
}));
const css = await Bun.file(new URL("../../src/surface/mc/dashboard-v2/components/desk-view.css", import.meta.url)).text();
const markup = renderToStaticMarkup(<AheadStrip events={events} />);
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    await page.setContent(`<style>body{margin:0}${css}</style><div class="desk"><main style="padding:0 40px">${markup}</main></div>`);
    const result = await page.evaluate(() => {
      const titles = [...document.querySelectorAll(".desk-day .ttl")];
      return {
        width: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        days: document.querySelectorAll(".desk-day").length,
        contained: titles.every(element => {
          const parent = element.parentElement;
          if (!parent) return false;
          const bounds = parent.getBoundingClientRect();
          return [...element.getClientRects()].every(rect => rect.left >= bounds.left && rect.right <= bounds.right + 1);
        }),
        titles: titles.map(element => element.textContent),
      };
    });
    const passed = result.scrollWidth === result.width && result.days === 4 && result.contained && result.titles.every(value => value === title);
    console.log(JSON.stringify({ width, scrollWidth: result.scrollWidth, days: result.days, contained: result.contained, passed }));
    await page.close();
    if (!passed) throw new Error(`Calendar titles overflow at ${width}px`);
  }
} finally {
  await browser.close();
}
