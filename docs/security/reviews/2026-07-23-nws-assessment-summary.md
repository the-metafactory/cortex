# Cortex review — high-level assessment

*Rob → Andreas. The plain-language read on top of the hard findings.*

Andreas — before you or Luna dig into the detail, here's how I'd summarize what the review actually found, and what it means.

**The core is well-built.** There's no authentication bypass, and the trust model is genuinely thought through, not bolted on. The plugin loader in particular is some of the sharper defensive code I've read this year: it fails closed, it defends against path-traversal and symlink escapes, it rejects the trust signals a bundle could forge, and it documents its own residual risk honestly in the comments. That last part is rare and it's a good sign about how the code was written. So read the findings as "here's where a strong system thins out," not "here's a broken one."

**The one theme under almost every finding: cortex enforces at the gate, not at execution.** The boundaries are declared, and they're checked at load time and in the prompt, but they aren't always enforced deterministically once an agent is running. The clearest example is that the Bash tool gets a real, code-level guard, while the file tools (Read/Write) are governed only by an instruction in the prompt asking the agent to behave. Against prompt injection, an instruction the model is asked to obey is not a boundary. Same shape shows up with plugins running at full daemon authority, and with the sovereignty check defaulting to log-only instead of enforce. None of these are exotic. They're all versions of "the rule is written down but nothing stops you at the moment it matters."

**Which is exactly why your sandboxing instinct is right.** You told me you've been interested in sandboxing for a long time and I want to be clear the review backs that all the way. The single highest-leverage fix across these findings is a real execution-time boundary per worker, so the rule is enforced by the OS or a broker, not by asking the model nicely. Your blast-radius framing is the right lens for it too. What can each worker reach, what is it allowed to talk to, what egress does it have, is prompt injection actually contained. The review is basically a first blast-radius map of the trust surfaces I looked at, scored on those axes.

**On scope, so nobody over-reads it.** This pass was the trust-boundary code, not the whole repository. The biggest surface I did not open is the Mission Control API and its auth. And where a finding's real severity depends on a test I didn't run yet, I marked it as repro-gated rather than claiming it. It's an honest first look, not a full audit, and it says so in its own limits section.

Where this goes next is the dynamic side you and I have been circling: instead of only reading the code, put each worker in a contained bowl and watch how it behaves under injection across scenarios, measured. That's the continuous intent-fidelity measurement, and it's what I've been heads-down on. This review is the static half. The behavioral half is the interesting one, and it's the direction we already aligned on.

Happy to walk any of it with you or Luna once you've had a look.

— Rob
