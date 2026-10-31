# Third-Party Notices

Cortex incorporates ideas and UX patterns from the following open-source projects.

---

## ai-pr-review

- **Repository:** https://github.com/houshuang/ai-pr-review
- **Author:** Stian Haklev (houshuang)
- **License:** MIT

Cortex's AI PR review feature (originally grove G-901, lifted into cortex at
MIG-7) ports UX patterns from ai-pr-review — narrative sequencing,
importance-level indicators, and structured review sections — into native
React components. No code is directly imported; the patterns informed our
implementation.

### MIT License

```
MIT License

Copyright (c) 2026 Stian Haklev

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Note: The ai-pr-review repository declares MIT in its README but does not include a
dedicated LICENSE file. The license text above is the standard MIT license as declared
by the project author.

---

## Provenance

This file was originally maintained at
`github.com/the-metafactory/grove-v2/THIRD-PARTY-NOTICES.md` and lifted into
cortex at MIG-7.12. The grove-v2 repo will be archived at MIG-8.
## Life Balance concept and Balance engine

The balance concept originates with Life Balance, Llamagraphics, 1996–2016. No proprietary Life Balance source code is incorporated. The deterministic core and tests come from Jens-Christian Fischer’s Balance implementation, commit `7fc44936f99f48fe626de74f932bd8a1f207dc85`. The principal authorised its import under Cortex’s AGPL-3.0-only licence in [cortex#2870](https://github.com/the-metafactory/cortex/issues/2870) on 2026-10-31. See [the module notice](src/balance/README.md#licence-and-credit) and the repository LICENSE for the licence text.
