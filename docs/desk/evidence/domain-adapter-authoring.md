# Domain adapter authoring evidence

Node #3377 implements acceptance matrix row A14 from [the staged conformance gates](https://github.com/the-metafactory/cortex/issues/3296).

## Pinned artifacts

The [package and acceptance evidence at commit `94950d81624deafd763384256f60bb99badb022c`](https://github.com/the-metafactory/cortex/tree/94950d81624deafd763384256f60bb99badb022c/docs/desk) preserve the successful first attempt. The package sources and generated backend are committed together.

| Artifact | Location |
| --- | --- |
| Guide example | [Archive package](../examples/domain-adapter/) |
| Blind package | [Ceramic kiln studio package](../examples/blind-domain-adapter/) |
| Exact guide input | [Frozen guide](domain-adapter-authoring/guide-input.txt) |
| Author's instructions | [Session prompt and follow-up](domain-adapter-authoring/author-prompt.txt) |
| Author's account | [Unedited author report](domain-adapter-authoring/author-report.txt) |
| Host result | [Conformance JSON](domain-adapter-authoring/blind-result.json) |
| Regression test | [Authoring guide test](../../../src/conversations/domain-adapters/__tests__/authoring-guide.test.ts) |

The frozen guide's SHA-256 is `c772b2e2bbf533c1ce54b34163c411ee74fe20d6e2f58fed3554b77a2bd60ec5`. The [SDK types at the input base commit](https://github.com/the-metafactory/cortex/blob/9d2fee205fac07b9b10df10b4b668544475298f1/src/desk-sdk/generated/desk-sdk.d.ts) have SHA-256 `9db0dd9409cc0ce32ff47bca5215ef3837413126690dd69004a5feb1b8813d4e`.

The published guide uses the repository's term “principal” for the host's human role. This wording differs from the frozen input. No contract fact changed after the blind author read the guide.

## Experiment result

The author ran in a fresh session with no inherited conversation history. Its only supplied technical inputs were the frozen guide and portable SDK types. It received a new-domain task for kiln destinations and firing records. The author reported no missing contract facts and did not inspect the host, example package, or harness implementation. No correction-and-retry cycle was needed.

The parent ran the production harness after the author returned the package. The first run exited 0. All six rows were conformant: destination listing, a two-page query, poll observations, conversation drafting, confirmed dispatch, and canonical readback. The rows cover all four declared capabilities. The result records one dispatch, one readback, zero network requests, and zero credential requests.

The preserved JSON changes only `packageDir` from the temporary authoring location to the committed package's relative path. A second run against that committed location also exited 0 with the same rows and counts. The synthetic owner records plans and operates no kiln hardware.

The boundary was enforced by instructions, not an operating-system sandbox or a filesystem-access audit. The author report states this limit. The transcript supplied no implementation assistance or harness feedback before the successful run.

No runtime host source or SDK contract changed. The source change is a repository test. The ESLint change excludes the two untyped executable documentation fixture directories, matching the treatment of existing conformance fixtures.

## Reproduction commands

Run these commands from the repository root:

```sh
bun scripts/desk-adapter-conformance.ts docs/desk/examples/domain-adapter
bun scripts/desk-adapter-conformance.ts docs/desk/examples/blind-domain-adapter --json
bun run test src/conversations/domain-adapters/__tests__/authoring-guide.test.ts
```

Both packages pass every declared capability. The repository test passes twice, once per package, and requires all six probe kinds, complete capability coverage, two query pages, and the owner-call and request counts above.

To rebuild either package, run `bun <package-directory>/build.mjs`. To repeat the author's additional checks, run `bun docs/desk/examples/blind-domain-adapter/verify.mjs`. Those direct checks supplement the production harness and do not replace it.

## Full repository check

The required `bun run check` ran once. Lint, duplication, typecheck, vocabulary, SDK compatibility, shippable hygiene, XDG, and branch ancestry passed. The test gate reported 15,339 passes, 72 skips, 201 todos, and one failure.

The failure is `every run > makes no network request and writes nothing outside its own temporary directory` at `src/conversations/domain-adapters/__tests__/conformance.test.ts:128`. Its `ownedTempEntries()` snapshot includes every name beginning with `desk-conformance-`. The concurrently running failure suite creates and removes directories beginning with `desk-conformance-failure-`, so the before and after lists differ.

The same failure reproduced on the unchanged base commit `9d2fee205fac07b9b10df10b4b668544475298f1`, exported with `git archive` into a temporary directory on this host. The base run used the existing dependency installation and the repository's isolated-HOME runner:

```sh
bun run test --parallel src/conversations/domain-adapters/__tests__/conformance.test.ts src/conversations/domain-adapters/__tests__/conformance-failures.test.ts
```

That base run reported 37 passes and the same single failure at line 128. Both diffs showed one failure-harness directory replaced by another. The node SOP requires leaving host failures that reproduce on the base unchanged.

## Close prose

The guide and its tested archive example pass the Desk adapter conformance harness. A fresh author built a ceramic kiln studio adapter using only the guide and portable SDK types. Every declared capability passed without host implementation changes. The [blind package, exact input digests, author report, and result are pinned at `94950d81624deafd763384256f60bb99badb022c`](https://github.com/the-metafactory/cortex/tree/94950d81624deafd763384256f60bb99badb022c/docs/desk). The repository test keeps both packages conformant. Isolation was instruction constrained. No production provider, credential, UI, or cutover claim is made.

The full check has one existing concurrent temporary-directory assertion failure, reproduced on the unchanged base. Every other gate passed.
