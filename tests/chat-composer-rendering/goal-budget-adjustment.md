### Goal mutation transaction guard (candidate, not release-ready)

The HTTP Goal setter holds a synchronous per-thread exclusive in-memory lease before existence/accounting read through native write, budget readback, and audit. Raw rpc/rpcInner Goal set/clear also obtain the lease; the final write transport requires the opaque object identity, never an HTTP payload flag. Same-thread conflicts reject before dispatch, while different Goal IDs can hold independent leases. Ownership, generation, deferred configuration, file mutations and uncertain timed-out operations are rechecked around awaits. No persistent lock or writer reset is introduced.

An already-owned active writer may submit status-only paused. The exact editor sends an unchanged objective as well: the class compares it under the lease and forwards only status paused. Changed objective, explicit budget, and activation still require idle. Original Stop remains turn/interrupt only and its source is untouched.

HTTP pre-read validates nonnegative safe-integer tokensUsed, nonnegative finite time, nonempty target/objective/status and valid creation/update metadata rather than defaulting malformed usage to zero. Owner budget authorization requires callback === true and confirmation === true. ownerConfirmed is stripped from both HTTP and raw class wire paths; confirmation is not authentication. HTTP paused legacy null-cap activation requires owner-confirmed finite recovery. Finite exhausted activation retains native budgetLimited normalization, not an invented blanket rearm policy.

FINAL BLOCKER: raw private-class Goal setters now hold the lease but still skip authoritative existence/accounting validation. A no-budget objective set after clear can reach native with uncapped creation semantics, and a raw finite setter can dispatch without validating malformed stored usage. Final RED probes retain both failures. This candidate is not ready to publish. Do not extend this final bounded cycle into another architectural attempt without escalation.

Verification is private isolated synthetic child transport and read-only snapshot inputs. No native/provider generation, auth, production configuration, DB write, deploy or restart was executed or authorized. UI creation visibility is owned separately.

### Owner-only goal budget adjustment

#### Feature/Change Name
Owner-authorized adjustment of an existing Codex thread Goal's total token budget without replacing its objective or resetting usage accounting.

#### Prerequisites/Setup
1. WebUI is served with password authentication enabled.
2. App Server exposes `thread/goal/get` and `thread/goal/set`.
3. An existing Goal has consumed tokens and is `budgetLimited`.
4. The owner can sign in through the WebUI.

#### Steps
1. Open the existing thread, click **Adjust budget to resume** on the `budgetLimited` card, and confirm the Goal editor opens with its numeric budget section for the authenticated owner.
2. Confirm the objective, status, total budget, and consumed usage are displayed.
3. Enter a finite total budget greater than consumed usage.
4. Confirm the explicit warning says the value is a TOTAL budget, not additional tokens.
5. Confirm the adjustment.
6. Inspect the network response and refresh the thread.
7. Confirm `thread/goal/set` contains `threadId`, `tokenBudget`, and `status: active`, with `objective` omitted.
8. Confirm the objective is unchanged, the approved budget is displayed, consumed usage is unchanged, and status is active.
9. Confirm the owner audit record exists in `goal-budget-audit.jsonl` with the before/after budget, status, and usage.
10. Repeat while signed out or with a public/proxied request; confirm the owner authorization check rejects the adjustment and no Goal state changes.
11. Try the same exhausted numeric budget, empty/null budget, fractional budget, and a total at or below consumed tokens. Confirm recovery refuses without a Goal write; do not clear or recreate it.
12. Delay the successful adjustment response, switch to another thread, and open that thread's Goal editor. Confirm the original thread receives its own cache update but the newly selected thread's Goal/error/editor is unchanged.
13. Repeat real card/editor/numeric-input checks in light and dark themes and at 375x812 and 768x1024. Confirm only paused Goals with positive remaining explicit numeric budgets can use status-only rearm.
14. In an isolated intercepted API fixture, use total budget `100000` and consumed usage `117527`, type `200000` into the actual `type=number` input, click **Save goal**, and approve the confirmation. Confirm exactly one `thread/goal/set` request with `{ threadId, status: "active", tokenBudget: 200000 }` and no `objective` or accounting fields. No console/page `trim is not a function` error may occur. Reload and confirm budget `200000`, usage `117527`, original objective, consumed time, and creation time persist.
15. In the same fixture, clear only the editor objective without changing the total and confirm **Save goal** stays disabled. Change the existing total to `200000` and confirm budget-only Save becomes enabled and recovers without replacing the stored objective. New Goal creation and ordinary objective edits still require a nonblank objective.
16. Try totals `117527`, `200000.5`, and an unsafe integer; confirm validation prevents any write. Dismiss the owner confirmation or revoke owner authorization before Save; confirm no write, no reset, and the editor remains open. Never perform these regression writes on a real production Goal.

#### Expected Results
- Only the authenticated owner can adjust a Goal budget.
- The budget is finite and greater than current consumed usage.
- The operation uses the existing initialized App Server RPC path.
- `objective` is omitted from the adjustment request.
- The server reads before and after state and rejects unverifiable writes.
- Usage accounting and objective remain unchanged, including consumed time and creation time.
- An unchanged exhausted numeric budget is not silently reset; unlimited defaults and automatic recovery are not supported.
- The audit record is append-only and contains no secret values.

#### Rollback/Cleanup
- Set another approved finite total budget greater than the preserved usage, or leave the Goal active.
- Do not clear or recreate the Goal as a rollback method.

---
