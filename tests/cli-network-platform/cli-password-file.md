### Feature: CLI password file

#### Prerequisites
- Project dependencies are installed.
- A disposable password file exists outside the repository with owner-only permissions.

#### Steps
1. Run `pnpm run build:cli`.
2. Start the CLI with `node dist-cli/index.js --no-tunnel --no-open --no-login --port 5998 --password-file <protected-file>`.
3. Open `http://127.0.0.1:5998` and authenticate using the password file contents.
4. Confirm startup output does not print the password.
5. Try an empty password file and confirm startup reports an error instead of starting without protection.

#### Expected Results
- CLI reads and trims the password from the specified file.
- Password remains absent from startup output.
- Empty password files fail closed.

#### Rollback/Cleanup
- Stop the disposable CLI process and delete the temporary password file.

---
