### NineRouter model metadata, reasoning and runtime context

#### Feature/change
Preserve exact provider catalog IDs, context/output limits, reasoning choices, and configured effective context without changing global provider routing, thread resume or Goal budget semantics.

#### Prerequisites/setup
- Use only an explicitly authorized isolated test instance and disposable Codex home; do not point these checks at a production service.
- Supply a fixture Responses provider catalog with `cx/gpt-6.1-sol`, `cx/gpt-6-sol[1m]`, explicit reasoning levels, and a non-reasoning model. Use fixture limits, not name-based assumptions.
- For browser checks use the project test instance at `http://127.0.0.1:4173`. Do not restart unrelated listeners. These browser/live-generation checks were not executed by this integration.

#### Actions
1. In light theme, open the model dropdown. Compare ID, context and max output with the fixture catalog. Repeat in dark theme; badges must use the existing dropdown styling.
2. Select a model declaring `low`, `medium`, `high`, `xhigh`, `max`. Thinking must exclude None, Minimal and Ultra. Choose Max and inspect the offline turn payload for the exact ID and effort in default and Plan collaboration settings.
3. Select a model with `capabilities.reasoning: false`: Thinking is disabled and no explicit effort should be submitted. An explicitly empty supported effort array is also restrictive. Missing/empty SDK metadata retains legacy defaults.
4. For a recognized `cx/` family without explicit levels, inspect the model description: Codex-family reasoning fallback is labeled as inferred, not provider-declared. Unrecognized models do not acquire family-specific levels.
5. Replay saved usage with a measured window different from `configuredContextWindow`. The meter shows `Last turn … / … · Next …`; the tooltip explains a previous-turn measurement or per-thread override. Measured capacity still controls the percentage. When runtime capacity is absent, advertised capacity is labeled an estimate.
6. Replay usage equal to the configured capacity: the mismatch warning disappears. A stream timestamp alone must never be treated as proof of a fresh turn or provider switch.
7. Refresh the page and confirm literal `[1m]` and `-review` aliases are unchanged. Start two catalog refreshes; resolving the older last must not overwrite current metadata or reasoning choices. Submitting during a deferred provider refresh remains blocked.
8. With separate authorization, build an opt-in private catalog: `node scripts/build-ninerouter-catalog.cjs --binary <fixture-or-installed-native-binary> --output <protected-catalog.json> --models-url <authorized-fixture-models-url>`. It retains bundled instructions/tool descriptors and original models, sets alias-specific context/max-context, uses supported default effort, and writes atomically with mode 0600. Unknown formats/templates and provider errors fail without replacing prior output.
9. For the isolated service only, set `CODEXUI_MODEL_CATALOG_JSON=<protected-catalog.json>`. The app-server args include that path, not a global context/compaction/provider override. Optional metadata reads are asynchronous, coalesced for the same file revision, single-entry cached, invalidated by path/stat identity, and bounded to 4 MiB.
10. Hot rejoin is not proof that Codex switched provider. Keep returned-provider verification and cold/hot compatibility checks separate; do not modify live thread files or restart an app-server as part of this metadata check.

#### Expected results
- Metadata is attached to the same successful Responses `/models` fetch: no additional upstream request, no fabricated configured-model metadata, no bypass of strict custom discovery.
- Explicit reasoning declarations take priority; generic `thinkingEffortSupported: false` is not substituted for `capabilities.reasoning: false`.
- Effective configured context uses each catalog model's percentage (default 95) and supported global context override capped at its maximum. Advertised context alone is not an execution guarantee.
- Model menu metadata join is linear. Automated 300-row fixture reads 600 ID properties, versus 45,151 before indexing. Provider normalization remains a linear pass plus bounded effort-list processing.
- Focused offline tests cover metadata, filesystem bounds/coalescing, strict discovery, global-provider refreshes and actual composer SSR rendering. Theme/browser, authenticated provider access and full-capacity generation remain unverified until authorized.

#### Rollback/cleanup
- Restore prior selected model/effort; remove only disposable test threads/catalog/home.
- Remove the opt-in catalog variable from the isolated test service when reverting. Do not change live config/auth, service units, Goal token budgets or stored usage.
- Leave production and unrelated development services untouched.
