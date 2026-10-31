# Write a source adapter

A source adapter makes your calendar or mail tool readable by the Desk. It is any command that exits 0 and prints one JSON object matching the [source contract](commands.md#source-output).

## Print one reading

Write a command that reads your tool and converts its output to `events`, `items`, or both. Keep ids stable across reads. Use an event instance id for each recurring occurrence and the mail's Message-ID for a message.

This Bun adapter produces a calendar event tomorrow at 09:00 in the host's timezone. Save it as `/opt/my-desk/calendar.ts`:

```ts
const start = new Date();
start.setDate(start.getDate() + 1);
start.setHours(9, 0, 0, 0);
const end = new Date(start.getTime() + 30 * 60_000);
process.stdout.write(JSON.stringify({
  events: [{
    id: `planning:${start.toISOString()}`,
    start: start.toISOString(),
    end: end.toISOString(),
    title: "Planning",
  }],
}));
```

Replace the example event with readings from your tool. For mail, the [mail example](examples/source-mail.json) shows every supported field. Include `account` if the Desk will trash mail or save reply drafts. Adapters should read messages without marking them read.

Put logs on stderr. A failure to reach your tool must exit nonzero rather than print an empty successful reading. On command failure, the Desk reports the error and preserves the previous entries. An empty successful array means there are currently no entries.

## Check the contract

Run your command through Cortex's validator:

```sh
bun /opt/my-desk/calendar.ts | cortex desk check-source
```

The example prints `The Desk reads 1 event and 0 mail items.` and exits 0. To check a captured reading, pass its file path to `cortex desk check-source`.

Check a failure as well:

```sh
cortex desk check-source docs/desk/examples/source-broken.json
```

This exits 1 and names `events[0].start` and `items[0].unread`. The Desk drops those entries but retains valid siblings. The full list of required fields and failure behavior is in [Source output](commands.md#source-output).

## Configure the source

Add the command to `mc.desk.sources` in your stack YAML:

```yaml
mc:
  enabled: true
  desk:
    sources:
      - id: my-calendar
        command: [/usr/local/bin/bun, /opt/my-desk/calendar.ts]
        everySeconds: 300
        timeoutSeconds: 30
```

Use the actual absolute path to Bun on the host. Cortex runs this array without a shell, so `~`, `$HOME`, pipes, and redirections are literal arguments. The daemon's environment may differ from the terminal's environment.

Validate the stack config, restart the stack, and reload the Desk. The example event appears tomorrow on the timeline. If it does not, inspect the Desk's system lines for a source error or an invalid field. Confirm that the daemon's user can run the exact command and read the files it needs.

For working adapters, see `desk-ics` and `desk-imap` in [cortex-desk-adapters](https://github.com/the-metafactory/cortex-desk-adapters/blob/main/EXAMPLES.md). To create entries or send notifications instead of reading them, use the [writer and transport contracts](commands.md).
