### Composer mode scoping and Fast mode support

#### Feature/Change Name
Plan mode is scoped to the current chat instead of becoming the default for every chat. Fast mode is available for supported GPT 5.4, GPT 5.5, GPT 5.6, and GPT-6 model IDs; Ultra reasoning is available for GPT-6 Astra.

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

#### Expected Results
- Enabling Plan mode in one existing thread does not enable it in other existing threads.
- A new-chat Plan mode selection applies to the created chat but does not persist as the default for later new chats.
- Fast mode is visible only for supported GPT 5.4, GPT 5.5, GPT 5.6, and GPT-6 model IDs, including dashed variants.
- Ultra reasoning is available only for GPT-6 Astra.
- Fast mode remains hidden for unsupported model families.
- Composer controls and menus remain readable in light and dark themes.

#### Rollback/Cleanup
- Turn Plan mode off in any test threads if desired.

---
