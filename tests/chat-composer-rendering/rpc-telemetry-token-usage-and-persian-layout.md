### Feature: RPC telemetry, token usage, and Persian message layout

#### Prerequisites
- App server is running from this repository.
- A test thread and model are available that report `thread/tokenUsage/updated`.
- Light and dark themes are available.

#### Steps
1. Open a test thread and confirm the composer shows connection state and transfer rates.
2. Expand Stats and inspect transfer totals, token counts, turn status, request counts, latency, and stream events.
3. Send a non-sensitive prompt, wait for token usage to update, and record the current, last, and total token values.
4. Refresh the page, reopen the same thread, and confirm its token usage values persist.
5. In a test thread, render a Persian response containing a list, table, blockquote, inline code, and code block.
6. Check the same surfaces in light and dark themes at 375x812 and 768x1024.

#### Expected Results
- Runtime telemetry updates without duplicate initial thread requests.
- Token usage stays associated with its thread and persists after refresh.
- Persian prose, lists, tables, and blockquotes follow text direction; inline and block code remain left-to-right.
- Composer stats stay readable in both themes and viewports without horizontal page overflow.

#### Rollback/Cleanup
- Delete disposable test threads if desired; no server configuration changes are required.

---
