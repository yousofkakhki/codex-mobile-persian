# Codex Mobile verified-ultra repair

This maintenance repository preserves the installed 0.1.91 build and applies a
small, hash-checked release overlay. It is not a rebuild from upstream `main`.

No credentials, chat contents, private keys, or raw model reasoning are stored.
Gateway probes use one fixed harmless prompt per exact candidate route, no tools,
no response storage, a requested 512-output-token limit, and a 60-second deadline. A route
must return a completed response with `reasoning.effort: ultra`; HTTP 200 alone
does not establish support. Unverified routes remain unavailable.

## Current deployment blocker

The five successful GPT-6 routes normalize `ultra` to **max** in the installed
9Router executor. The six older Sol/Terra routes retain `ultra` in the executor
but their one authenticated probe per exact route returned HTTP 400. Therefore
**zero routes are verified**, and the candidate release must not be deployed as
an ultra restoration. See `evidence/gateway-audit.json` and
`evidence/ultra-capabilities.json`.

The same router also strips `max_output_tokens`. The probe requested a limit of
512; that is not an enforced upstream cap. The five completed probes consumed
5–18 reported output tokens each. No further inference is sent automatically.
The initial unauthenticated attempts returned 401 before inference; their
separate audit record is retained as `evidence/unauthenticated-preflight.json`.

Changing the gateway's effort mapping is outside this WebUI-only repair and
requires a separate decision. The live release, service, and gateway remain
untouched. The build script records `deployable: false` when no route is verified.

The original release is retained. Rollout must wait until **all** loaded threads
are idle, including the maintenance conversation. Never use the installation's
rollback script: that script disables the application rather than reverting a
release. Release rollback only switches the `current` symlink and restarts the
service, leaving state and privilege settings untouched.

## Implemented overlay

- Effective model capabilities drive the composer and effort validation; verified
  exact-route selections survive refresh/resume without enabling other aliases.
- Only read-only `config/read` and `model/list` calls receive an eight-second
  overall deadline. Cancellation removes pending entries and ignores late replies;
  normal long-running operations are unchanged.
- Provider discovery has a 30-second cache, single-flight refresh and five-second
  retry backoff. A last-good catalog is reused only under the same configuration.
  Cold failures return HTTP 503 with `PROVIDER_MODELS_UNAVAILABLE`.
- Hash-checked anchors patch the preserved compiled artifacts. New content-addressed
  frontend and service-worker references prevent stale shell assets. The baseline
  frontend asset remains in the candidate for rollback and existing clients.
- Release integrity checks compare the full baseline tree, file modes, symlinks
  and checksums. The read-only rollout guard also requires matching integration
  evidence, verified non-downgraded gateway routes and idle loaded conversations.
  It never changes a release symlink or restarts a service.

The maintenance code is local to this repository. No upstream push is performed.
The candidate is recorded in `.work/build-result.json`; `.work/` is not committed.
The gateway probe is deliberately separate from builds and tests, and refuses
to repeat existing authenticated evidence automatically.

## Validation on 2026-10-23

- 52 unit tests passed; report: `evidence/unit-tests.xml`.
- 10 full-server integration checks passed in a separate network namespace,
  with fixture Codex/gateway processes, no real credentials and no real inference.
  This covers the actual HTTP-served assets, RPC bridge, timeout/late-response
  handling, HTML 502 fallback, configuration invalidation and cold HTTP 503.
- All 3,218 baseline release entries compared successfully; 2,803 candidate file
  checksums verified. The original asset and runtime model catalog are unchanged.
- The read-only rollout check passed integrity and correctly refused rollout
  with exit status 2 because zero gateway routes passed genuine-ultra verification.
- Production remained on `replica-20261020-1f48eec6`, with service PID 92187,
  `NRestarts=0`, and `NoNewPrivileges=no`. Explicit `sudo -n id -u` returned 0.
  Stored settings and service launch overrides remain `never` and
  `danger-full-access`; the default model remains `cx/gpt-5.6-luna`.

A final read-only live `config/read` request timed out after ten seconds; this is
not a successful runtime-policy check and is not claimed as repaired in production.
The original service has not received the staged timeout/fallback fixes. Earlier
read-only thread checks reported two active conversations; no conversation was
resumed, interrupted, changed or restarted during this repair.

## Reproduce without deployment

From this directory:

```sh
task_node=/opt/codex-mobile/current/runtime/bin/node
"$task_node" --test test/*.test.mjs
"$task_node" scripts/build-release.mjs
sudo -n unshare --net "$task_node" scripts/integration-test.mjs
"$task_node" scripts/verify-release.mjs
"$task_node" scripts/check-rollout.mjs
```

The last command is expected to exit 2 while blocked. None of these commands
deploys to production or performs real model inference. Do not rerun the separate
probe script without a new decision about gateway support and output limits.
