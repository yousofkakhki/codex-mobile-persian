### Feature: 9Router server-configured provider

#### Prerequisites
- The app server has `NINEROUTER_API_KEY` configured outside the repository.
- The app server uses `NINEROUTER_BASE_URL` for the provider API root when 9Router is not local; for example, `https://router.example.test/v1`. Both HTTP and HTTPS overrides are supported; use HTTPS outside trusted loopback/private transport.
- App server is running from this repository.
- A disposable thread and non-sensitive prompt are available.

#### Secret-backed entrypoint verification

- `scripts/codex-mobile-ninerouter-entrypoint.sh` reads only the mounted
  `/run/secrets/ninerouter-api-key`, exports it server-side, and preserves CLI
  arguments through `exec`. Missing, empty or whitespace-only secrets must fail
  before starting the app; no key value may be logged.
- Run `node --test scripts/codex-mobile-ninerouter-entrypoint.test.cjs`. All four
  cases use temporary fake readers/apps and synthetic markers; they never read
  the host's secret file or start the real app. Temporary fixtures are removed.
- This optional operations helper adds no request-handling work and makes one
  secret-file read per launch. Do not run it against production as part of tests.

#### Steps
1. Open Settings and select `9Router` in the Provider menu.
2. Confirm the UI says credentials stay on the server and does not show a browser-side key field.
3. Open a disposable thread and confirm 9Router models appear when the configured key is valid.
4. Select a model and send a non-sensitive prompt.
5. Refresh the page and confirm `9Router` remains selected.

#### Expected Results
- Provider selection uses the server-configured `NINEROUTER_API_KEY`; no key value appears in the UI or browser request body.
- Provider model discovery and a test turn succeed with a valid server configuration.
- GPT model IDs are normalized for 9Router without changing other provider model IDs.

#### Rollback/Cleanup
- Switch the Provider menu back to Codex.
- Delete the disposable thread; remove the environment key only if it was added for this test.

---
