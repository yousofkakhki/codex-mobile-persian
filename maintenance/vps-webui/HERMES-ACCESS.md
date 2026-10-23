# Approved Hermes project access repair

Applied on 2026-10-23 after the user selected the entire `/home/hermes` project
tree. This is a Linux ACL repair, separate from the staged Ultra/WebUI overlay.
No application release, gateway, model setting, sudo policy, service identity or
session state was changed, and the WebUI was not restarted.

## Scope

`codex-mobile` (UID 999, GID 988) now has read/write access to existing project
files, execute access to existing executable files, and read/write/traverse
access to project directories. Directory default ACLs provide inheritance for
normally created files and folders. Explicit restrictive creation modes such
as `0600` or `0700` can still mask inherited named-user permissions.

- `/home/hermes` itself permits project creation.
- All 17 visible project paths are covered, including symlink targets under
  `/srv/robinhood/history/devbots/home/hermes`, the legacy-source tree, the
  phase104 compatibility directory, and its phase119 input link.
- Ancestors receive traversal access without write access.
- Hidden `.config`, `.svm`, and `.foundry` trees were excluded; their ACL
  snapshots were compared before and after and remained unchanged.
- Symlinks and system Python binaries were not modified or recursively followed.

53,046 file paths and 5,115 directory ACLs were verified after application.
Ownership and special permission bits were preserved. Existing ACL masks were
accounted for so the change did not unmask grants to other users or groups.

## Verification

- All 61 maintenance unit tests passed, including nine ACL-specific tests.
- As UID 999, file create/read/append/rename/delete and subdirectory creation
  passed in `/home/hermes` and all 17 project paths.
- A newly created root-owned file inherited usable read/write access for UID
  999, and UID 999 could create a child directory beside it.
- Live folder-browser requests for `/home/hermes`, `robinhood-research`, and
  the legacy-source alias returned HTTP 200.
- Verification fixtures were removed with explicit unlink/rmdir operations.
  No real project files were edited and no real thread, workspace entry or
  model inference was created for testing.
- Service PID remained 92187, `NRestarts=0`, UID `codex-mobile`, with
  `NoNewPrivileges=no`.

The folder picker currently lists physical subdirectories, not directory
symlinks. A symlinked project can still be opened by entering its complete path;
the successful HTTP checks above used the symlinked paths directly. This repair
does not change that existing picker behavior or the separate discovery/Ultra
issues documented in README.md.

Verification reports: `evidence/hermes-acl-application.json`,
`evidence/hermes-access-verification.json`, and `evidence/hermes-acl-tests.xml`.

## Backup and rollback

Root-only backups and the exact ACL plan are retained at:

`/var/backups/codex-mobile-hermes-acl-WEXrDX`

To restore the ACLs of the original files/directories and remove the new
inheritance defaults from those directories:

```sh
sudo -n /usr/bin/setfacl --restore=/var/backups/codex-mobile-hermes-acl-WEXrDX/before.acl
```

This does not delete files. Files created after the snapshot are not included
in the rollback and may retain inherited ACLs.

Operational implementation: `scripts/home-hermes-access.mjs` provides separate
`--plan` and `--apply <backup-directory>` steps. The apply step refuses ACL,
inode, ownership, mode, group-membership or scope drift before mutation.
`scripts/verify-hermes-access.mjs` performs the scoped permission checks without
creating application sessions or making inference requests.
