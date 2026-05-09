/**
 * F-007: Mock adapter for testing
 *
 * Implements PlatformAdapter with in-memory state.
 * All method calls are recorded for assertion in tests.
 */

import type {
  PlatformAdapter,
  InboundMessage,
  AccessDecision,
  ResponseTarget,
  OutboundFile,
  ContextMessage,
} from "./types";
import type { Envelope } from "../bus/myelin/envelope-validator";
import type { SurfaceAdapter } from "../bus/surface-router";

const ALLOW_ALL: AccessDecision = {
  allowed: true,
  features: { chat: true, async: true, team: true },
};

export class MockAdapter implements PlatformAdapter {
  readonly platform = "mock";
  readonly instanceId: string;

  /** Recorded postResponse calls */
  sentMessages: Array<{ target: ResponseTarget; text: string; files?: OutboundFile[] }> = [];
  /** Recorded sendTyping calls */
  typingSent: ResponseTarget[] = [];
  /** Recorded sendProgress calls */
  progressSent: Array<{ target: ResponseTarget; text: string }> = [];
  /** Recorded createThread calls */
  threadsCreated: Array<{ msg: InboundMessage; name: string }> = [];
  /** Recorded notifyOperator calls */
  operatorNotifications: string[] = [];
  /** MIG-3b: Recorded envelopes received via surfaceConfig.render() */
  envelopesRendered: Envelope[] = [];

  /** Configurable return value for resolveAccess */
  accessDecision: AccessDecision = ALLOW_ALL;
  /** Configurable return value for fetchContext */
  contextMessages: ContextMessage[] = [];
  /** MIG-3b: Configurable subject patterns the surface face listens for. Default `mock.>`
   *  matches anything under `mock.*` for surface-router integration tests. */
  surfaceSubjects: string[] = ["mock.>"];

  private onMessage?: (msg: InboundMessage) => Promise<void>;
  private started = false;
  private threadCounter = 0;

  constructor(instanceId: string = "mock-instance") {
    this.instanceId = instanceId;
  }

  /**
   * MIG-3b — Surface-adapter face for surface-router integration tests.
   *
   * Records every rendered envelope into `envelopesRendered` so tests can
   * assert on the dispatch path. Tests that need a different subject set
   * can mutate `surfaceSubjects` before registering, or wrap this in a
   * custom SurfaceAdapter literal — registration is the consumer's choice.
   */
  get surfaceConfig(): SurfaceAdapter {
    return {
      id: this.instanceId,
      subjects: this.surfaceSubjects,
      // The mock accepts `signal` for contract symmetry but ignores it — there's
      // no I/O to cancel. Tests that need to assert on the abort path can
      // construct a custom SurfaceAdapter literal that observes `signal.aborted`.
      render: async (envelope, _signal) => {
        this.envelopesRendered.push(envelope);
      },
    };
  }

  async start(onMessage: (msg: InboundMessage) => Promise<void>): Promise<void> {
    this.onMessage = onMessage;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.onMessage = undefined;
  }

  async fetchContext(_msg: InboundMessage, _depth: number): Promise<ContextMessage[]> {
    return this.contextMessages;
  }

  resolveAccess(_msg: InboundMessage): AccessDecision {
    return this.accessDecision;
  }

  async postResponse(target: ResponseTarget, text: string, files?: OutboundFile[]): Promise<void> {
    this.sentMessages.push({ target, text, files });
  }

  async sendTyping(target: ResponseTarget): Promise<void> {
    this.typingSent.push(target);
  }

  async sendProgress(target: ResponseTarget, text: string): Promise<void> {
    this.progressSent.push({ target, text });
  }

  async clearProgress(_target: ResponseTarget): Promise<void> {
    // No-op for mock
  }

  async createThread(msg: InboundMessage, name: string): Promise<ResponseTarget> {
    this.threadsCreated.push({ msg, name });
    this.threadCounter++;
    return {
      instanceId: this.instanceId,
      channelId: msg.channelId,
      threadId: `mock-thread-${this.threadCounter}`,
    };
  }

  async notifyOperator(text: string): Promise<void> {
    this.operatorNotifications.push(text);
  }

  /** Simulate an inbound message (for testing) */
  async simulateMessage(msg: InboundMessage): Promise<void> {
    if (!this.onMessage) throw new Error("MockAdapter not started");
    await this.onMessage(msg);
  }

  /** Check if adapter has been started */
  isStarted(): boolean {
    return this.started;
  }

  /** Reset all recorded state */
  reset(): void {
    this.sentMessages = [];
    this.typingSent = [];
    this.progressSent = [];
    this.threadsCreated = [];
    this.operatorNotifications = [];
    this.envelopesRendered = [];
    this.threadCounter = 0;
  }
}
