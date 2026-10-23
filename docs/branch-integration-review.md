# Feature and auxiliary branch integration

## Target and scope

Reviewed the 11 non-main remote branches of `yousofkakhki/codex-mobile-persian`
against `main` at `777ad3dffd5fa31986bda0d489be55bd4b77bc89` on 2026-10-23.
The integration target is `development`, not `main`. Existing branches are
preserved. Source consolidation does not deploy the application, reapply ACLs,
change sudo policy, or change gateway configuration.

## Branch decisions

| Branch | Reviewed tip | Decision and retained behavior |
| --- | --- | --- |
| `feat/default-yolo` | `46d3089` | Already an ancestor of main. Retain the current `never` / `danger-full-access` defaults and environment overrides. These are Codex policies, not a change to the service's Linux UID. |
| `feat/persian-mobile-enhancements` | `4c80c14` | Already an ancestor of main. Retain main's subsequent UI and per-thread goal-state fixes; no older UI snapshot replaces current source. |
| `fix/all-supported-ultra` | `7bf1799` | Already an ancestor of main. Retain descriptor- and runtime-backed agent-local Ultra admission, provider wire-effort mappings, and later ownership checks. This is not proof of literal gateway wire-Ultra support. |
| `feat/thread-activity-goal-telemetry` | `be23b7f` | Its reviewed feature commits were already cherry-picked onto main and subsequently hardened. Link its history without restoring older activity, goal, reasoning, or pagination implementations. |
| `fix/ninerouter-dictation-transcription` | `3803604` | Same reviewed-history linkage, including the telemetry ancestor. Retain the newer main dictation implementation; isolate its inherited HTTP fixture during this review. |
| `fix/thread-switch-latency` | `831f176` | Main already contains the reviewed cherry-pick and later selection-generation / authoritative-routing fixes. Link ancestry through the public-endpoint branch; preserve current code and A-B-A regression tests. |
| `fix/ninerouter-public-endpoint` | `cb01d4e` | Import the optional secret-backed operations entrypoint. Reconcile endpoint coverage with the endpoint-env branch; retain newer main provider preflight, catalog admission, and thread-switch behavior. |
| `fix/ninerouter-buffer-eacces` | `e9eff63` | Integrate via its endpoint-env descendant: explicit directory permission errors, earlier gateway compaction, and native maximum-context accounting. This reports access problems; it does not grant filesystem permissions. |
| `fix/codex-state59-compatibility` | `316e795` | Integrate via endpoint-env: reviewed state migration 59 and history migration 8 signatures and fixtures. Unknown schemas remain rejected. |
| `fix/ninerouter-endpoint-env` | `b100a46` | Merge its gateway endpoint configuration, dictation override, authenticated catalog discovery, compaction, packaging, permission-error, and schema updates. |
| `maintenance/vps-webui-access-ultra` | `4faabe4` | Merge the isolated maintenance package, sanitized evidence, ACL repair documentation, and manual test instructions. Its rollout guard remains authoritative; merging does not execute maintenance scripts or deploy its staged overlay. |

### Conflict resolution and history linkage

The endpoint-env merge is `85c0bc3`; public-endpoint reconciliation is `1b34b8d`;
maintenance integration is `f689a1c`.

Conflicts in desktop state, endpoint tests, provider documentation, and the manual
thread-switch test were compared explicitly. Main's newer authoritative
config/catalog preflight, stale-selection guards, and expanded regression cases
were retained. Endpoint tests cover synthetic HTTP and HTTPS overrides instead
of a live gateway address.

The history-only merge `5b215f9` intentionally uses an unchanged tree after
reviewing all nine original telemetry/dictation commits against these main
cherry-picks:

| Original | Main equivalent |
| --- | --- |
| `8014f76` | `81ce74b` |
| `e5f0334` | `4add54c` |
| `594882d` | `d92c749` |
| `924ce9f` | `90a4c19` |
| `4112769` | `ddfc3bd` |
| `be23b7f` | `05c1563` |
| `4d3ce94` | `3481332` |
| `c3ad620` | `d2b9f7a` |
| `3803604` | `2b8e92a` |

The tree before and after that merge is
`dd0367c133f8f994c232db47ec0b4b5b69ab7a8c`. Main's later ownership, recovery,
redaction, routing, and dictation hardening is preserved. This is a reviewed
history linkage, not a blanket conflict preference.

## Findings addressed

1. **Inherited-home fixture writes (`2229c9b`).** The dictation HTTP fixture now
   creates a private temporary Codex home, uses a dynamically allocated loopback
   gateway port, restores environment overrides, and cleans up partial setup.
   Its regression check preserves synthetic inherited preferences and auth files
   byte-for-byte. An initial baseline run exposed the old unsafe behavior by
   overwriting existing provider preferences outside the worktree. The original
   preferences have not been recovered; exact restoration remains unresolved.
   Subsequent suites and packaged checks use disposable state. An unchanged
   deployment must not be described as unchanged application preferences.
2. **Stale Ultra capability admission (`ea5c50f`).** Same-size descriptor rewrites
   could collide on filesystem stat identity. Capability admission now compares
   fresh, bounded descriptor snapshots, including a SHA256 of actual bytes,
   before and after the shared runtime metadata read. Truncation or a changed
   snapshot fails closed. The ordinary context-window cache is unchanged.
3. **Blank optional gateway secret (`ab632ee`).** The secret-backed entrypoint
   rejects missing, empty, and whitespace-only secrets before launching the
   application, preserves arguments with `exec`, and never logs the secret.

## Verification

All test artifacts are local and ignored under `output/`; they are not shipped
as runtime configuration. Tests use synthetic credentials and disposable homes.

| Check | Result |
| --- | --- |
| Stable original-main baseline | 1,386 passed, two optional snapshots skipped, two intermittent existing Ultra freshness failures; 93 files. |
| Integrated app suite | 1,406 passed, two optional snapshots skipped, zero failures; 94 files. Includes installed-Chromium template and contrast checks. |
| Catalog-builder Node suite | 34 passed. |
| Isolated maintenance Node suite | 61 passed; no live ACL application or gateway probe. |
| Optional entrypoint Node suite | Four passed with fake readers/apps; no host secret was read. |
| Build | Vue typecheck, frontend build, and CLI build passed with Node 22. |
| CJS/module loading | Source smoke and installed packed-image catalog smoke passed. |
| Migration provenance | Exact upstream migration bytes and SHA384 verified against official source commit `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`. |
| Packaged Docker runtime | Packed app installed with Codex CLI `0.162.1`; missing/malformed auth fallback, synthetic responses, pre-writer Zen-to-OpenRouter switch, and persisted native 401 checked on isolated localhost ports 4192, 4193, and 4194. |
| Packaged browser reload | Native 401 remains visible in light/dark themes with one persisted feedback row, zero duplicate live overlays, and no page errors. Synthetic Zen and OpenRouter replies survive reload at 375x812 light and 768x1024 dark. |

Baseline evidence is the report in the separate stable `777ad3d` worktree.
The earlier interrupted/overlapping baseline report is not evidence.

Exact source module smoke command, run after the build:

```sh
node -e "const a=require('node:assert/strict');const b=require('./scripts/build-ninerouter-catalog.cjs');const n=require('./src/server/runtimeLocalUltra.mjs');a.equal(typeof b.buildCatalog,'function');a.equal(typeof b.extractBundledCatalog,'function');a.equal(typeof n.nativeUltraWireEffort,'function');console.log('CJS catalog/native module smoke: passed')"
```

The Docker image is `codex-mobile-review:development-20261023`, installed from
`brutalstrikedevs-codexapp-0.1.91.tgz` with `@openai/codex@0.162.1`. Container
startup uses `CODEX_HOME=/codex-home` and
`codexapp --port <case-port> --no-password --no-open --no-tunnel --no-login`,
with a fixture preload. The fixture intercepts Node model discovery and provider
transports and routes native auth requests to a local 401 server. Docker's
internal-only network has no external gateway; localhost-only TCP forwarders
provide browser access. No host Codex home, real key, or inference endpoint is
mounted or used. Fetch/browser-blocked port 4190 was replaced by 4192-4194.
These checks do not establish real upstream availability or expired-token refresh
success.

Local browser evidence is `output/playwright/branch-review/report.md`, with exact
URLs, viewports, assertions, screenshot paths, and embedded screenshots. The
synthetic transport fixture, packaged check commands, and machine-readable
results remain in `output/branch-review/` for local audit. No screenshot or test
auth file is included in the published branch.

### Known provider-switch limitation

An additional packaged probe found that a switch after acquiring a writer can
remain deferred: native `thread/unsubscribe` returned `notSubscribed` while
`thread/loaded/list` still contained that writer. The existing main guard refuses
to replace the runtime until writer shutdown is proven. Its implementation is
unchanged by this integration and was not weakened. Pre-writer provider switching
passes; arbitrary switching with a loaded writer is not claimed fixed.

## Performance audit

- Frontend output is identical to main's baseline: the main JS asset is
  569.08 KB (gzip 176.74 KB). The existing >500 KB build warning is unchanged.
  CLI output grows from 725.34 KB to 727.30 KB.
- Fresh capability snapshots perform two asynchronous bounded reads per eligible
  discovery, not per model. A read is capped at 4 MiB and closes its handle on
  every path. On the installed 907,775-byte / 27-model descriptor, 20 read pairs
  measured median 7.725 ms, p95 9.833 ms, maximum 12.842 ms. No inference was
  involved. Runtime config/model discovery remains a shared snapshot.
- No new browser model/config fanout or thread-switch blocking request is added.
  Main's same-provider switching and selection-generation checks are preserved.
  End-to-end production latency was not measured.
- Endpoint overrides add an environment lookup per operation; permission errors
  wrap existing directory creation, without extra successful-path I/O. Compaction
  thresholds and reviewed migration signatures add no background work.
- Catalog authentication is attached only for the configured gateway origin.
  The optional entrypoint reads its secret once per launch. Maintenance tooling
  is separate from application startup and adds no production polling.

## Deployment and operational limits

`main` and the deployed release remain untouched by this source integration.
The initial preferences-file incident above is an explicit exception to state
preservation and still needs authoritative restoration information.

The maintenance package's existing gateway audit did not verify genuine literal
wire-Ultra support, and its rollout guard blocks deploying that overlay. This is
distinct from main's agent-local Ultra policy and reviewed `max`/`xhigh` wire
mappings. Do not remove the guard or advertise upstream Ultra restoration based
on passing local tests.

For repeatable acceptance steps and cleanup boundaries, see the
[integration manual test](../tests/git-worktrees-rollback/development-branch-integration.md).
