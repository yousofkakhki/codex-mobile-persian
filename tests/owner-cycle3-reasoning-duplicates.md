# Owner cycle 3: exact-ID native reasoning restrictions

Scope: `PUB-ULTRA-01-REMAINING-REASONING-DUPLICATE` only. This is one owner-authorized additional fix, not a reset of the two exhausted automatic cycles. Publication, deployment, restart, provider generation and a further fix cycle remain unauthorized.

## Contract

- Collect native effort-declaration presence and explicit top-level/nested reasoning denials before exact-ID deduplication. A missing first row must not erase later false, empty or malformed declarations.
- Keep duplicate affirmative rows nonaffirmative under the existing unique-count guard. Keep all-missing rows unknown; provider declarations remain unchanged when native reasoning is entirely missing.
- Preserve genuine unique native executor provenance without inventing wire API or tool support. Max and Ultra remain distinct. Preserve provider intersection/order and explicit provider restrictions, exact ID separation, unaudited cx Ultra denials, duplicate-tool restrictions and fork preflight behavior.
- Use indexed Maps/Sets and the existing two-pass normalizer; do not scan the whole catalog repeatedly.

## Automated witnesses

`src/api/ownerCycle3.reasoningDuplicates.test.ts` compiles the unchanged real ThreadComposer SFC and observes its real dropdown props after the real gateway normalizer. Only peripheral components/platform APIs and catalog transport are fixtures. It covers both row orders, missing and affirmative peers, ten explicit false/empty/malformed declarations, duplicate affirmative controls, all-missing unknowns, genuine unique provenance and Max/Ultra, provider ordering/restrictions and literal ID separation.

Canonical command, using already installed dependencies:

```sh
node node_modules/vitest/vitest.mjs run src/api/ownerCycle3.reasoningDuplicates.test.ts --no-cache --configLoader runner
```

The exact final test bytes were run before changing runtime source: 56 executed, 42 passed, 14 failed, zero skipped. The unchanged final test then passed 56/56. The initial pre-runtime test draft had an incorrect composer-order expectation; it was corrected to the unchanged composer's standard order and replayed RED before implementation. Provider metadata order is asserted separately.

The external immutable six-case actual-composer witness is retained byte-identically in a private sibling `probes`/`tree` harness. It reproduced 3 passes/3 failures/zero skips before implementation and passed 6/6 afterward. Its SHA-256 is `7871b9469a243bd0653265cf2f50dea4d727d3adb703dd2ba8f8288061f2d077`.

## Gate discipline

Run under minimum Node 22.16.0 with synthetic private HOME/CODEX_HOME/XDG/TMPDIR established before imports, no CODEX_SQLITE_HOME override, no external network routes and shared source/runtime/dependencies mounted read-only. Supply the existing runtime/catalog snapshots and existing Chromium path; do not install anything. Use a short scratch TMPDIR because Chromium singleton UNIX sockets cannot fit under the deeply nested report path. Keep build outputs private, not in repository dist directories. Invoke executable CLI only with `--help`; the CJS help probe additionally forbids child-process functions. Check library CJS exports separately.

Full/minimum-Node, original 29 independent probes, prior 19 second-cycle regressions, 32 catalog tests, canonical `vue-tsc --noEmit --incremental false`, both builds and help/library smoke gates are recorded in the hashed private worker report. The server-only tsconfig's 13 DOM-missing diagnostics are baseline-identical; adding DOM libs on the command line passes without editing a config.

A passing worker report is not independent publication acceptance. Fresh exact-commit review remains required; no main/push/live action is performed by this cycle.
