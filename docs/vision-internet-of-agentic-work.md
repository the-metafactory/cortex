# The Internet of Agentic Work
### A vision for the Metafactory

> Part of the Metafactory vision set: **[VISION.md](../VISION.md)** (the *why*, for everyone) · **[PRINCIPLES.md](../PRINCIPLES.md)** (what's foundational, for builders) · **this doc** — the conceptual model: how to think about it, for builders and the technically curious.

> **A note on terms.** Capitalized words — *Principal, Assistant, Stack, Network, Session, Envelope, Capability, Mission Control* — name specific ideas in this system, distinct from their everyday meaning. Each is defined on first use and collected in the glossary at the end. Everything in the main body is conceptual and meant to outlast any particular software we build to realise it.

---

## The three things to take away

1. **Every person is amplified by a swarm they are accountable for.** A human sits at the centre and brings a team of Assistants that boosts them. The Assistants are tools; the human is the point — and the one responsible for what the swarm does in their name.

2. **Trust between people is the real network.** Work gathers people around a shared purpose, but projects come and go. What persists is the trust between the people who built them together. We optimise for the durable thing.

3. **It runs as an Internet.** A shared protocol and a single cockpit let trusted people compose their swarms around shared work — safely, sovereignly, and around the clock.

---

## The vision

**The shift.** TCP/IP gave us the Internet: a layered system where machines, routers, and whole organisations interoperate without anyone holding the entire thing in their head — until "the network" became something you could map. The Internet of Agentic Work makes the same move for agents. The unit isn't the agent and isn't the machine — it's the **Network**: a trust group of people and the swarms they bring, and Networks compose.

**Humans at the centre.** This is the load-bearing principle. A person brings a swarm of **Assistants** that amplifies what they can see, decide, and ship. The swarm is powerful, but it is an instrument. The point is the person — and the people.

**Trust is human.** Swarms are tools; trust forms between people. It grows through the desire to build together, to be creative, to learn — and it is earned by being seen: good ideas recognised, approaches adopted, problems solved alongside one another. Identity stays human and a little loose — real names and faces, not credentials.

**Work is the gravity that brings us together.** Work has many shapes — a project you stand up, a product you then maintain and operate, a quick gig, spare capacity you lend to the Network. It spans every domain, not just engineering: marketing, sales, strategy, a tax return. And it has a lifecycle: people *form* around a purpose, *build* it together, then *operate* what they shipped. There is a marketplace of it — problems posted, capabilities offered, collaborators drawn in by capability and by trust.

**Projects come and go; trust remains.** This is the asymmetry that matters. Work is transient — it forms, ships, dissolves. The connection between the people endures across every project. The Network is the people; the work is what they happen to be doing right now.

**On behalf of, and accountable.** An Assistant is always acting *for* a human. Every action it takes is on someone's behalf, and the trail of who-asked-for-what traces back to an accountable person. The swarm can run, but a human always carries the responsibility — it is their trust at stake.

**Always on, across the clock.** The people are spread across the world — from New Zealand to Central Europe to the US — so the sun is always up somewhere and the work follows it. The swarms never sleep. A good cockpit therefore tells two truths apart: *who is awake and active right now* versus *whose swarm is running on autopilot while they sleep*. Presence is human and circadian; activity is the swarm's and constant. They are never the same signal.

**One cockpit.** All of this has to become legible and governable to a person — otherwise it's just complexity. **Mission Control** is that single surface: not a wall of charts, but the commanding view with the real controls. From it you see your own Assistants at work, the Networks you operate and the ones you've joined, and the wider public mesh beyond — and you steer: admit a peer, dispatch work, request a review, rotate a key. You can move from the whole map down to a single action and back without losing your place. Mission Control is where the system surfaces to a human and becomes something you can see, understand, and command.

**Why it matters.** A person plus a swarm is powerful. The leverage compounds when people who trust each other compose their swarms around shared work — across Networks, across timezones, around the clock. We're building the protocol and the cockpit that let that happen safely, sovereignly, and humanely. **The agents are the tools; the people are the point; the trust is the network.**

---

## Where we are today *(the current incarnation — expected to change)*

The ideas above are deliberately independent of any implementation. Today we are realising them as a layered stack, built in the open and coordinated by people on Discord:

- **soma** — identity: the self an Assistant carries across substrates.
- **spawn** — execution: where the work actually runs.
- **myelin** — the bus and protocol: the shared language that **Envelopes** travel on, across three scopes — *local* (yours), *federated* (peers you've admitted), and *public* (the open mesh).
- **signal** — observability: watching that it all stays healthy.
- **cortex / Mission Control** — the surface: where the whole stack becomes legible and governable to a person.

Mechanically: every **Envelope** is signed by the **Stack** that emitted it, and the chain of signatures traces back to an accountable **Principal** — which is how "on behalf of" becomes verifiable rather than assumed. The same **Session** that carries the work also carries its attribution, so spend rolls up to any project and responsibility rolls up to a person.

*If these names change, the vision above does not.*

---

## Terms

> A reader's glossary for this doc — **consistent with, but not authoritative over,** the canonical bounded-context glossary in **[CONTEXT.md](../CONTEXT.md)**. The domain language is changed there (via a `grill-with-docs` session), never redefined here.

- **Principal** — a human who owns and runs Stacks; the accountable party. (The everyday word "operator" survives only as a low-level account concept.)
- **Assistant** — an agent identity a person brings; a tool in their swarm.
- **Stack** — a Principal's deployment that hosts Assistants and signs Envelopes.
- **Network** — a trust group: an admitted roster of people and their Stacks.
- **Session** — one run of work; the load-bearing vehicle that carries attribution.
- **Envelope** — a single signed message on the bus.
- **Capability** — what an Assistant offers to do.
- **Scope** — *local* / *federated* / *public*: expressed intent for how far an Envelope may travel.
- **Mission Control** — the cockpit; the one surface where the whole system becomes legible and governable.

---

*Distilled from the Metafactory design conversation. Conceptual-first, human-audience; copy and terminology revised per team feedback (2026-06).*
