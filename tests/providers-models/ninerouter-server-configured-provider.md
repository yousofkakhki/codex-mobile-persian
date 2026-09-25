### Feature: 9Router server-configured provider

#### Prerequisites
- The app server has `NINEROUTER_API_KEY` configured outside the repository.
- App server is running from this repository.
- A disposable thread and non-sensitive prompt are available.

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
