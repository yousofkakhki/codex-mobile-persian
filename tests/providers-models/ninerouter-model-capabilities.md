### NineRouter advertised model capabilities

#### Feature/Change Name
Preserve provider context/output metadata and restrict reasoning choices to supported levels, including extended-context aliases.

#### Prerequisites/Setup
1. NineRouter is available with its `/v1/models` catalog.
2. Run the current checkout at `http://127.0.0.1:4173` with NineRouter selected.
3. Use a disposable thread for any prompt submission; do not change an active production thread.

#### Steps
1. Open the model menu in light theme and inspect `cx/gpt-6.1-sol` and `cx/gpt-6-luna[1m]` tooltips.
2. Compare context/output numbers with the live NineRouter catalog, not with model-name assumptions.
3. Select Sol and open Thinking. Confirm Low, Medium, High, Extra high, and Max are offered; None, Minimal, and Ultra are not.
4. Select Max and verify the turn/start payload carries the exact selected model ID and `max` in both effort and collaboration-mode settings.
5. Select a model with `capabilities.reasoning: false`; confirm Thinking is disabled and no explicit effort is sent.
6. Repeat the model menu and Thinking checks in dark theme.
7. After token usage arrives, compare the runtime context window with the catalog. When runtime supplies a limit, the context meter must use it even if the provider advertises more; advertised capacity is not an execution guarantee.
8. Refresh and confirm the selected model remains intact, including its literal `[1m]` suffix.
9. For execution-side catalog integration, run `node scripts/build-ninerouter-catalog.cjs --binary <absolute-installed-native-codex-binary> --output <protected-catalog.json>` and set `CODEXUI_MODEL_CATALOG_JSON` for the WebUI service only. Restart it and inspect `model/list`; exact cx aliases must appear alongside bundled models.
10. Regenerate the catalog after upgrading Codex or changing NineRouter's advertised models. Extraction uses the installed binary's bundled descriptors and fails closed when that binary format changes; it never downloads replacement instructions automatically.
11. Reopen a thread whose last turn used the old 258,400-token limit. With Sol selected and a configured 997,500-token window, confirm stats say `Last turn … / 258k · Next 998k`; refresh and confirm the distinction persists.
12. On a disposable thread, receive a new `thread/tokenUsage/updated` event with the configured window. Confirm the historical warning disappears and the normal usage percentage uses the live window. Do not rewrite recorded usage or submit a production prompt just to test this.

#### Expected Results
- `/codex-api/provider-models?provider=ninerouter` includes normalized `models` metadata, not just IDs.
- Catalog limits are preserved exactly. At inspection time Sol advertised 1,050,000 context / 128,000 output, and Luna `[1m]` advertised 872,000 / 128,000; verify current values when retesting.
- Explicit supported effort lists take precedence. NineRouter's generic `thinkingEffortSupported: false` conflicts with its Codex executor, so inspected cx-family fallbacks are explicitly labeled `codex-family-fallback`, not presented as upstream declarations.
- No hard-coded context increase or global Codex compaction override occurs.
- The opt-in catalog gives each supported cx alias its advertised context and max-context limit, preserving Codex's instructions and built-in compaction policy. The inspected runtime reports 95% effective capacity: Sol 997,500 and Luna `[1m]` 828,400. This has been exercised only against a local mock Responses endpoint, not a full-capacity upstream request.
- No additional upstream catalog requests are needed for metadata normalization.
- `configuredContextWindow` is read from the WebUI's configured runtime catalog (and any global context override), not guessed from advertised capacity. Catalog reads are asynchronous, coalesced, and invalidated by path/mtime/size changes.
- Replayed usage remains a last-turn measurement. Its stream delivery timestamp does not prove a fresh turn used the reported limit. Different selected-model configuration is shown separately until a new usage event confirms it; per-thread overrides may still differ.

#### Rollback/Cleanup
- Restore the prior selected model and reasoning effort.
- Remove only disposable test threads.
- Leave production systemd and unrelated dev services running.
- To disable the deployment-specific catalog, remove `/home/hermes/.config/systemd/user/codex-mobile.service.d/model-catalog.conf`, run `systemctl --user daemon-reload`, and restart `codex-mobile.service`. Do not edit credential files for this rollback.

---
