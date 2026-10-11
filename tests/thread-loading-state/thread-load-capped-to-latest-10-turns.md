### Legacy fallback: Thread load capped to latest 10 turns

#### Prerequisites
- App is running from this repository.
- At least one thread exists with more than 10 turns/messages.
- Use an older app-server or a test stub that rejects `thread/items/list` as unsupported. For supported native item paging, follow [Lazy item-level thread history](lazy-item-history-paging.md).

#### Steps
1. Open a long thread that previously caused UI lag during initial load.
2. While the thread is loading, immediately click another thread in the sidebar.
3. Return to the long thread.
4. Count visible loaded history blocks and confirm only the newest portion is shown.
5. Call `/codex-api/rpc` with method `thread/read` for the same thread and inspect `result.thread.turns.length`.
6. Call `/codex-api/rpc` with method `thread/resume` for the same thread and inspect `result.thread.turns.length`.

#### Expected Results
- The legacy fallback renders only the most recent 10 full turns. Supported item paging instead requests ten unloaded headers and 100 recent items.
- UI remains responsive during thread load.
- You can switch to another thread without the UI freezing.
- `thread/read` and `thread/resume` RPC responses contain at most 10 turns.

#### Rollback/Cleanup
- Remove the unsupported-method stub after verification; no history cleanup is required.
