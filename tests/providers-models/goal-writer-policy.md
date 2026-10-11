# Isolated writer-owned Goal mutation boundary

`AppServerProcess.mutateGoal` is the sole Goal write policy shared by HTTP and raw RPC.
HTTP adapts the authenticated middleware boolean into a typed in-process context; request
fields cannot supply owner authority. Raw RPC and scoped lease calls have no budget authority.
All explicit budgets require actual owner authorization, exact confirmation, a finite positive
safe-integer cap greater than consumed tokens, and validated authoritative accounting.

A per-thread lease spans projection/SQLite checks, authoritative Goal pre-read, owned idle
read, native write, post-read and budget audit. The only active-writer exception is a status-only
pause (including an unchanged objective). Native `call` requires a one-use opaque policy permit
bound to method, captured immutable params, process and lease; possession of a lease is not
sufficient. Scoped concurrent writes reject, and an unawaited scoped operation cannot release
its enclosing lease early. Timeout rejection preserves transport quarantine and never retries.

Absent-budget edits preserve caps, usage and creation identity. Missing Goals cannot implicitly
create; existing null-cap Goals cannot activate without confirmed finite budgeting. Goal clear
uses the same lease/accounting pre-read and validates null after deletion. Failed post-write
verification does not repair durable state, retry, reset accounting or append a success audit.
Native exhausted finite-cap activation may normalize to `budgetLimited`; it cannot remove the cap.

Canonical middleware tests exercise the real extracted runtime policy via synthetic child I/O
and mocked projection/audit seams, not an HTTP-policy stub. Both final raw regression witnesses
were RED on the exact supplied baseline. The final accounting witness additionally requires an
authoritative raw pre-read, so denial alone cannot conceal a missing policy seam.

## Prerequisites and safe setup

Use a disposable source snapshot, a synthetic owned thread and synthetic child transport.
Provide the frozen runtime/catalog test fixtures when running the complete suite. Block external
network access and never reuse a production Goal, rollout or state database for these cases.

## Actions and expected results

1. Exercise an existing owned Goal through HTTP, raw RPC and scoped lease RPC. Confirm all
   paths use the authoritative pre-read and native writes require the bound one-use permit.
2. Clear that synthetic Goal, then submit an objective/status edit without a budget. Expect
   rejection before any native setter; no implicit unlimited Goal is created.
3. Supply malformed or negative stored usage, spoofed owner fields, stale writer ownership,
   changed generation or concurrent same-thread edits. Expect no native write and no success audit.
4. Submit a deliberate finite total through authenticated owner middleware with exact confirmation.
   Expect one native write, preserved objective/accounting, verified post-read and one budget audit.
5. Pause an already owned active Goal without changing its objective. Expect success with the same
   budget and accumulated usage. Other active-writer Goal edits remain blocked; Stop sends interrupt only.
6. Render the real Goal editor with both missing and existing Goals. With an authorized owner and
   no Goal, opening the editor shows a blank total-budget input and zero-consumed help. Saving
   requires a deliberately entered finite total and confirmation; cancellation makes no write.
   This editor correction does not add a new launcher or change the composer's literal `/goal` message.

## Cleanup and evidence boundary

Remove only the disposable fixture and its synthetic reports when no writer owns them.
Retain the regression output as needed; never clear or repair real history as test cleanup.
Source tests and fixture reloads do not authorize a real budget change, provider generation,
production deployment, service restart or history rewrite.
