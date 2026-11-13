import type { DeskPush, DeskTransport, InterruptRules, PushResult } from "../desk/interrupt";

export const NOW = Date.parse("2026-10-31T09:00:00.000Z");
export const MIN = 60_000;

export const RULES: InterruptRules = { transport: "discord", meetingMinutes: 10, mail: true, reminders: true, maxAgeMinutes: 60, everySeconds: 60, chime: true, notifications: true, holdDuringMeetings: true };

export class FakeTransport implements DeskTransport {
  readonly id = "discord" as const;
  readonly sent: DeskPush[] = [];
  constructor(private readonly answer: PushResult = { status: "sent", ref: "m-1" }) {}
  async send(push: DeskPush): Promise<PushResult> {
    this.sent.push(push);
    return this.answer;
  }
}

export const vipMail = (id: string, receivedAt: number) => ({ kind: "mail", id, from: { name: "Boss", address: "boss@example.com" }, subject: "Budget", receivedAt: new Date(receivedAt).toISOString(), unread: true });
