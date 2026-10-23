### Feature/Change Name

Reviewed feature/auxiliary branch consolidation into `development` without a
production deployment or replacement of newer main implementations.

#### Prerequisites/Setup

- Read [the branch review](../../docs/branch-integration-review.md), including the
  preferences-file incident, source/main mappings, and deployment limitations.
- Use a clean integration worktree and inspect all other worktrees with
  `git worktree list --porcelain`. Preserve unrelated changes and branch refs.
- Use Node 22, compatible installed dependencies, and disposable test state.
- Run app suites inside an isolated container or network namespace with an
  explicitly private `CODEX_HOME`, no production home mounts, and no inherited
  provider credentials. The original-main HTTP fixture is unsafe with an
  inherited service home and fixed gateway port; never run that baseline against
  the live environment.
- For packaged provider checks, install the packed tarball and Codex CLI in a
  disposable image. Use synthetic provider/auth transports on an internal-only
  Docker network. Reserve allowed localhost ports such as 4192-4194 after
  inspecting listeners; 4190 is blocked by browser/Fetch unsafe-port rules.
- Do not stop or reuse production listeners or the persistent 5173 server.

#### Exact Actions

1. Refresh remote heads:
   `git fetch origin '+refs/heads/*:refs/remotes/origin/*'`. Run `git status` and
   confirm no unresolved merge/rebase state. Record `git rev-parse origin/main`
   and the reviewed branch tips before changing any target.
2. For every tip in the review table, run
   `git merge-base --is-ancestor <tip> development`. Each must exit zero. Compare
   refreshed remote refs with that table; a newly advanced branch requires a new
   review, not an ancestry assertion against only its old tip.
3. Run `git diff --exit-code 5b215f9^1 5b215f9`. It must be empty. Inspect the
   nine source/main mappings in the review instead of treating a no-content
   merge alone as evidence of feature equivalence.
4. In the disposable test environment, run `pnpm run test:unit`,
   `node --test scripts/build-ninerouter-catalog.test.cjs`,
   `node --test scripts/codex-mobile-ninerouter-entrypoint.test.cjs`, and
   `node --test maintenance/vps-webui/test/*.test.mjs`.
5. Run `pnpm run build` and the exact CJS/module smoke command in the review.
   Pack with `pnpm pack --pack-destination <artifact-directory>` and build an
   image installing that tarball plus the pinned Codex CLI. Require the installed
   `scripts/build-ninerouter-catalog.cjs` and confirm its `buildCatalog` export.
6. In separate disposable containers, test missing auth, malformed JSON auth,
   and syntactically valid but invalid synthetic Codex tokens. Start the app with
   `--no-password --no-open --no-tunnel --no-login`. Assert missing/malformed auth
   selects `opencode_zen`; invalid tokens stay on the Codex path. Check
   `config/read` reports `never` and `danger-full-access`.
7. Before acquiring a writer in the no-auth container, POST
   `/codex-api/free-mode/custom-provider` with
   `{"provider":"openrouter","apiKey":"synthetic-review-key","wireApi":"responses"}`.
   Assert `config/read` selects `openrouter_free`. Complete a synthetic reply in
   that container and in the malformed-auth Zen container; re-read the thread
   and verify the assistant text persisted.
8. In the invalid-auth container, complete a turn against a local synthetic 401
   transport. Re-read the thread; the turn must be `failed` with its native auth
   error preserved. In a browser, reload that thread in light and dark themes.
   Assert exactly one `.turn-error-feedback` row, a `mailto:` feedback link, and
   zero `.live-overlay-feedback` duplicates. Check a 375x812 light-theme Zen
   thread and a 768x1024 dark-theme OpenRouter thread after reload. Save
   screenshots, URLs, assertions, and viewport sizes under `output/playwright/`.
9. Treat a provider switch with a loaded writer as a separate limitation. If
   unsubscribe returns `notSubscribed` but the writer remains in
   `thread/loaded/list`, do not force-kill the runtime, clear ownership, or claim
   the provider change applied. Preserve the shutdown guard and report deferred
   configuration honestly.
10. Re-fetch and compare refs immediately before publishing. Use a normal push
    of `development`, never a force push. Verify the remote target SHA, all
    reviewed-tip ancestry, unchanged `main`, and a clean worktree afterward.

#### Expected Results

- Every reviewed branch tip is represented in `development`; original branches
  remain available and newer main behavior is not rolled back.
- Unit, module, packaging, and synthetic provider checks pass; optional skipped
  snapshots, upstream/expired-token checks not performed, and known live-writer
  switching limitations are reported explicitly.
- Synthetic replies and the native 401 survive reload; light/dark surfaces are
  readable and persisted auth errors do not have duplicate live overlays.
- No production deployment, ACL application, root-policy change, gateway probe,
  or use of a production provider credential is part of this acceptance test.
- The earlier preferences overwrite is not silently treated as restored.

#### Rollback/Cleanup

- Stop/remove only explicitly identified disposable review containers and their
  internal-only network; close only their loopback forwarders. Preserve reports
  and screenshots under ignored `output/`.
- Do not delete existing branches, remove shared worktrees/dependencies, reset
  user changes, or replace production preferences as test cleanup.
- If a published integration needs correction, use reviewed follow-up/revert
  commits. Keep `main` and deployment changes separate from source review.

---
