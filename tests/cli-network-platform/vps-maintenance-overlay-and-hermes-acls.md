# VPS maintenance overlay and Hermes project ACLs

## Feature: publish the preserved-release maintenance package without deployment

### Prerequisites

- Use Node 22.16 or newer and run package commands from
  `maintenance/vps-webui/`, not the application root.
- Unit tests require no credentials, running services, installed dependencies,
  or inference, but artifact-patch tests read the exact pinned VPS release.
- Release verification additionally requires the pinned candidate described in
  `maintenance/vps-webui/README.md`. Do not substitute a build from current
  application source.
- Review `HERMES-ACCESS.md` before any filesystem checks. This publication does
  not authorize reapplying ACLs, restoring backups, or changing service settings.

### Steps

1. Run `node --test test/*.test.mjs`. Expect all 61 tests to pass, including
   discovery deadline/cancellation, single-flight/cache invalidation and ACL
   permission-preservation tests.
2. From a CommonJS shell entry, run
   `node -e "const a=require('node:assert/strict'); Promise.all([import('./lib/control-plane.mjs'),import('./lib/filesystem-acl.mjs')]).then(([c,f])=>{a.equal(typeof c.withDeadline,'function');a.equal(typeof f.grantAccount,'function')}).catch(e=>{console.error(e);process.exitCode=1})"`.
   Expect exit 0; the package is ESM-only and must remain importable from CJS.
3. Review the saved integration report for the exact candidate: all ten checks
   pass, the fixture uses a separate network namespace, and real credential and
   inference counts remain zero. Reproduction commands are in the package
   README; they create only an ignored candidate and isolated test artifacts.
4. After building and checking that exact candidate, run
   `node scripts/check-rollout.mjs`. Expect exit 2 and `rolloutAllowed:false`
   while zero routes have verified genuine Ultra. Never run the inference probe
   automatically or interpret a successful HTTP response as restored Ultra.
5. Review the saved Hermes access report: UID 999 filesystem operations and
   root-owned-file inheritance passed, browser HTTP checks returned 200, and
   `applicationStateModified:false`. This records the separately approved repair
   already applied on the VPS; it does not test real thread creation.
6. Inspect `git diff --name-only origin/main...HEAD`: changes must be confined
   to the maintenance package and its manual-test documentation. Application
   source, root package metadata, private runtime copies and `.work/` stay out.

### Expected Results

- Publishing, merging, or importing the package alone does not deploy a release,
  restart the WebUI, change the gateway, or reapply filesystem permissions.
- The ACL repair is recorded as live; the WebUI overlay remains staged only and
  genuine Ultra restoration remains blocked. Existing source-level Ultra
  behavior on `main` is not changed by this preserved-release package.
- Discovery handles failures with bounded reads and configuration-bound
  last-good fallback. No timeout is added to long-running turn operations.

### Performance Audit

- The recorded isolated full-server integration bounded stalled `config/read`,
  `model/list` and cold discovery responses at approximately 8,004 ms each.
- Unit coverage verifies three concurrent discovery requests share one refresh.
  Code-path inspection confirms a 30-second successful cache and five-second
  failure backoff; configuration identity changes invalidate stale fallback.
- ACL traversal/application is a separate manual maintenance step, never part
  of request handling. Release verification walks the pinned artifact tree only
  when invoked. No new per-model RPC fanout or production inference was added.
- Production/browser timing and light/dark screenshots were not measured during
  publication; the overlay is not deployed and no app UI source is changed here.

### Rollback/Cleanup

- No production rollback is needed for publication. Reverting package commits
  does not undo previously applied ACLs or alter the live service.
- Do not run the installation rollback script: it disables the application.
  ACL backup restore requires a separate explicit decision; see HERMES-ACCESS.
- Keep all candidate/runtime copies under ignored `.work/`. Remove only exact,
  independently verified disposable test paths when cleanup is requested.
