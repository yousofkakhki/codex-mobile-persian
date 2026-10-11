# Audited native local Ultra and strict custom metadata

## Prerequisites and scope
- Pinned reviewed Codex CLI 0.154.0 and a private, reviewed native catalog supplied explicitly to `scripts/build-ninerouter-catalog.cjs --native-catalog <reviewed-native-catalog.json>`.
- Audited literal NineRouter Responses route on `http://127.0.0.1:20128/v1`. The source manifest records routing bindings only; it never grants reasoning support without native and effective-runtime evidence.
- Explicit supported opt-in `CODEXUI_MULTI_AGENT_V2=true`, which adds only `-c features.multi_agent_v2=true` to the launcher. Actual `config.features.multi_agent_v2 === true` is mandatory; a filename or environment flag alone is insufficient.
- Disposable verification home and network-isolated metadata/transport only. No provider credentials, real generation or production restart is required. Keep native instructions, private catalog files and generated runtime artifacts out of Git.

## Reviewed binding matrix
All rows additionally require a unique, valid native V2 descriptor explicitly advertising Ultra, a supported non-Ultra default, and exact same-ID runtime `model/list` confirmation of Ultra and its resolved wire effort.

| Advertised literal ID | Exact native descriptor | Reviewed Ultra wire effort |
| --- | --- | --- |
| `cx/gpt-6.1-sol` | `gpt-6.1-sol` | `xhigh` |
| `cx/gpt-6-astra` | `gpt-6-astra` | `xhigh` |
| `cx/gpt-6-astra[1m]` | `gpt-6-astra` | `xhigh` |
| `cx/gpt-6-sol` | `gpt-6-sol` | `max` |
| `cx/gpt-6-sol[1m]` | `gpt-6-sol` | `max` |
| `cx/gpt-5.6-sol` | `gpt-5.6-sol` | `max` |
| `cx/gpt-5.6-sol[1m]` | `gpt-5.6-sol` | `max` |
| `cx/gpt-5.6-sol-review` | `gpt-5.6-sol` | `max` |
| `cx/gpt-5.6-terra` | `gpt-5.6-terra` | `max` |
| `cx/gpt-5.6-terra[1m]` | `gpt-5.6-terra` | `max` |
| `cx/gpt-5.6-terra-review` | `gpt-5.6-terra` | `max` |

The shared validator resolves metadata exactly as the pinned CLI: supported non-Ultra `multi_agent_reasoning_effort`, otherwise supported Max, otherwise last non-Ultra effort. Malformed declarations fail closed. Native `supports_reasoning_effort_updates=false` is preserved, not a selection veto: the pinned CLI accepts literal Ultra with proactive policy for these two 5.6 descriptors. Max remains a separate selection even when Ultra resolves to the same wire effort.

Unknown or unaudited suffixes, `Ggh`, the Luna routes, 5.5 routes, daybreak/reserve/codex-auto-review and the OpenRouter route cannot gain local Ultra from names, family defaults or provider effort lists. Existing unrelated provider-wire reasoning is not reclassified as local support.

## Actions and expected results
1. Fetch custom provider aliases and no-query discovery. IDs and metadata come from one payload, with no default injection or duplicate GET. For all eleven eligible IDs the consumer performs one catalog read and one shared runtime snapshot, never a per-model RPC fanout.
2. Read actual pinned `config/read` and `model/list` from the generated private multi-model catalog. Assert exact provider, catalog path, Responses protocol and audited endpoint; feature V2 must be true. Each eligible exact ID exposes distinct Ultra with `reasoningSource=codex-runtime-catalog`. Without explicit provider efforts, derive non-Ultra options from the intersection of the exact native descriptor and runtime row rather than the legacy family fallback, retaining Astra's confirmed Max. Explicit provider effort lists remain restrictive and are not expanded. Missing V2, unsupported runtime wire effort, partial/duplicate/malformed runtime rows or cross-provider evidence withhold Ultra.
3. Exercise every explicit upstream effort field together. Intersect all declarations; empty/malformed lists, reasoning=false, ambiguous duplicate IDs, or omission of the native resolved wire effort deny Ultra. Absent provider lists are unknown, not restrictive; generic `thinkingEffortSupported=false` is not explicit reasoning=false.
4. Remove Ultra/V2 or corrupt the native descriptor/default. Duplicate or malformed descriptors deny only their exact model; valid independent models remain eligible. A structurally invalid native envelope or no valid eligible descriptors prevents builder output. Never fall back to a family descriptor for an audited ID whose native descriptor fails validation.
5. Change provider, endpoint, catalog identity or process generation while awaiting discovery, including warm cache and cold-start races. Quarantine/deferred configuration invalidates evidence without disposing a writer; arbitrary provider spelling/case stays exact except documented custom/custom_endpoint/custom-endpoint aliases.
6. Verify actual composer/guarded handler tests forward literal `ultra` unchanged; no frontend relabel to Max or xhigh. Preserve native roles, instructions, tools and all unrelated descriptor fields; only literal alias/display/context/protocol and explicitly restricted effort choices may change.

## Legacy threads and release approval
- Resumed/forked V1 histories retain their historical runtime by default. Global model/list advertisement alone does not prove proactive delegation on old threads.
- The supported process-wide V2 override takes precedence for subsequent turns without rewriting prior history/database. Previously audited exact 6.1 Sol legacy controls distinguish Ultra policy from wire xhigh; fresh synthetic Max/Ultra controls for all five native descriptors distinguish proactive from explicit-only policy, including Ultra wire max.
- These are network-isolated transport proofs, not real provider generation. Preserve the pinned CLI, provider identity, sandbox/approval/memories policies, ownership/quarantine guards and budget/schema fixes.
- Obtain separate approval before production flag/catalog replacement or a backend restart. Source verification is not deployment.

## Cleanup and rollback
Remove only disposable homes/catalogs. Preserve live config, services, databases and active writers. Apply/revert only the fix-only reviewed source patch; do not publish private catalogs or generated bundles.
