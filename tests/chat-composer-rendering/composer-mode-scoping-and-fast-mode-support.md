### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode, reasoning effort, and Fast mode are scoped to the current chat instead of becoming defaults for every chat. Fast mode is available for supported GPT 5.4, GPT 5.5, GPT 5.6, and GPT-6 model IDs; Ultra reasoning is available for GPT-6 Astra.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two existing threads are available
3. Model list includes `gpt-5.4`, `gpt-5.5`, `gpt-5.6`, `gpt-6-astra`, and at least one unsupported model
4. Light theme and dark theme both available from the appearance switcher

#### Steps
1. In light theme, open thread A, open the composer add menu, and enable Plan mode.
2. Open thread B and confirm Plan mode is off by default.
3. Return to thread A and confirm Plan mode remains on for that thread.
4. Open Start new thread, enable Plan mode, send a first message, and confirm the created thread starts in Plan mode.
5. Return to Start new thread again and confirm Plan mode is off for the next new chat.
6. Select each supported GPT-5.4, GPT-5.5, GPT-5.6, and GPT-6 model family and confirm the Fast mode switch is visible.
7. Select `gpt-6-astra` and confirm Ultra appears in the reasoning-effort menu.
8. Select a different model and confirm Ultra is unavailable.
9. Select an unsupported model family and confirm the Fast mode switch is hidden.
10. Switch to dark theme and repeat steps 1-9.
11. Using synthetic RPC fixtures or disposable threads, enable Fast mode in thread A. Confirm `thread/settings/update` sends A's ID and `serviceTier: "priority"`, without any `config/batchWrite` request.
12. Open thread B, confirm its Fast setting is unchanged, then return to A and confirm Fast is still enabled.
13. Refresh the page and confirm A remains Fast. Disable Fast in A and confirm the request sends `serviceTier: "default"`. Repeat in dark theme.
14. In Start new thread, enable Fast and send a synthetic first message. Confirm the created thread is Fast, but another new-chat draft starts in Standard mode.
15. Send synthetic next turns from A and B and inspect their `turn/start` tiers. Fast sends `priority`; Standard sends `default`, even when global configuration enables Fast.
16. With a delayed fixture response, toggle A's speed and switch to B before the save completes. Confirm a failed A save rolls back only A, and a stale history response cannot overwrite a newer toggle.
17. Restart only an isolated test app-server, then reload the saved threads. Confirm `thread/resume` reapplies each saved tier. Never restart a production server with active work for this check.
18. In thread A, select `Max` in the reasoning-effort dropdown. Open thread B, select `Low`, then return to A and confirm it still shows `Max`.
19. Refresh the page and confirm A still shows `Max` and B still shows `Low`. Change the model in one thread to a model that does not support the saved effort and confirm it falls back to a supported value only for that thread.
20. In Start new thread, select `Max` and send a synthetic first message. Confirm the created thread uses `Max`, while the next new-chat draft starts from the configured default rather than reusing the previous thread's value.

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Fast mode is visible only for supported GPT 5.4, GPT 5.5, GPT 5.6, and GPT-6 model IDs, including dashed variants.
- Ultra reasoning is available only for GPT-6 Astra.
- Fast mode remains hidden for unsupported model families.
- Changing Fast in one thread does not change any other thread or global Codex configuration.
- Changing reasoning effort in one thread does not change any other thread or the configured global default.
- Reasoning effort choices persist across thread switches and page refreshes. Model changes validate and adjust only the affected thread's stored choice.
- Saved choices persist across page refresh and are reapplied on thread resume. Standard explicitly overrides an inherited Fast default.
- A new-chat Fast selection applies only to the created chat, not later new-chat drafts.
- Speed changes affect subsequent turns, not the response currently running. Queued turns inherit the loaded native thread setting; offline backend queue recovery without a browser resume is not covered by this check.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.
- Restore each disposable thread's original Fast setting. Do not enable paid tiers or send provider requests on production threads just to test this feature.
- Stop only disposable test containers/processes and remove their isolated homes when no longer needed. Browser persistence uses `codex-web-local.speed-mode-by-context.v1`; clear it only in the isolated test browser profile.

---
