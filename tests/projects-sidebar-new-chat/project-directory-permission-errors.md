# Project Directory Permission Errors

## Feature/change

Project creation reports a safe, actionable error when the app process cannot write to the selected parent directory. Deployments that need `/srv/projects` mount it read-write with ownership matching the app UID/GID rather than running the app as root or granting world-write access.

## Prerequisites/setup

- Use an isolated test instance and a disposable project name.
- Run the app as its normal non-root user. For the target container, confirm its UID/GID before configuring host ownership.
- If using `/srv/projects`, create that host directory with restrictive permissions and mount it to the same container path read-write.

## Actions

1. In the isolated test environment, simulate `EACCES` and `EPERM` from directory creation for both `/codex-api/project-root` and `/codex-api/local-directory`.
2. Confirm both routes return HTTP 403 with the actionable message and do not include raw filesystem errors or paths.
3. On the authorized deployment, create a disposable project under `/srv/projects`, then inspect the directory owner and mode from the host and container.
4. Open the created project and confirm normal project listing and file access still work.

## Expected results

- Permission failures do not surface as generic HTTP 502 responses.
- The app can create files under the mounted path as its non-root user.
- Unmounted or unwritable paths remain denied; permissions are not broadened to `777`.

## Rollback/cleanup

- Remove only the disposable test project created for this check.
- If reverting the mount, first move any desired project data out of `/srv/projects`; retain project data and existing mounts.
