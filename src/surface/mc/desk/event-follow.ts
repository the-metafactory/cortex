export interface FollowedEvent {
  title: string;
  at: number;
  end: number;
}

export interface EventFacts {
  events: ReadonlyMap<string, FollowedEvent>;
  covered: (eventKey: string, at: number) => boolean;
}

export type EventSighting = { kind: "seen"; event: FollowedEvent; moved: boolean } | { kind: "cancelled" } | { kind: "unseen" };

/** Where a remembered calendar event stands: still listed (and whether it moved or was renamed), gone from a reading that covers its start (cancelled), or out of sight. */
export function sightEvent(facts: EventFacts, key: string, known: { title: string | null; at: number | null; end: number | null }): EventSighting {
  const seen = facts.events.get(key);
  if (seen) return { kind: "seen", event: seen, moved: seen.at !== known.at || seen.end !== known.end || seen.title !== known.title };
  return known.at !== null && facts.covered(key, known.at) ? { kind: "cancelled" } : { kind: "unseen" };
}
