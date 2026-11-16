import type { MailConnectionBinding } from "./mail-read-source";

export interface MailExecutionProvider {
  readonly version?: number;
  draft?(input: unknown): Promise<unknown>;
  lookup?(input: unknown): Promise<unknown>;
  move?(input: unknown): Promise<unknown>;
  restore?(input: unknown): Promise<unknown>;
  lookupMove?(input: unknown): Promise<unknown>;
  unsubscribe?(input: unknown): Promise<unknown>;
  lookupUnsubscribe?(input: unknown): Promise<unknown>;
  report?(input: unknown): Promise<unknown>;
  lookupReport?(input: unknown): Promise<unknown>;
}

export interface MailExecutionConnections {
  connection(binding: MailConnectionBinding): MailExecutionProvider | undefined;
}

