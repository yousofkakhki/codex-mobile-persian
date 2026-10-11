# Publication cycle 1 — Activity-only safety corrections

Scope: PUB-ACT-01/02/03 at baseline `a28308eeec70720e142071c9d1ab591884b2ec7b` / tree `81069d1a2d30642e4c56d6604ce395abe32fc75d`. No provider requests, native execution, permission/Goal policy changes, shared bridge changes, or deployment.

## Persistence and lifecycle

- Complete quoted credential values (including escaped quotes) are masked before entry or detail persistence. A bounded per-thread/detail redaction state retains only recognizer prefixes, quote/escape state, and private-key delimiter matching state—not value/key bodies. It survives separate flushes and store restart. Private-key recognition takes precedence over assignment parsing; an embedded key cannot expose the rest of a quoted value.
- A `.txt.redaction.json` sidecar is written fail-closed before output and finalized after output. Missing, malformed, or interrupted state on an existing detail blocks subsequent appends with a recording-gap warning; a full authoritative replacement can restore recording. This is deliberately conservative: old details cannot prove whether a redacted value was still open. No attempt is made to reconstruct discarded secret data. This is recognizer coverage, not a guarantee that arbitrary undisclosed credential formats can be detected.
- Confirmed permanent deletion tombstones both recorder and store. Late recovery success, failure, unsupported-method fallback, coverage writes, notifications, and queued store loads cannot recreate the removed directory. Archive remains distinct from deletion.
- Recovery binds continuation to thread closure epoch and observed native process identity without modifying the native transport. Every recovery await and delayed write revalidates its provenance. Journal/coverage cancellation restores acknowledged state under per-thread serialization; full-detail cancellation uses filesystem backup/rename rather than reading unbounded detail into memory.
- Successful cold reads bind their returned native generation; failed cold reads whose process changed during initialization do not attach coverage/fallback work to a guessed replacement. An older runtime's first cold unsupported-method result may therefore require an explicit retry once warm. Current-generation unsupported-method fallback remains supported and tested.
- The adjacent LIMIT-ACT-SNAPSHOT witness is repaired narrowly: the retained tail segment repairs missing/older snapshots even when manifest sequence is current. Startup still does not scan all acknowledged segments. Missing older snapshots outside that retained tail remain a limitation; no fsync/power-loss durability claim is made.

## Bounded client work

- One catchup performs at most four pages, 200 entries (reserving a complete next bounded page), and starts no further page once one second of work has elapsed. A slow in-flight request is not aborted at the transport layer; its late result is ignored if the view/thread/generation is no longer current.
- A non-advancing cursor or an oversized server page stops with a visible error. Repeated `ready` notifications do not silently continue a paused catchup. **Load recent updates** is the explicit continuation action.
- Switching to Chat, thread/home changes, and stop invalidate outstanding work synchronously, including hide/reopen within one Vue tick.
- The client retains a 1,000-entry window, not an unbounded array. Earlier/recovered pages move the window earlier; the next recent refresh reloads the recent page if that end was evicted. Earlier paging and native historical recovery remain single explicit pages. Detail reads, virtualization and independent asynchronous recorder scheduling remain unchanged.

## Deliberate exclusions

LIMIT-ACT-PATH (locally corrupted manifest journal basenames), LIMIT-ACT-SUMMARY (empty streamed list summaries), and LIMIT-SHARED-HOT (shared bridge version/deployment warning) are not fixed by this Activity-only change. No global publication/main-merge approval is implied; parent integration and fresh independent exact-tree review remain required.

## Evidence

Private reports/logs are under `output/publication-cycle1/activity/` in the worker repository. The original two independent safety/recovery test files were copied byte-for-byte to new `publicationCycle1.*` test paths and replayed unchanged RED and GREEN. Original reviewer and protected acceptance sources were hashed before/after. All bodies in regressions are fabricated markers, and retained logs mask those markers.

Verification uses the pinned Node 22.16.0 executable, read-only shared dependency/source/runtime binds, private HOME/CODEX_HOME/XDG, a private mount/network namespace, no external routes, `vitest --no-cache --configLoader runner`, and `vue-tsc --noEmit --incremental false`. `CODEX_SQLITE_HOME` is unset so projection fixtures retain their canonical homes. A short `/run` bind is namespace-private and maps to the authorized repository's scratch output to avoid Chromium's Unix-socket path limit; it changes no host `/run` files.
