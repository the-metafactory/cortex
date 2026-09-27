/**
 * cortex#1503 — a small in-memory JetStream account for provisioning tests.
 *
 * Implements the `ProvisionJsm` port plus a `publish` / `pull` pair, modelling
 * just enough server behaviour to prove WHICH durable receives WHICH request:
 *
 *  - a publish is stored only when some stream's subjects capture it (an
 *    uncaptured subject is dropped, as on a real server with no stream);
 *  - streams reject subjects that overlap another stream's;
 *  - a consumer's filter must fall inside its stream's subjects;
 *  - a durable starts at `All` (seq 1), `New` (after the last stored seq) or
 *    `StartSequence` (`opt_start_seq`), then sees only messages its filter matches;
 *  - `consumers.info` reports `delivered.stream_seq`, `num_ack_pending`,
 *    `num_waiting` for the migration logic.
 *
 * Interest-retention trimming is not modelled — no test here depends on it.
 * CI never needs a nats-server.
 */

import { DeliverPolicy } from "nats";
import type { ConsumerConfig, ConsumerInfo, StreamConfig, StreamInfo } from "nats";
import type { ProvisionJsm } from "../types";
import { subjectCovers, subjectsOverlap } from "../subject-set";

interface StoredMessage {
  seq: number;
  subject: string;
}

interface FakeStream {
  config: Partial<StreamConfig> & { name: string; subjects: string[] };
  messages: StoredMessage[];
  lastSeq: number;
}

interface FakeConsumer {
  config: Partial<ConsumerConfig>;
  /** Stream seq of the last message handed out. */
  deliveredSeq: number;
  ackPending: Set<number>;
  numWaiting: number;
}

function apiError(message: string, errCode: number): Error {
  const err = new Error(message);
  (err as unknown as { api_error: { err_code: number } }).api_error = { err_code: errCode };
  return err;
}

export interface FakeJetStream {
  jsm: ProvisionJsm;
  /** Store `subject` in the capturing stream. Returns the stream name, or `null` when no stream captures it. */
  publish(subject: string): string | null;
  /** Hand out every undelivered message matching the durable's filter; acks them unless `ack: false`. */
  pull(stream: string, durable: string, opts?: { ack?: boolean }): string[];
  /** Ack every message pending on a durable. */
  ackAll(stream: string, durable: string): void;
  /** Simulate a live (or not-yet-expired) pull request on a durable. */
  setWaiting(stream: string, durable: string, n: number): void;
  streamSubjects(stream: string): string[];
  consumerNames(stream: string): string[];
  consumerFilter(stream: string, durable: string): string | undefined;
  /** Every `streams.update` call, in order. */
  streamUpdates: { name: string; subjects: string[] }[];
  consumerDeletes: { stream: string; durable: string }[];
}

export function createFakeJetStream(): FakeJetStream {
  const streams = new Map<string, FakeStream>();
  const consumers = new Map<string, Map<string, FakeConsumer>>();
  const streamUpdates: { name: string; subjects: string[] }[] = [];
  const consumerDeletes: { stream: string; durable: string }[] = [];

  const getStream = (name: string): FakeStream => {
    const s = streams.get(name);
    if (s === undefined) throw apiError(`stream not found`, 10059);
    return s;
  };
  const getConsumer = (stream: string, durable: string): FakeConsumer => {
    getStream(stream);
    const c = consumers.get(stream)?.get(durable);
    if (c === undefined) throw apiError(`consumer not found`, 10014);
    return c;
  };
  const assertNoCrossStreamOverlap = (name: string, subjects: readonly string[]): void => {
    for (const [other, s] of streams) {
      if (other === name) continue;
      for (const a of subjects) {
        for (const b of s.config.subjects) {
          if (subjectsOverlap(a, b)) {
            throw apiError(`subjects overlap with an existing stream (${other})`, 10065);
          }
        }
      }
    }
  };
  const undelivered = (c: FakeConsumer, s: FakeStream): StoredMessage[] => {
    const filter = c.config.filter_subject ?? "";
    return s.messages.filter(
      (m) => m.seq > c.deliveredSeq && (filter === "" || subjectCovers(filter, m.subject)),
    );
  };
  const streamInfo = (s: FakeStream): StreamInfo =>
    ({ config: { ...s.config, subjects: [...s.config.subjects] } }) as unknown as StreamInfo;
  const consumerInfo = (c: FakeConsumer, stream: FakeStream): ConsumerInfo => {
    const numPending = undelivered(c, stream).length;
    return {
      name: c.config.durable_name,
      config: { ...c.config },
      delivered: { stream_seq: c.deliveredSeq, consumer_seq: 0 },
      ack_floor: { stream_seq: c.deliveredSeq, consumer_seq: 0 },
      num_ack_pending: c.ackPending.size,
      num_waiting: c.numWaiting,
      num_pending: numPending,
    } as unknown as ConsumerInfo;
  };

  const jsm: ProvisionJsm = {
    streams: {
      info: async (name) => streamInfo(getStream(name)),
      add: async (cfg) => {
        const name = cfg.name!;
        const subjects = [...(cfg.subjects ?? [])];
        if (streams.has(name)) throw apiError(`stream name already in use`, 10058);
        assertNoCrossStreamOverlap(name, subjects);
        const s: FakeStream = { config: { ...cfg, name, subjects }, messages: [], lastSeq: 0 };
        streams.set(name, s);
        consumers.set(name, new Map());
        return streamInfo(s);
      },
      update: async (name, cfg) => {
        const s = getStream(name);
        const subjects = [...(cfg.subjects ?? s.config.subjects)];
        assertNoCrossStreamOverlap(name, subjects);
        s.config = { ...s.config, ...cfg, name, subjects };
        streamUpdates.push({ name, subjects });
        return streamInfo(s);
      },
    },
    consumers: {
      info: async (stream, durable) => consumerInfo(getConsumer(stream, durable), getStream(stream)),
      add: async (stream, cfg) => {
        const s = getStream(stream);
        const durable = cfg.durable_name!;
        const filter = cfg.filter_subject;
        if (filter !== undefined && filter !== "" && !s.config.subjects.some((sub) => subjectCovers(sub, filter))) {
          throw apiError(`consumer filter subject is not a valid subset of the interest subjects`, 10093);
        }
        const existing = consumers.get(stream)!.get(durable);
        if (existing !== undefined) throw apiError(`consumer name already in use`, 10148);
        const policy = cfg.deliver_policy ?? DeliverPolicy.All;
        const deliveredSeq =
          policy === DeliverPolicy.New
            ? s.lastSeq
            : policy === DeliverPolicy.StartSequence
              ? (cfg.opt_start_seq ?? 1) - 1
              : 0;
        const c: FakeConsumer = { config: { ...cfg }, deliveredSeq, ackPending: new Set(), numWaiting: 0 };
        consumers.get(stream)!.set(durable, c);
        return consumerInfo(c, s);
      },
      update: async (stream, durable, cfg) => {
        const c = getConsumer(stream, durable);
        c.config = { ...c.config, ...cfg };
        return consumerInfo(c, getStream(stream));
      },
      delete: async (stream, durable) => {
        getConsumer(stream, durable);
        consumers.get(stream)!.delete(durable);
        consumerDeletes.push({ stream, durable });
        return true;
      },
    },
  };

  return {
    jsm,
    publish(subject) {
      for (const [name, s] of streams) {
        if (s.config.subjects.some((sub) => subjectCovers(sub, subject))) {
          s.lastSeq += 1;
          s.messages.push({ seq: s.lastSeq, subject });
          return name;
        }
      }
      return null;
    },
    pull(stream, durable, opts = {}) {
      const s = getStream(stream);
      const c = getConsumer(stream, durable);
      const out = undelivered(c, s);
      // Like the server: `delivered.stream_seq` is the last message handed out.
      const last = out.at(-1);
      if (last !== undefined) c.deliveredSeq = last.seq;
      if (opts.ack === false) for (const m of out) c.ackPending.add(m.seq);
      return out.map((m) => m.subject);
    },
    ackAll(stream, durable) {
      getConsumer(stream, durable).ackPending.clear();
    },
    setWaiting(stream, durable, n) {
      getConsumer(stream, durable).numWaiting = n;
    },
    streamSubjects: (stream) => [...getStream(stream).config.subjects],
    consumerNames: (stream) => [...(consumers.get(stream)?.keys() ?? [])],
    consumerFilter: (stream, durable) => consumers.get(stream)?.get(durable)?.config.filter_subject,
    streamUpdates,
    consumerDeletes,
  };
}
