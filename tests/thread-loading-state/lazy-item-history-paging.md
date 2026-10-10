### Feature: Lazy item-level thread history

#### Prerequisites/Setup
1. Use a native app-server that supports `thread/items/list` and `itemsView: notLoaded`.
2. Prepare an isolated fixture or an existing thread with more than 1,000 items in a single turn, plus another completed thread.
3. Run the current Vite server on `127.0.0.1:4173`. Use an isolated Codex home or synthetic RPC responses; do not create a competing writer for a live thread.
4. Open browser Network tools. Repeat the checks in light and dark themes.

#### Exact Actions
1. Open the large thread and wait for its latest message.
2. Inspect the initial resume request and its following item request.
3. Switch to the second thread, return to the first, then rapidly select both threads several times.
4. Reload the selected thread and confirm the latest message and selected route still match.
5. Click **Load earlier messages** until the locally rendered window is exhausted and the next persisted page loads.
6. Continue loading earlier items inside the same large turn, then across an older turn boundary.
7. Test a page containing only hidden reasoning items, with an earlier cursor.
8. Test older failed turns with no items, including after the item cursor is exhausted.
9. With a stubbed older app-server, reject `thread/items/list` as an unsupported method. Separately test a transient item-page failure.

#### Expected Results
- Initial resume uses `excludeTurns: true` and at most ten unloaded turn headers, followed by at most 100 recent items; it does not download ten full turns or call `thread/read` with `includeTurns: true`.
- The final selected thread, route, model context, and latest rendered message agree after rapid switching and after reload.
- Warm, unchanged completed threads reuse the existing message cache.
- Earlier item pages use the opaque native item cursor without rewriting it. Earlier turn headers have their own cursor so empty failed turns are not lost.
- Items from an already known turn are prepended rather than discarded. Overlapping item IDs appear once; current messages and live file-change turn indices retain correct chronological alignment.
- A reasoning-only latest page still offers **Load earlier messages**, instead of claiming that the entire thread is empty.
- Failed-turn errors remain visible and are placed after the relevant turn's messages.
- Only unsupported item pagination invokes the legacy ten-full-turn fallback. A transient failure displays its error without triggering a large history download.
- Both themes remain readable. Models, permissions, goals, background jobs, and persisted conversation files are not changed by loading history.

#### Performance Audit
- Inspect request counts, response sizes, blocking time, and repeated requests on the actual conversation route, not only the sidebar.
- A normal initial load uses one resume and one item-page request. Each earlier-page action makes at most one item request and one unloaded-header request; there is no recursive history-fetch fanout.
- Item and header counts are bounded, but one very large individual item can still produce a large response. Older unsupported servers retain the legacy behavior.
- Existing resume coalescing and message-cache invalidation remain in place; no new global history cache is introduced.

#### Rollback/Cleanup
- No history cleanup, archive, or compaction is required for this UI change.
- Restore the previous frontend index and assets if rolling back a deployed build; keep old hashed assets during rollout so already-open clients can still load their chunks.
- Leave verification port 4173 running unless explicitly asked to stop it. Synthetic fixtures must not send prompts, change account settings, or reach production model providers.
