#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";

const log = process.env.STUB_PI_LOG ?? "";
const stdin = await new Response(Bun.stdin.stream()).text();
appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), stdin })}\n`);
const delay = Number(process.env.STUB_PI_DELAY_MS ?? "0");
if (delay > 0) await Bun.sleep(delay);
const events = process.env.STUB_PI_EVENTS ? readFileSync(process.env.STUB_PI_EVENTS, "utf8") : "";
process.stdout.write(events);
if (process.env.STUB_PI_STDERR) process.stderr.write(`${process.env.STUB_PI_STDERR}\n`);
process.exit(Number(process.env.STUB_PI_EXIT ?? "0"));
