# Metafactory — Principles

> **What this is.** The foundational beliefs that guide *what we build* — the guiding light for builders, alongside **[CONTEXT.md](CONTEXT.md)** (the domain language) and the architecture spec. **[VISION.md](VISION.md)** says *why*; these say *what is foundational, and what we refuse to become.*
>
> **How to use it.** A **design-time and review-time lens.** Before building, and before merging, hold the change up against these — the same way `CONTEXT.md` is the vocabulary contract that review and CI enforce. If a change weakens a principle, that is a finding, not a footnote.
>
> *Distilled from the vision and the community-review thread (2026-06) — first-principles, what's foundational, and what this must never become.*

---

## The principles

### 1. People at the centre
Agents amplify people; they never stand in for them. The human is the point — and the one accountable for what their swarm does.
**The test —** does a human stay in control, and does responsibility trace back to one?

### 2. Trust is human — and it's what lasts
Trust forms between people, earned by building together: good ideas seen and credited, problems solved alongside one another. Projects come and go; the trust remains. We optimise for the durable thing.
**The test —** does this strengthen the relationship between people, or only the transaction?

### 3. On behalf of, and accountable
Every action an agent takes is *for* a person, and the who-asked-for-what trail is **verifiable — not assumed.** The swarm can run on its own, but a human always carries the responsibility.
**The test —** can you trace this action to an accountable human by signature, not by "trust me"?

### 4. Secure by design — never bolted on
Trust and security are first principles you build *from*, not features you add once something ships. Capability, identity, and the audit trail belong to the architecture from the first commit — you review what a skill can do *before* it runs, not after it breaks. A stack that defers safety to "later" never earns it; retrofitted trust is the absence of trust. This is the one commitment that explains *why* the architecture looks the way it does.
**The test —** if this change defers trust or security to "later," that is a finding, not a roadmap item.

### 5. Sovereign by default
Your work is yours. You decide what to share, with whom, and how far it travels. The secure, private default is the one we ship.
**The test —** does the principal keep control of their data and the scope it travels in — without having to opt in to safety?

### 6. Open and composable
No one owns the network. Anyone can join, bring their own assistants, build, and connect to others. The value is in composing, not in capturing.
**The test —** does this keep the door open, or quietly build a wall?

### 7. Legible, and easy — or it won't be used
The whole system must surface to a person who can see and steer it. If it is hard, or hidden behind jargon, people won't engage — and an ecosystem no one joins is not one. Ease of engagement is a first-class requirement, not polish.
**The test —** can a newcomer understand and command this without insider knowledge?

---

## What we refuse to become
- **A crowd of bots replacing people.** The swarm serves the human; it never becomes the point.
- **A walled garden.** No central owner, no lock-in, no gatekeeper deciding who belongs.
- **Autonomy without accountability.** Nothing acts without a human it traces back to.
- **A stack that retrofits trust.** Security and accountability are designed in from the first commit; we refuse to bolt them on after something ships.
- **A system only experts can use.** If engaging requires reading the source, we have failed principle 7.

---

*These are stable by design. The technology that realises them will change; the principles should not. When a principle and an implementation disagree, the implementation is what gives.*
