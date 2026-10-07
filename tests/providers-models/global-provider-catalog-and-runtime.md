### Global provider catalog and runtime regression verification

#### Feature/Change Name
Global catalog refresh, compatible existing-thread resume, and safe app-server replacement.

#### Prerequisites/Setup
Use an isolated snapshot and disposable provider/auth fixtures. Never mount real `CODEX_HOME`, auth, or history. Block real generation. Redirect Vitest/Vite caches outside shared dependencies.

#### Actions
1. Run focused globalProvider, providerModelsRoute, globalProviderRouting, archive, and lifecycle tests, full unit suite, frontend typecheck/build, and CLI build.
2. Exercise Custom endpoint Save on an old OpenAI thread against a models-only fixture. Inspect real composer options; reload in dark theme.
3. Replay hot/cold resume with network disabled. Assert cold effective provider change; hot mismatch must be rejected before a turn.
4. Replay retired stdout interleaving, stale initialize callbacks, and dispatch across child replacement. Confirm no stale state overwrite, no duplicate initialize, and pending cleanup after deadlines.
5. For packaged provider/auth matrix use separate homes for no auth, invalid/expired synthetic auth, malformed auth, and Zen-to-OpenRouter switch. Record config/status/catalog plus intercepted errors after reload. Do not label real generation tested from a stub.
6. Hold config/read after a provider save and send from existing and new-thread composers before releasing it. Repeat with two overlapping saves, releasing the older refresh first. Routing/catalog selections clear synchronously; pending sends fail closed without thread/resume, thread/start, or turn/start. After the latest catalog resolves, an existing-thread send uses only the latest provider and its advertised model.
7. Set config-only custom/custom_endpoint/custom-endpoint providers while free-mode state is Codex. For each alias, replay upstream /models HTTP502, empty HTTP200, an advertised non-Ggh model, and advertised literal Ggh. Required discovery rejects unavailable/empty catalogs and never injects unadvertised Ggh; config's literal Ggh remains unchanged, and upstream-advertised Ggh remains selectable.

#### Expected Results
Focused/full tests pass with real build outputs. Catalog failures cannot send stale models. Initialize times out after 30 seconds; RPC after 120 seconds, with cleanup and no automatic side-effect replay. Candidate equals working-source baseline plus only fix delta. Existing Goal/auth behavior remains baseline, not scope.

#### Rollback/Cleanup
Remove only exact disposable fixture names. No DB rewrite, lock deletion, publication, credential operation, or production restart is implied. Promotion requires a separate approved baseline comparison.
