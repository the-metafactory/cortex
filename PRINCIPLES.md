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

### 8. Autonomy is a line, not a dial
Autonomy isn't a slider you turn up. There's a line, and it's drawn by two questions: *can this be undone, and how far does it reach if it's wrong.* Below the line — editing a branch, running tests, reading, drafting, opening a PR — let the agent run and don't watch. Above it — merging to main, deleting data, sending anything outside, rotating a credential, touching its own config — stop and gate. Babysitting parks the human below the line; YOLO lets it above. Put the human *on the line itself* and you get both: free movement where mistakes are cheap, attention only where they aren't.
**The test —** for this action, is the human placed at the reversibility line — not babysitting the cheap work, nor absent from the irreversible?

### 9. Gate on what happened, not what it claims
A gate that accepts the agent's story is no gate — any gate it can write to, it forges. The check is on observable state: *tests exited 0, the old value is gone from the repo, the URL answered* — never "I verified it." Every gated action leaves a named receipt. The model stays untrusted forever, and that is fine: you stop trusting its account and start trusting what you can watch happen.
**The test —** does this verify a fact you can observe, or does it take the agent's word?

### 10. Controls live where the agent has no hands
Enforcement sits where the thing being enforced cannot reach it: branch protection on the server, a hook running from a directory the agent cannot write, an append-only log it cannot rewrite. A guard running out of the agent's own repo is not a guard.
**The test —** can the agent reach, edit, or silence this control? If yes, it is not one.

### 11. The agent never sets its own limits
Whether an action is auto, propose, or needs-a-human is policy the agent *inherits and cannot edit* — and flipping that setting is the most gated thing there is. A hook the agent can switch off was never a hook.
**The test —** can the agent change its own permission to act? If yes, there is no permission — only a suggestion.

### 12. Deterministic gates; the model only advises
The condition that lets a change through is deterministic — tests, a grep for banned patterns, a human tick for anything irreversible. A model reviewer feeds in as a second opinion, never as the receipt. Make an LLM the judge and it nitpicks round after round until it is overruled — babysitting in a costume.
**The test —** is what lets this through a deterministic check with the model advisory, or a model's sign-off?

*Principles 8–12 distilled from the autonomy/gating thread (2026-07) — Ivy's reflection and Vincent's JSON-gate lesson.*

---

## What we refuse to become
- **A crowd of bots replacing people.** The swarm serves the human; it never becomes the point.
- **A walled garden.** No central owner, no lock-in, no gatekeeper deciding who belongs.
- **Autonomy without accountability.** Nothing acts without a human it traces back to.
- **A stack that retrofits trust.** Security and accountability are designed in from the first commit; we refuse to bolt them on after something ships.
- **A system only experts can use.** If engaging requires reading the source, we have failed principle 7.
- **A gate the agent can switch off.** If the acting agent can edit its own permissions, hooks, or the log, they were never controls.
- **An LLM as the merge condition.** Model review is a filter, not a receipt; the judge is deterministic.
- **A system that audits itself.** The observer is never the thing being graded.

---

*These are stable by design. The technology that realises them will change; the principles should not. When a principle and an implementation disagree, the implementation is what gives.*
