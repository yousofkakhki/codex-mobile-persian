### Global providers across Zen, Codex, OpenRouter, and custom endpoints

#### Feature/Change Name
Settings selects one global provider for new and existing threads. Stored `modelProvider` is historical metadata, not a routing override.

#### Prerequisites/Setup
1. Use a disposable `CODEX_HOME`, a models-only local fixture, and synthetic generation transport. Never copy a real account or use billable generation.
2. Start an isolated packaged app or `CODEX_HOME=<fixture-home> pnpm run dev --host 127.0.0.1 --port 4173`.
3. Seed an old OpenAI thread and distinct provider catalogs. Include configured literal `Ggh` absent from the custom upstream catalog.
4. Block outgoing generation; capture intercepted `thread/resume` and `turn/start` without forwarding generation.

#### Steps
1. Open the existing thread and verify saved history renders in light theme.
2. Switch global Settings from Codex to Zen, then OpenRouter. Reopen old threads and verify only the globally selected provider's models appear.
3. Save a custom endpoint on an old OpenAI thread. Verify custom catalog refresh without stale ChatGPT models or injected `Ggh`. If upstream returns `Ggh`, keep its exact spelling.
4. Capture an intercepted send: `thread/resume` must carry current global `modelProvider` and a catalog-compatible `model`; its effective returned provider must match before `turn/start`.
5. Save another endpoint for the same provider. Repeat on hydrated threads: invalidate routing caches, keep history bounded/cached.
6. Reload and repeat menu/history checks in dark theme.
7. Fail catalog discovery or return empty. Verify visible error, no successful stale catalog, and blocked sends until recovery.
8. Simulate a hot subscribed thread ignoring overrides or another process owning its writer. History remains readable; a clear provider/writer error blocks wrong-provider sends. Never remove locks or edit the database.
9. Queue a message: current config provider/model overrides precede the turn; mismatched effective provider restores its queue item rather than continuing.

#### Expected Results
- Existing and new threads use global Settings for catalog and routing; no manual per-thread change.
- Aliases `custom`, `custom_endpoint`, and `custom-endpoint` behave consistently.
- Save disposes the old app-server. Retired output/initialization cannot corrupt its replacement.
- Equivalent resume requests coalesce; paging stays bounded; active-writer protection is preserved.
- No custom retry hard-codes `gpt-5.4-mini` or silently switches to OpenAI.
- Assert effective top-level `modelProvider`, not just resume HTTP success.

#### Rollback/Cleanup
Stop/remove only exact disposable fixture containers, network, and homes. Do not alter production state.
