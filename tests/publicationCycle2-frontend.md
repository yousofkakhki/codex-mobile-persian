# Publication cycle 2: duplicate tool restrictions and fork preflight

Scope: `PUB-ULTRA-01-REMAINING-TOOLS-DUPLICATE` and `PUB-ROUTE-01-REMAINING-FORK-PREFLIGHT` only. No permission, Goal, provider-identity, layout, native-writer lifetime, or deployment policy change.

## Prerequisites and containment

- Use a disposable private checkout and its existing dependency tree, Node 22.16.0 or newer. Do not install dependencies or point the fixture at a real provider.
- Before importing bridge/Vite modules, assign private HOME, CODEX_HOME, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME and TMPDIR. Leave CODEX_SQLITE_HOME unset for canonical projection fixtures.
- Run inside a private mount/network namespace with loopback only; bind shared runtime, original source, dependencies, and the final source snapshot read-only. Keep outputs outside the source tree.
- Use synthetic `fetch` responses for provider-models/model-list and thread RPCs. Inspect recorded requests, not a real provider response. The existing independent probes must remain byte-identical.

## Duplicate exact native model: catalog to actual composer

Actions:

1. Run `node node_modules/vitest/vitest.mjs run src/api/publicationCycle2.gateway.test.ts --no-cache --configLoader runner --maxWorkers 2` in the contained checkout.
2. Supply two native `dup-native` rows with Max and Ultra, the first unrestricted and the second `supportsTools: false`, alongside exact provider metadata affirming Responses, tools, Max and Ultra. Repeat with the restrictive row first and with `capabilities.tools: false` in each order.
3. Include a later tools-only restricted duplicate. Compile the unchanged `ThreadComposer.vue` with the Vue SFC compiler, server-render its actual framework code, and collect its real Model/Thinking dropdown props.
4. Control: supply one unique `native-exact` descriptor with native Max and Ultra but no provider tools/API declaration. Also exercise exact provider/native effort intersection and explicitly empty/restrictive provider metadata.

Expected:

- Exactly one model ID and metadata entry; any native tool restriction remains false despite affirmative provider metadata. Duplicate effort evidence does not grant reasoning options; the actual composer disables the restricted model.
- Genuine unique native executor provenance remains selectable with distinct Max and Ultra. `upstreamApi: unknown` and `supportsTools: null` remain unknown, not fabricated wire/tool support.
- Exact effort intersection retains provider order; explicit false/empty restrictions and existing cx/Ultra reviewed-route gates stay intact.

## Both fork acquisition paths during provider refresh

Actions:

1. Run `node node_modules/vitest/vitest.mjs run src/composables/publicationCycle2.desktop.test.ts --no-cache --configLoader runner --maxWorkers 2` in the contained checkout.
2. Load a source thread, start a provider-changed refresh, and defer its configuration read. Invoke both sidebar/summary fork (`forkThreadById`) and response/turn fork (`forkThreadFromTurn`).
3. Repeat while forwarding the fork helper to the actual gateway using synthetic `fetch`; record every RPC method. Settle the catalog refresh before checking recorded side effects.
4. Start each fork with a settled catalog, defer the real fork RPC, replace the routing revision, then settle the old response. Also defer uncached source history for a turn fork, replace and settle the catalog, and settle the old history.
5. Control: with a settled current catalog, invoke both fork kinds through the real gateway and then submit a synthetic next user-started turn.

Expected:

- While catalog/config refresh is invalid, both paths return an empty result without calling the fork helper or sending any gateway RPC. The source remains selected; no rollback or turn is sent.
- In-flight acquisition retains its original routing revision. An obsolete result is not adopted, retried, or reacquired. Turn-fork revision capture includes the awaited history read.
- Each legitimate settled fork produces exactly one `thread/fork`, retains the correct source parameters, selects the returned thread, and allows exactly one next user-started turn. No extra config/catalog read is introduced.
- This is frontend dispatch/adoption evidence, not proof of native writer closure or real provider execution.

## Performance audit

The added native restriction/count pass uses one Map/Set lookup per row before deduplication. Native ID membership, descriptor uniqueness and metadata lookup now use Map/Set instead of repeated whole-array scans. The native normalization phase is O(n + p + total declared efforts), with O(n + p) identity storage. The existing provider-endpoint ID deduplication is unchanged; this statement does not claim its separate algorithm is linear.

Measured contained synthetic run, including Response serialization/parsing:

| Native rows / unique models | Catalog RPCs | Elapsed ms |
| --- | --- | --- |
| 129 / 128 | 1 | 19.78 |
| 513 / 512 | 1 | 18.41 |
| 2049 / 2048 | 1 | 55.32 |

Timing is observational, not a flaky time threshold. Each catalog includes a final restrictive duplicate; restriction and legitimate unique provenance are asserted at every size. Both settled-fork controls recorded one fork RPC, zero added config reads, zero added catalog reads, and one next-turn request. Summary/turn fixture fork times were 84.09/3.74 ms; shared-worker scheduling and first-import costs are included. No new fanout, retry loop, payload expansion or catalog cache is added. Pending-refresh blocked requests and stale-result rejection are asserted separately. Live/browser timing was not measured; layout/theme CSS and the composer source are unchanged.

## Final acceptance and rollback

- Replay all 29 intact independent probes, then both new regressions and the full canonical suite without filtered skips. Supply the genuine pinned runtime snapshot and gateway catalog to execute all 88 runtime-metadata assertions.
- Run canonical `vue-tsc --noEmit`, server `tsc -p tsconfig.server.json --noEmit`, frontend Vite build and canonical tsup build with output directories relocated to private scratch; use `--configLoader runner` for Vite. Smoke the shipped CommonJS helper's exports and built public CLI `--help` without starting providers.
- Compare all preexisting test/manual/protected hashes to the baseline, accounting only for the already-authorized baseline auth-middleware reorder. Stage only the two runtime files, two new regressions and this document.
- Cleanup removes only owned scratch fixture/log/build files. A rollback is a reviewed revert of the scoped local correction commit in a disposable checkout, not a reset/history rewrite, provider retry, production restart or live thread repair. Preserve original probes, source, native links and active writers.
