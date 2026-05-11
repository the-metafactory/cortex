# Iteration Plan: DD-13 Licensing Strategy

<!-- lifted-from-grove-v2-at-MIG-7.11 -->
<!-- Original location: github.com/the-metafactory/grove-v2 docs/iteration-licensing.md -->
<!-- Lifted: 2026-05-11 — historical references to grove/grove-v2 retained for provenance. -->

**Design Decision:** DD-13 — Apache 2.0 with documented FSL cloud boundary
**Source:** DD-13 research + council debate (2026-04-05)
**Status:** Planned

---

## Context

DD-13 establishes the licensing strategy for the metafactory ecosystem:
- Apache 2.0 across all ecosystem repos for local tools
- Documented architectural seam for future FSL on cloud components
- Trust through transparency as the guiding principle

## Phase 2A: License Foundation

| # | Item | Repo | Status |
|---|------|------|--------|
| S2-06 | Add Apache 2.0 LICENSE to grove | grove | [ ] |
| S2-06b | Add Apache 2.0 LICENSE to blueprint | blueprint | [ ] |
| S2-06c | Add Apache 2.0 LICENSE to miner | miner | [ ] |
| S2-06d | Add Apache 2.0 LICENSE to spawn | spawn | [ ] |
| S2-06e | Add Apache 2.0 LICENSE to compass | compass | [ ] |
| S2-07 | Create NOTICE file with attribution and project description | grove | [ ] |
| S2-07b | Create NOTICE files for blueprint, miner, spawn, compass | all | [ ] |
| S2-08 | Create LICENSING-INTENT.md documenting FSL cloud boundary seam | grove | [ ] |

## Phase 2B: Attribution and Documentation

| # | Item | Repo | Status |
|---|------|------|--------|
| S2-13 | Complete THIRD-PARTY-NOTICES.md with all inspirations + OSS attributions | grove | [ ] |
| S2-14 | Add SPDX license headers to key source files | grove | [ ] |
| S2-15 | Document licensing in README for each repo | all | [ ] |

## Phase 2D: Brand Protection (Future)

| # | Item | Repo | Status |
|---|------|------|--------|
| S2-09 | Register "metafactory" trademark (or establish common-law use) | meta-factory | [ ] |
| S2-10 | Register "Grove" trademark (or establish common-law use) | grove | [ ] |
| S2-11 | Create TRADEMARK-POLICY.md | meta-factory | [ ] |

## Future: FSL Cloud Boundary (When Hosted Product Ships)

| # | Item | Repo | Status |
|---|------|------|--------|
| S2-20 | Apply FSL-1.1-ALv2 to src/worker/ (grove-api) | grove | [ ] |
| S2-21 | Apply FSL-1.1-ALv2 to src/dashboard/ | grove | [ ] |
| S2-22 | Create LICENSING.md mapping directory-to-license structure | grove | [ ] |
| S2-23 | Set up CLA for external contributors | meta-factory | [ ] |

## Dependencies

- Phase 2A is independent -- can start immediately
- Phase 2B depends on 2A (LICENSE files must exist first)
- Phase 2D is administrative -- no code dependencies
- FSL items are gated on hosted multi-tenant product shipping (DD-13 decision)

## Notes

- arc currently has MIT license -- consider upgrading to Apache 2.0 for patent protection (separate decision)
- meta-factory stays proprietary -- it is the marketplace platform, not the tools
- compass may use CC BY-SA 4.0 for content instead of Apache 2.0 (needs decision)

---

*Generated from DD-13 licensing strategy research and council debate.*
