#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

const log = process.env.STUB_PI_LOG ?? "";
const stdin = process.env.STUB_PI_IGNORE_STDIN ? "" : await new Response(Bun.stdin.stream()).text();
appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`);
const delay = Number(process.env.STUB_PI_DELAY_MS ?? "0");
if (delay > 0) await Bun.sleep(delay);
const events = process.env.STUB_PI_EVENTS ? readFileSync(process.env.STUB_PI_EVENTS, "utf8") : "";
const pauseAfter = Number(process.env.STUB_PI_PAUSE_AFTER ?? "0");
if (pauseAfter > 0) {
  const lines = events.split("\n");
  process.stdout.write(`${lines.slice(0, pauseAfter).join("\n")}\n`);
  await Bun.sleep(Number(process.env.STUB_PI_PAUSE_MS ?? "500"));
  if (process.env.STUB_PI_PAUSE_MARKER) appendFileSync(process.env.STUB_PI_PAUSE_MARKER, "resumed");
  process.stdout.write(lines.slice(pauseAfter).join("\n"));
} else process.stdout.write(events);
if (process.env.STUB_PI_STDERR) process.stderr.write(`${process.env.STUB_PI_STDERR}\n`);
process.exit(Number(process.env.STUB_PI_EXIT ?? "0"));
