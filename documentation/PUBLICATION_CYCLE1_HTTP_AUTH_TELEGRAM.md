# Publication fix cycle 1: models HTTP, owner login, Telegram completion

This is the first publication fix cycle for `PUB-HTTP-01/02/03`,
`PUB-AUTH-01`, and `PUB-TELEGRAM-01`. It changes source and synthetic tests
only; it does not publish, deploy, restart, alter owner budgets, or invoke a
real provider or Telegram account.

## Boundaries

- Models discovery accepts only successful `application/json` catalogs with a
  `data` array of objects containing nonempty string IDs. It reserializes JSON,
  sends `nosniff` and `no-store`, disables redirects, and streams at most 1 MiB
  within an 8-second deadline. Rejected bodies are cancelled without awaiting
  hostile cancellation. All client failures use one fixed JSON message;
  transport exceptions and non-success provider bodies are never echoed.
  Explicitly configured local gateways remain supported, including the original
  query and bearer forwarding to that configured destination.
- An explicit password `POST /auth/login` is processed before trusted-request
  bypass, so a local owner can obtain a normal session. Cookie issuance,
  persistence, constant-time password comparison, and cookie-only owner
  authorization are unchanged. Trusted loopback/Tailscale requests without a
  valid cookie remain nonowners. No HTTP server routing change is required.
- Completion output is bound to the notification's exact thread and turn IDs.
  Conflicting or missing identities are ignored. A matching full event supplies
  final-answer text (or legacy unknown-phase text); commentary is not a final
  response. Summary/not-loaded/missing items use `thread/items/list` with both
  IDs, `limit: 100`, and explicit `sortDirection: 'desc'`. At most three pages
  and 300 items are considered. Opaque `nextCursor` values are forwarded
  unchanged; repeated, invalid, or missing cursors and malformed/oversized
  pages stop safely. The last item of the third page is still eligible.
- Metadata-only `thread/read` uses `includeTurns: false` and checks the returned
  thread ID. One 8-second lookup deadline covers metadata and all pages.
  Read timeouts do not cancel the native handler; no read retry or late result
  is used after the local deadline. Failure and empty-turn status notifications
  are still delivered. An exhausted lookup says the final response was not
  retrieved, not that an earlier/later turn answered. No thread-wide text or
  model fallback remains. Model fields are shown only when present in the
  exactly bound event; native 0.154 does not guarantee a turn model field.

## Pinned protocol evidence

The private verification emitted experimental JSON schemas using the
SHA-checked `codex-cli 0.154.0` executable
(`3188814c35471432d4123203e0eb38e5bddc60226e3d7ddf0e59e649ea140022`).
The checked-in `documentation/app-server-schemas` contract's consumed fields
agree with that fresh output:

- `ThreadItemsListParams`: `threadId`, optional turn filter, opaque cursor,
  uint32 page limit, `asc`/`desc` direction (default ascending).
- `ThreadItemsListResponse`: `data`, `nextCursor` (`null` means no more items),
  and `backwardsCursor` (only for reversing direction; unused here).
- Each `ThreadItemEntry` has `turnId` and `item`; the response has no thread ID,
  so thread identity stays bound to the exact RPC request. Every page also
  validates the item's turn ID before considering it.
- `agentMessage`: ID/text/phase; `final_answer` and `commentary`, with unknown
  phase retained for legacy compatibility. Native 0.154 adds optional
  `delivery`/`questions` fields not consumed by this completion bridge.
- `turn/completed`: thread ID plus turn; `itemsView` distinguishes full items
  from summary and not-loaded payloads. The native Turn schema has no model
  field. Existing optional bridge event metadata is not a native guarantee.

No generated schema was edited. The existing application item-paging reader
and its opaque descending cursor tests provide the ordering/cursor reference;
completion does not reverse opaque tokens or scan whole-thread history.

## Canonical synthetic fixture alignment

The original `telegramThreadBridge.test.ts` success fixture had no thread ID or
turn ID in its read result, no completed-event items, and expected text/model
from the mutable whole-thread header. After exact-turn binding, its retained
model assertion failed (`verify-telegram01-canonical-after-bind`). The parent
explicitly authorized this narrow fixture correction:

- Add the matching thread/turn identifiers.
- Put the same success text in the matching full event with native item fields.
- Put the same model in optional, exactly bound event metadata, not a thread-wide
  fallback. This tests legacy bridge compatibility, not native model availability.
- Add the failure fixture's matching thread ID and full empty event.

Both original test names and every original positive/negative assertion remain
unchanged. There are no deleted, skipped, or weakened tests. Independent review
witnesses are immutable; their observational unsafe probes are not renamed or
reinterpreted as safety approvals. The unchanged five observational probes were
also re-executed against candidate imports in a private overlay. Their unsafe
expectations all failed (as expected); this is not a green safety suite. The
transport-error witness assumes `res.end` receives a string and sees a Buffer
under the corrected JSON writer, so its failure alone is not absence-of-secret
proof. The additive HTTP test checks the complete decoded body separately.

## Verification

Private loopback-only tests use synthetic passwords, tokens, messages, and
transport; no installed dependencies or browser downloads are needed. Shared
runtime/source/dependencies are read-only in a private mount/network namespace.
`HOME`, `CODEX_HOME`, XDG directories, and underlying temporary storage are
private; `CODEX_SQLITE_HOME` is unset for canonical projection fixtures.

- RED/GREEN outputs cover HTTP media/JSON, headers, redirects, byte cap,
  cancellation/deadline, transport/provider errors, local login/owner separation,
  exact-turn binding, multi-page lookup, cursor progress, summary payloads,
  shared deadline, and malformed-page handling.
- Final focused run: **50 passed, zero failures/skips**.
- Final canonical suite on minimum **Node 22.16.0**: **1106 passed, zero
  failures/skips**. Both conditional catalog tests executed with the genuine
  runtime snapshot and explicitly synthetic gateway catalog.
- `vue-tsc --noEmit --incremental false`: exit 0, empty stdout/stderr.
- `git diff --check`: exit 0. All 14 other protected paths and independent
  reviewer files retain their hashes. AUTH is mechanically checked to be only
  the authorized login reorder; canonical test names/assertions retain their
  original bytes.

The full suite's browser prerequisites were corrected in the private command,
not source: use the already installed `/usr/bin/google-chrome`, then bind the
run's scratch-backed temporary directory at `/dev/shm` **inside the private
mount namespace only** and set `TMPDIR=/dev/shm`. Long scratch paths exceed
Chromium's Unix-socket limit. This alias keeps underlying writes private and
avoids downloads. Earlier failed prerequisite attempts remain failed evidence.
Vitest uses `--no-cache --configLoader runner --maxWorkers 2`. Node's expected
experimental SQLite warning remains in the full-suite stderr.

The worker-private consolidated report contains source/evidence SHA-256 values,
RED/GREEN labels, exact commands, budgets, preservation checks, and local commit
identity. Integration, fresh independent combined-tree review, and any later
publication remain parent-owned gates.
