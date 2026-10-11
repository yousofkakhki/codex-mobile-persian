# Publication cycle 1: bridge safety regressions

Scope: PUB-SRV-01, PUB-SRV-02, PUB-SRV-03, PUB-GOAL-01 only.

`src/server/codexAppServerBridge.publicationCycle1.test.ts` transpiles the exact private `AppServerProcess` body into a VM. It does not replace initialization or rewrite class source. Child stdout/stdin, configuration and timers are synthetic. Pagination additionally exercises the real read-only SQLite projection inspector against hash-checked official-migration fixtures. No real Codex child, provider request, credential or live state is used.

## Required behavior

- **PUB-SRV-01:** A new child uses its own post-start permission epoch, not the retired child's closure epoch. Initialization must complete in that same generation. An acknowledged native acquisition protects the actual returned writer ID even when caller validation rejects. ACK then completed close releases ownership; close then ACK and late success after caller timeout cannot make an unclosed acknowledged writer disposable. Permission intent is not promoted across an invalidated epoch.
- **PUB-SRV-02:** Unsubscribe ACK removes subscription membership, not writer lifetime. Until matching completed `thread/closed`, hot reads retain acquisition metadata, per-dimension explicit approval/sandbox intent and staged-choice ordering. They issue no native resume or unsubscribe, do not switch provider, and do not manufacture a subscription or direct-mutation permit. A later accepted turn choice supersedes older staging even without subscription membership. A completed close clears retained state; a replacement child also starts with fresh state. Existing direct-mutation ownership checks remain unchanged.
- **PUB-SRV-03:** Initial page fields are restricted to pinned V2 `limit`, `sortDirection` and `itemsView`; nested identity/cursor/unknown fields are not forwarded. Hot pagination fixes outer `threadId` last and reinspects that exact projection after the summary await. Cold acquisition uses the same page whitelist. Genuine unsafe checkpoints reject before native read, with database and rollout hashes unchanged.
- **PUB-GOAL-01:** Native 0.154 V2 `ThreadStatus.type=active` permits only an owned existing Goal's status-only pause (including an unchanged objective stripped from the editor payload). Legacy `inProgress` compatibility remains. Objective/budget/activation/completion/clear mutations still require idle. Only the actual active-pause exception admits nondecreasing native usage during an existing turn's flush; idle edits, budget writes and creation still require exact accounting preservation. Identity, objective, total cap and creation identity stay exact; decreasing accounting rejects without retry/repair. The lease and one-use native write permit remain held through fresh post-read, and owner authorization/confirmation/finite budgets are unchanged.

## Immutable reviewer witness handling

The original independent `carried-server-safety.red.cjs` and `carried-server-probes.cjs` remain byte-preserved outside this repository. Before source edits, the original safety assertions fail all four intended behaviors and the observational script reproduces all four defects.

After the writer-lifetime correction, the original safety script's rejoin fixture replies to its old last `thread/resume` instead of the newly dispatched read-only `thread/read`. Its original exit is retained as evidence: three assertions pass, one reports a pending synthetic call. Do not send an unnecessary native resume merely to satisfy that stale response seam. The versioned private harness changes only that response dispatch selection; safety assertions are unchanged, and its diff and hashes are recorded separately. Canonical hot-read, permission, epoch and ownership regressions independently validate the correction.

## Verification isolation

Use the existing dependencies without installation, the verified Node 22.16.0 executable, `vitest run --no-cache --configLoader runner`, and `vue-tsc --noEmit`. Set the genuine `CODEXUI_TEST_RUNTIME_SNAPSHOT` and `CODEXUI_TEST_GATEWAY_CATALOG` fixtures for the gated catalog cases. Unset `CODEX_SQLITE_HOME` for tests that create their own projection home. Use private HOME/CODEX_HOME/XDG/TMPDIR, unshared mount/network namespaces and read-only shared runtime/project mounts. For Chromium fixtures, supply the installed executable and a short scratch TMPDIR: Unix-domain socket paths cannot fit under a deeply nested evidence path. Keep each run below 50 MiB and the free-space floor above 2 GiB; never recursively change native-created modes/ownership.

Passing source tests is not main-merge, deployment, real-provider execution, native lifecycle confirmation or global publication approval. Fresh parent exact-tree review remains required.
