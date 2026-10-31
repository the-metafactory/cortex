# Get started with the Desk

In this tutorial, we turn on the Desk on a Cortex stack and look at it with Cortex data alone. Then we add a calendar and a mailbox from example files, so the timeline and the item list fill up. At the end, the Desk shows a daily meeting called "Plan the day" on today's timeline and one unread mail as an item.

You need a running Cortex stack. If you do not have one yet, follow [Getting started with cortex](../getting-started.md) first. You also need [Bun](https://bun.sh) and `git`.

In the steps below, `<slug>` is the name of your stack, and `~/.config/metafactory/cortex/<slug>/` is its config directory.

## Turn on the Desk

1. Open `~/.config/metafactory/cortex/<slug>/stacks/<slug>.yaml`.
2. Add an `mc` block, or extend the one that is there, so that it holds the lines from [`examples/minimal.yaml`](examples/minimal.yaml):

	```yaml
	mc:
	  enabled: true
	  desk:
	    displayName: Sam
	```

	Put your own name in `displayName`. The Desk uses it in its greeting.

3. Check the config before you restart:

	```bash
	cortex config validate --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml
	```

	The command exits 0 when the config is valid. If it names a key under `mc.desk`, look the key up in the [configuration reference](configuration.md).

4. Restart the stack. If you started it by hand, stop it and run `cortex start --config ~/.config/metafactory/cortex/<slug>/<slug>.yaml` again.
5. Ask Mission Control for the Desk:

	```bash
	curl -s http://127.0.0.1:8767/api/desk | head -c 300
	```

	You see JSON that starts with `{"generatedAt":` and holds `"displayName":"Sam"`. Mission Control listens on port 8767 unless `mc.port` says otherwise. If the answer is `{"enabled":false}`, the stack did not read the `desk` block. Check the file and the restart.

6. Open `http://127.0.0.1:8767/` in a browser.

The Desk opens. It greets you, shows today's timeline with a Now marker, and lists what Cortex knows: goal checks and agent escalations from Vigil, and agents from Ranger if you set `mc.desk.ranger.url`. On a new stack without Vigil or Ranger readings, the Desk explains that no source is connected and shows how to connect one.

Type `remind me to stretch in 10 minutes` into the command bar at the bottom and press Enter. The Desk shows a reminder card. Confirm it. The reminder appears on today's timeline. Cortex keeps notes and reminders in its own database, so they work without any adapter.

## Add a calendar

A source is a command that prints the Desk's JSON. We use `desk-ics`, an example adapter that reads an ICS file, the format that most calendar apps export and publish.

1. Get the example adapters:

	```bash
	git clone https://github.com/the-metafactory/cortex-desk-adapters ~/cortex-desk-adapters
	cd ~/cortex-desk-adapters
	bun install
	```

2. Run the adapter on its example calendar:

	```bash
	bun bin/desk-ics.ts examples/calendar.ics --days 1
	```

	It prints one line of JSON with an `events` list. One event is "Plan the day" at 09:00 today, in your computer's time zone.

3. Check the output against the Desk's contract:

	```bash
	bun bin/desk-ics.ts examples/calendar.ics | cortex desk check-source
	```

	The command prints `The Desk reads 11 events and 0 mail items.` and exits 0. The default seven-day window contains seven daily meetings, three team meetings, and one focus day.

4. Add the source to the `desk` block in your stack config. Use absolute paths, because Cortex runs the command without a shell and does not expand `~`:

	```yaml
	mc:
	  enabled: true
	  desk:
	    displayName: Sam
	    sources:
	      - id: calendar
	        command: [/home/sam/cortex-desk-adapters/bin/desk-ics.ts, /home/sam/cortex-desk-adapters/examples/calendar.ics]
	```

	If the stack runs as a service whose `PATH` has no `bun`, start the command with the full path to `bun`: `command: [/home/sam/.bun/bin/bun, /home/sam/cortex-desk-adapters/bin/desk-ics.ts, ...]`.

5. Validate the config and restart the stack, as in the first section.
6. Reload the Desk.

"Plan the day" now sits on today's timeline at 09:00. The strip of the next days shows "Team sync" on Monday, Wednesday and Friday. Ten minutes before a meeting starts, the Desk lists it as the top item.

To use your own calendar, point `desk-ics` at an exported `.ics` file or at the https address your calendar app publishes. The adapter's README lists what it reads and what it skips.

## Choose calendars and colours

Open **Settings** and find **Calendars**. Each calendar reported by a source has a visibility switch and a colour control. Changes are stored in Mission Control's database. Hidden calendars disappear from the timeline and next-days strip, and do not trigger meeting pushes. The chosen colour marks the calendar's events in both views.

Sources report calendar names on events. A source without calendar names appears as one calendar named after the source. A calendar remains listed when its current event window is empty, so you can turn it back on later.

## Add mail

The simplest source is a file that already holds the Desk's JSON. We use the example mail file with `cat`:

1. Add a second source:

	```yaml
	    sources:
	      - id: calendar
	        command: [/home/sam/cortex-desk-adapters/bin/desk-ics.ts, /home/sam/cortex-desk-adapters/examples/calendar.ics]
	      - id: sample-mail
	        command: [/bin/cat, /home/sam/cortex-desk-adapters/examples/mail.json]
	```

2. Validate the config and restart the stack.
3. Reload the Desk.

The item list now shows "Ada Lovelace wrote: "Budget for next year"", with the first paragraph of the mail and the actions the Desk can offer without a mail command: **Unimportant** and **Not now**. In the item's **⋯** menu, choose **Always show this** and watch the item move up.

The full starter config, with areas and both sources, is [`examples/starter.yaml`](examples/starter.yaml).

## Next steps

- Read real mail with `desk-imap`, the example IMAP adapter. Its README shows the flags and where the password comes from.
- Get pushes on your phone with `desk-ntfy` and `interruptions.transport: command`. See [the transport contract](commands.md#transports).
- Give the Desk your own tool with [Write a source adapter](write-a-source.md).
- Sort mail with a model, delete mail and draft replies: see `mc.desk.mail` in the [configuration reference](configuration.md#mail).
