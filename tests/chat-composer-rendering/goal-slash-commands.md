### Goal composer mode and owner-only finite Goal editor

#### Scope and safety
These checks use disposable, fully intercepted frontend/API fixtures only. Do not submit a real provider turn, change a production Goal, alter account/configuration, or clear/recreate history. Block all API escapes. Fixture responses and persistence are not native/provider execution evidence.

#### Actual implementation
- Selecting `/goal` in the composer removes the slash token and enables the Goal mode button. Submitting an objective in that mode constructs literal `/goal <objective>` text for the normal message/`turn/start` path (or the existing in-progress message path). The composer does **not** parse it into `thread/goal/*` RPCs. Literal `/goal`, `/goal pause`, `/goal resume`, and `/goal clear` remain model-interpreted messages, not guaranteed local Goal operations. Do not send them to test backend policy.
- The persisted Goal card/editor is a separate UI backed by `thread/goal/get`, `thread/goal/set`, and `thread/goal/clear`. Editing the existing objective/status omits `tokenBudget`, preserving the durable cap and accounting.
- Stop calls `turn/interrupt`; it does **not** first pause a Goal or guarantee autonomous continuation is disabled. Status-only pause via the Goal editor is separate from Stop.
- `ownerConfirmed: true` is bridge-local consent on a budget-bearing frontend request, not proof of owner identity. The backend must authorize the owner independently and remove this field before the native Goal RPC. It must never be forwarded to native.

#### Fixture setup
1. Use installed dependencies, disable runner caches, and keep all fixture output in owned scratch. Run the full frontend test set and `vue-tsc --noEmit`. The actual-template regression compiles the original conditional Goal editor and original declarations/open/save handlers with installed Vue; external authorization and persistence alone are fixtures. It mounts in a test-only document, not a reachable application route.
2. Prepare one selected owned thread with no Goal, and another with objective `Preserve original objective`, total budget `100000`, consumed tokens `117527`, and status `budgetLimited`. Snapshot consumed time and creation time as well. No provider is called.

#### Checks
1. In the intercepted composer fixture, selecting `/goal` toggles the Goal mode button; turning it off removes the mode. Goal and Plan remain mutually exclusive. Inspect the synthetic submit payload: Goal mode supplies literal `/goal <objective>` text on the normal turn path, not a Goal RPC. Include a skill mention and check the same distinction without real generation.
2. For the selected owned no-Goal thread, deliberately open its editor. After owner authorization, **Total token budget** must be visible as `type=number`, with no default numeric value. Help must say **total**, not additional tokens, and show **0 consumed tokens**. The selected thread is not created implicitly by the editor.
3. Enter a nonblank objective and an explicit safe positive-integer total. Save must ask for owner confirmation before exactly one finite-budget creation request. Inspect frontend/bridge input: `threadId`, objective, selected status, numeric `tokenBudget`, and bridge-local `ownerConfirmed: true`. Inspect separately that native Goal input excludes `ownerConfirmed`. This is fixture-only evidence.
4. Without a budget or objective, with zero/negative/fractional/nonfinite/unsafe totals, on owner-confirmation cancellation, or without owner authorization, no new Goal write may be sent. A nonowner sees no numeric controls. Do not treat hiding a control as backend authorization.
5. On an existing Goal, an ordinary objective/status edit must omit `tokenBudget` and require no budget confirmation. Do not install an unlimited/default budget.
6. For the exhausted fixture, **Adjust budget to resume** opens the same numeric total editor with original total `100000` and **117527 consumed tokens** (locale formatting may add separators). Unchanged or invalid exhausted totals never rearm it. Enter `200000`, approve once, and check the recovery input contains status `active` and numeric total, with objective omitted. Blank editor objective must not block budget-only recovery.
7. Read the fixture back: objective, consumed tokens/time, and creation time remain unchanged. Budget/status may change only through the approved recovery. These are intercepted fixture persistence checks, not a production budget adjustment or native accounting proof.
8. Delay Goal reads/owner authorization/saves, then switch selected threads or go home. The actual context watcher must hide/reset the editor and authorization; a late authorization must not reveal controls in the new context. Existing Goal-state tests must keep per-thread cached data/errors/writes isolated.
9. In light/dark themes at 375 and 768 widths, inspect the real Goal card, editor, labels, recovery action, and numeric control for readability and overflow. No synthetic test markup may stand in for the actual conditional budget block.
10. In the intercepted Stop fixture, inspect `turn/interrupt` only; do not claim Goal pause or send a real interrupt/provider turn.

#### Cleanup
Close fixture contexts and discard owned scratch output. Do not issue literal `/goal clear`, clear/recreate real Goals, or overwrite thread history as cleanup.
