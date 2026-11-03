import type { CreatePrivateThreadResult, ThreadDeleteResult, ThreadMembersResult, ThreadMessage, ThreadPostResult, ThreadReadResult } from "../../../adapters/types";
import type { ThreadCapable } from "../../discord";

export const BOT = "bot-1";
export type PostFault = "uncertain-landed" | "uncertain-lost" | "failed";
export interface FakeThread { name: string; parent: string; members: string[]; messages: ThreadMessage[] }

export class FakeThreads implements ThreadCapable {
  readonly threads = new Map<string, FakeThread>();
  readonly posts: { threadId: string; text: string; nonce: string }[] = [];
  readonly deleted: string[] = [];
  created = 0;
  failMemberAdd = false;
  intruder: string | null = null;
  faults: PostFault[] = [];
  readFails = false;
  private seq = 0;

  getPlatformUserId(): Promise<string> { return Promise.resolve(BOT); }
  createPrivateThread(opts: { channelId: string; name: string; memberIds: string[] }): Promise<CreatePrivateThreadResult> {
    this.created += 1;
    const threadId = `thread-${this.created}`;
    this.threads.set(threadId, { name: opts.name, parent: opts.channelId, members: [BOT, ...(this.failMemberAdd ? [] : opts.memberIds)], messages: [] });
    return Promise.resolve({ ok: true, threadId });
  }
  privateThreadMembers(threadId: string): Promise<ThreadMembersResult> {
    const thread = this.threads.get(threadId);
    if (!thread) return Promise.resolve({ ok: false, detail: "unknown thread" });
    return Promise.resolve({ ok: true, memberIds: [...thread.members, ...(this.intruder ? [this.intruder] : [])] });
  }
  postToThread(opts: { threadId: string; text: string; nonce: string }): Promise<ThreadPostResult> {
    const thread = this.threads.get(opts.threadId);
    if (!thread) return Promise.resolve({ ok: false, detail: "unknown thread", uncertain: false });
    const fault = this.faults.shift();
    if (fault === "failed") return Promise.resolve({ ok: false, detail: "Missing Permissions", uncertain: false });
    if (fault === "uncertain-lost") return Promise.resolve({ ok: false, detail: "timeout", uncertain: true });
    this.posts.push(opts);
    const message = { id: `m-${++this.seq}`, authorId: BOT, content: opts.text };
    thread.messages.push(message);
    if (fault === "uncertain-landed") return Promise.resolve({ ok: false, detail: "timeout", uncertain: true });
    return Promise.resolve({ ok: true, messageId: message.id });
  }
  recentThreadMessages(opts: { threadId: string; limit: number }): Promise<ThreadReadResult> {
    if (this.readFails) return Promise.resolve({ ok: false, detail: "gateway down" });
    return Promise.resolve({ ok: true, messages: (this.threads.get(opts.threadId)?.messages ?? []).slice(-opts.limit) });
  }
  deleteThread(threadId: string): Promise<ThreadDeleteResult> {
    this.deleted.push(threadId);
    this.threads.delete(threadId);
    return Promise.resolve({ ok: true });
  }
  texts(threadId: string): string[] { return (this.threads.get(threadId)?.messages ?? []).map(message => message.content); }
}
