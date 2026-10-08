### Context-window compaction recovery

#### Feature/Change Name
Gateway model aliases compact earlier instead of postponing compaction to an unverified advertised maximum. An exhausted thread can be compacted through the supported app-server API without deleting its saved transcript.

#### Prerequisites/Setup
1. Run the app at `http://127.0.0.1:4173` with an isolated Codex home and a disposable gateway-backed thread.
2. Generate a model catalog with `node scripts/build-ninerouter-catalog.cjs --binary <installed-codex-binary> --output <protected-catalog.json>` and configure `CODEXUI_MODEL_CATALOG_JSON` for the test server.
3. Retain a protected backup of the disposable thread rollout before recovery. Never use production credentials or modify a production thread for this test.
4. Use a mock provider that rejects oversized requests and accepts smaller requests.

#### Steps
1. Run `node --test scripts/build-ninerouter-catalog.test.cjs`.
2. Inspect an extended-context alias: its advertised context remains unchanged, while its compaction cutoff is no later than the bundled model's native cutoff or 90% of its native window when that cutoff is unspecified.
3. Use the mock provider to produce `contextWindowExceeded` on the disposable thread and wait for the failed turn to finish.
4. Resume only that thread with `thread/resume`, setting `config.model_auto_compact_token_limit` to its generated cutoff and `excludeTurns: true`.
5. Call `thread/compact/start` with the same `threadId`. Monitor that thread's stream for `contextCompaction` completion and a completed turn; the immediate empty RPC response alone is not evidence of success.
6. Send a short verification prompt explicitly forbidding tool calls. Confirm it completes and the measured input context is smaller.
7. Reload the thread and confirm its saved transcript, thread ID, project folder, and selected model remain intact. Confirm other threads and their active turns were not interrupted.

#### Expected Results
- Larger advertised windows do not increase the generated per-model compaction cutoff.
- Explicit bundled cutoffs are retained, smaller gateway windows lower them, and invalid native descriptors fail closed.
- A successful compaction summarizes model-visible history while retaining the saved transcript.
- The next verification turn succeeds without repeating the failed project task or calling tools.
- Recovery stays scoped to one thread; no server restart, archive, rollback, or history-file deletion is needed.

#### Rollback/Cleanup
- Remove only the disposable test thread and isolated test-server state after verification.
- Restore the backed-up catalog if changing the test deployment's compaction policy is no longer desired.
- Retain protected transcript backups until recovery is confirmed; never add them or credentials to Git.
