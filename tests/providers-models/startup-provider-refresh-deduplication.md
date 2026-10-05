### Startup provider refresh deduplication

#### Feature/Change Name
Load saved provider state before the first startup refresh so deep-linked threads do not perform a second provider-model and rate-limit refresh.

#### Prerequisites/Setup
1. Build the project with `pnpm run build`.
2. Start the WebUI on port 5900 with a saved non-Codex provider configuration.
3. Use an existing thread and note its thread ID.

#### Steps
1. Open the thread directly at `http://127.0.0.1:5900/#/thread/<thread-id>`.
2. Run `PROFILE_BASE_URL=http://127.0.0.1:5900 PROFILE_ROUTE='#/thread/<thread-id>' PROFILE_WAIT_MS=1000 node scripts/profile-browser-runtime.cjs`.
3. Inspect the generated `output/playwright/browser-runtime-profile-thread-*.json`.
4. Repeat on the home route using `PROFILE_ROUTE='/'`.

#### Expected Results
- `duplicateCounts.providerModels` is 1 for direct-thread startup.
- `duplicateCounts.rateLimitsRead` is 1 for direct-thread startup.
- The thread list loads once; the app does not remain on `Loading threads...`.
- Provider models and the selected thread's messages remain available after refresh.
- Any repeated pending-server-requests or project-root-suggestion GETs are inspected separately; these are not provider/rate-limit refreshes.

#### Rollback/Cleanup
- Stop only temporary profiling servers created for this check.
- Leave the persistent systemd WebUI service running.

---
