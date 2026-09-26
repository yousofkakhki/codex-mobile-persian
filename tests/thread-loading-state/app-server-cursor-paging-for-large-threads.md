### Feature: App-server cursor paging for large threads

#### Prerequisites
- Run the app with a Codex app-server version that supports `thread/resume.initialTurnsPage` and `thread/turns/list`.
- Use a thread with more than 10 turns; preferably one whose rollout is large enough that full-history loading is impractical.

#### Steps
1. Open the long thread and inspect network/RPC traffic. Confirm resume requests `excludeTurns: true` and an initial page `{ limit: 10, sortDirection: 'desc', itemsView: 'full' }`.
2. Confirm the conversation reaches a rendered state with the newest 10 turns and does not call `thread/read` with `includeTurns: true`.
3. Scroll to the oldest visible turn and request older history. Confirm the page endpoint forwards the app-server opaque cursor to `thread/turns/list`; it must not derive a cursor from turn IDs or read all turns.
4. Repeat until the app-server returns no older-page cursor. Confirm every page prepends chronologically and no duplicate turns appear.
5. Switch to another thread during loading and back; confirm requests remain associated with the selected thread and the UI remains responsive.
6. Observe service CPU/memory and route latency while loading the large thread; compare with the baseline full-history behavior.

#### Expected Results
- Initial load is bounded to 10 turns; subsequent history is bounded by the requested page size.
- Opaque cursor values are relayed unchanged. When resume includes `initialTurnsPage`, use that page's `nextCursor` for the next descending older-page request; use `turnsBackwardsCursor` only when bootstrapping a separate descending page. Never use `initialTurnsPage.backwardsCursor` for older-page continuation.
- Turns render in chronological order with stable IDs and associated file-change indices.
- No full-history `thread/read` is used by the affected path, the last page stops further loading, and unrelated thread navigation remains responsive.

#### Rollback/Cleanup
- To roll back the feature, restore the prior app artifact and keep the large thread hidden until the prior full-read path is no longer reachable.
- Do not edit, copy, or re-import the original rollout as part of this test.
