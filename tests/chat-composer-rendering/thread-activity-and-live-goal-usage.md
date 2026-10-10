### Thread Activity and live goal usage

#### Feature/Change Name
Each thread has Chat and Activity tabs, durable action history, and continuously synchronized goal status and usage.

#### Prerequisites/Setup
1. Run the current worktree on `127.0.0.1:4173` with an isolated app home and synthetic RPC/WebSocket fixtures or a localhost-only fake provider.
2. Prepare threads A and B, with A containing an active goal and B containing no goal.
3. Use only synthetic prompts, outputs, credentials, and file paths. Do not restart an active production agent to test this feature.

#### Steps
1. Open A in Chat. Confirm its goal shows status, native tokens/budget, reported work, elapsed time, and last synchronization time.
2. Emit goal usage/status updates and a clear event. Confirm the card changes without refreshing, retains the current objective, and disappears when cleared.
3. Delay an A goal read, publish a newer goal update, switch to B, then finish the A request. Confirm neither stale A state nor usage appears on B.
4. Submit `/goal Synthetic objective`, `/goal`, `/goal pause`, `/goal resume`, and `/goal clear`. Confirm only goal RPCs are sent. From a new-chat draft, submit an objective and confirm thread creation followed by goal-set, without a normal turn or interrupt-pending gate.
5. Open Activity on A. Confirm chronological turn groups and expandable prompts, plan updates, command outputs, file changes, approvals, and completion/error entries.
6. Stream command output while A is not selected, then return to A. Confirm its Activity entries remain separate from B and output can be expanded.
7. Scroll upward during streaming. Confirm the view does not force scrolling; use Follow live activity to return to the latest entry.
8. Load earlier pages and recover older native history. Confirm reconstructed records are marked, unknown times say Time unavailable, and updates never duplicate rows or revert completed entries.
9. Refresh and simulate disconnect/reconnect. Confirm the tab preference persists and missed updates are recovered once using the resume cursor.
10. Restart only the isolated verification server. Confirm activity and detail files persist, elapsed time does not reset, and an incomplete journal tail produces a visible recovery warning.
11. Archive the disposable thread and verify retained history. Permanently delete it and verify its stored activity is removed. Omission from a paginated thread list must never remove history.
12. Simulate an unwritable recording directory. Confirm the task continues and the UI warns that activity may have gaps.
13. Repeat visible flows in light/dark at 1440x1000, 375x812, and 768x1024; inspect the actual Activity tab and expanded details.

#### Expected Results
- Goal changes synchronize through one shared WebSocket/SSE connection. Only visible stale active goals use the five-second fallback read.
- Token counters come from the goal API; elapsed wall-clock time is separate and no completion percentage or ETA is fabricated.
- Activity is captured at the server even without a browser subscriber. Streaming updates merge into stable entries and large details load in pages.
- Captured history survives refresh/restart; older reconstruction does not claim missing events or precise timing.
- Initial Chat loading adds no Activity-history requests; opening Activity loads only one small page and lazily recovers one native item page.
- Large histories render only a window of rows; goal/activity updates do not trigger thread-list or full-history request fanout.
- Stored records omit auth/configuration payloads, private reasoning, and attachment bodies, and redact recognizable credentials.

#### Rollback/Cleanup
- Stop only disposable verification processes/containers. Delete their isolated app homes when no longer needed.
- Runtime activity resides in `web-activity-v1` within the configured app home; back it up before a backend rollout or rollback. Never include it in Git or a package artifact.
- Clear `codex-web-local.thread-view-tab.v1` only in the isolated browser profile when resetting the tab test.
- Deploy frontend/backend together only after all live work is idle or the owner authorizes a maintenance window.
