### Startup provider refresh deduplication

#### Feature/Change Name
Resolve saved provider discovery before one initial global catalog refresh. Load deep-linked history after the catalog, retaining the current synchronous routing block and refresh-generation protections.

#### Prerequisites/Setup
1. Use an isolated, disposable frontend fixture or an explicitly authorized local WebUI with a saved non-Codex provider. Do not alter the running service/config/auth to perform this check.
2. Existing thread ID available; profile scripts and dependencies already installed.
3. For automated no-generation verification, run `node_modules/.bin/vitest run src/api/codexGateway.test.ts src/composables/useDesktopState.globalProvider.test.ts`.

#### Steps
1. Open `http://127.0.0.1:<isolated-port>/#/thread/<thread-id>` with the saved provider.
2. Run `PROFILE_BASE_URL=http://127.0.0.1:<isolated-port> PROFILE_ROUTE='#/thread/<thread-id>' PROFILE_WAIT_MS=1000 node scripts/profile-browser-runtime.cjs`.
3. Inspect the profile JSON: count provider-model requests, account/rate-limit refreshes, thread-list loads, and thread resume calls; separate unrelated ancillary GETs and polling.
4. Repeat with the home route; delay discovery via a synthetic network fixture and attempt both new/existing-thread submissions. Verify no turn/start, directory creation, or worktree creation before startup readiness.
5. Delay catalog discovery and overlap provider refreshes using isolated test fixtures, including same-provider endpoint saves. Confirm no stale catalog, provider, or model is usable until the latest refresh completes.
6. Force discovery/catalog failure in the fixture. Confirm catalog error is visible and generation remains blocked; UI provider status is not a substitute for authoritative global config.

#### Expected Results
- One saved-provider discovery and one initial `refreshAll` flow; no independent `onMounted` discovery/refresh race.
- `duplicateCounts.providerModels` and `duplicateCounts.rateLimitsRead` are each 1 for steady startup without concurrent configuration changes.
- Deep-link history resumes only after the authoritative global catalog has completed, avoiding a separate on-demand model refresh inside history loading.
- Global selection remains the default for both new and existing threads. Returned-provider verification, synchronous route invalidation, and refresh-generation checks remain intact.
- Goal reads remain thread scoped and bounded; no generation probes are needed.
- External-auth changes after startup may still trigger their existing authorized refresh and should be counted separately.

#### Rollback/Cleanup
- Restore any fixture-only delayed/error routes and temporary browser storage. Do not change real saved provider/auth/config as cleanup.
- Stop only an isolated server you explicitly started; leave persistent services untouched.

---
