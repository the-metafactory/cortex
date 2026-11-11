# One Studio prototype

**Question:** the Desk is promising but too complicated for everyday use, and hardest for people who did not grow up with it. What would one screen look like that a newcomer can use on the first day and an expert does not outgrow?

**Answer from this prototype:** one screen with a low floor and a high ceiling. The first view is an input, a list of what needs you now, and the day. Everything else opens on the item it belongs to. The screen replaces the Day priorities, the Studio tab, the Balance tab and the Routines page.

Throwaway design work. Nothing here is wired to Cortex, and nothing here belongs in `src/`.

## Open it

Open `index.html` in a browser. It needs no server and no build. It loads two fonts from Google Fonts and falls back to system fonts without a network.

All data is synthetic. The personas are placeholders, not real people. The adapter names `desk-ics` and `desk-imap` are the example adapters from the Desk docs; "notes folder" is invented.

## Tabs

| Tab | What it shows |
| --- | --- |
| Overview | Four personas, the findings about today's Desk, the vocabulary, and the decisions. |
| One Studio | The current direction. Use the prototype clock at the top right to see the stream at three times of day. |
| Kim, Luca, Sam | The persona screens that led to One Studio. Kept as history. |
| Two options | A depth setting per person against one Studio for everyone. One Studio won. |

## What to try on the One Studio tab

- Answer Ivy's suggestion on the first question with "Yes, that is where I stand" or "Not quite".
- Open "Three invoices are late", flag a source, pick a call, and press "Challenge my call first".
- Type `ask the head teacher for an example` into the input. Ivy offers to add it to an existing question.
- Type `every Friday list the open offers`. Ivy offers to make it a routine.
- Press "Plan it today" on an item, then "Later" on its chip in the day calendar.
- Set the clock to 13:50 for the card before a meeting, and to 15:35 for the card after it.
- Switch to Everything, open an area, open a row, add a row, and move a row with the handle at its left.
- Switch to Handed over and open a routine.
- Open the weekly review from the stream or from the link at the bottom.

## Findings about today's Desk

| Code | Finding |
| --- | --- |
| F1 | The Studio surface names about twenty concepts before the first use. |
| F2 | The board spends the screen on places, columns and lines, not on what needs the person. |
| F3 | The thread page shows nine sections and about ten acts; most visits only react to the latest note. |
| F4 | Opening a thread is the heaviest moment, where capture should be cheapest. |
| F5 | The Studio is a separate mode, although a question usually starts on a Desk item. |
| F6 | Withdrawn. The local or cloud badge is fine as an advanced feature. Ivy's notes still show no sources. |
| F7 | A talked-through conversation is saved as one wall of text with raw Markdown. |
| F8 | The Day greeting is one long paragraph, and its count disagrees with the Catch-up panel. |
| F9 | A list of unrelated mail deletions hangs under the Studio board. |

## Decisions

| Code | Decision |
| --- | --- |
| D1 | The Yes questions are optional. They never block writing a thought down. |
| D2 | The local or cloud badge stays as it is. It is an advanced feature. |
| D3 | Thinking opens on the Desk item it is about. |
| D4 | No cap on open threads. A Now list replaces the five places. |
| D5 | One Studio for everyone. No depth setting. |
| D6 | The simplest persona screen is dropped. Its Yes or Not quite reply and its reminder to check a decision moved into One Studio. |
| D7 | The Now list replaces Today's priorities. The Studio stops being a tab. The day and the week sit on the same screen. |
| D8 | The Everything view replaces the Balance tab. It is a drill-in, one level at a time, framed by its ancestors. |
| D9 | The Now page is a stream. New things come up at the top and leave when handled. |
| D10 | Meetings are entries like any other. They come up before they start, show what was kept last time, and carry a brief from Ivy that names each source by adapter. |
| D11 | Every row has someone who does it: you, an agent once, or a routine on a schedule. A flow is the steps and is called a recipe. |

## Vocabulary

| Today | One Studio |
| --- | --- |
| thread | question |
| place, cap | no cap; the Now list |
| parked, shelf | Also on your mind; Park behind More |
| stand proposal, Keep, Dismiss | Ivy suggests you stand here: Yes or Not quite |
| capture, inbox, proposal | one input; Ivy offers to add a thought to a question |
| close with an outcome | Your call, with Challenge my call first |
| decision journal | Decided today; reviews in the weekly review |
| Balance outline | Everything |
| Ranger agent, routine, flow | Handed over: agents, routines, recipes |

## Not in the prototype

- Keyboard shortcuts on the One Studio screen. The hint lists them; none is wired.
- Dragging a row was not tested in a browser. The handle menu uses the same move logic and was tested.
- Focus projects, rows one after another, and importance per row are buttons without behaviour.
- The schedule calendar, execution logs, step parameters and routine drafts of today's Routines page.
- Writing a planned item to a real calendar. "Plan it today" is a plan on the Desk only.
- Reading notes back through an adapter. The current contracts have sources for calendar and mail and a writer for notes.

## How it was checked

Each screen was looked at once in a headless browser screenshot. The flows were walked by running the page's script outside a browser against a stub document. No flow was clicked through by hand.
