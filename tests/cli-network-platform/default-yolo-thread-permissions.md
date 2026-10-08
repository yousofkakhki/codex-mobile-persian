### Feature: Default YOLO covers new, resumed and subsequent turns

#### Prerequisites
- Use an isolated disposable `CODEX_HOME`, filesystem and offline/mock provider. Never use a production thread, real credentials or a billable provider for this check.
- Build the current source. Codex 0.154.0 is the pinned native verification version; Node must be 22.16.0 or newer.
- Clear only the disposable launch's `CODEXUI_SANDBOX_MODE` and `CODEXUI_APPROVAL_POLICY` environment overrides. Record the server account's privileges.
- Disable startup hooks, Goals and MCP servers in the fixture. Capture RPC methods and payloads without tokens or conversation bodies.
- Run `src/server/freeMode.credentials.test.ts` to confirm bundled provider credentials and decoding material are absent while operator-supplied OpenRouter keys remain supported. Use only synthetic key placeholders for these tests.

#### Steps
1. Run the focused automated permission and ownership regressions:
   `node_modules/.bin/vitest run src/server/codexAppServerBridge.permissionDefaults.test.ts src/server/codexAppServerBridge.independentAdversarial.test.ts src/server/codexAppServerBridge.permissionFixCycle1.test.ts src/server/codexAppServerBridge.permissionFixCycle2.test.ts src/server/codexAppServerBridge.rereviewProbes.test.ts src/server/codexAppServerBridge.resumeSafety.test.ts src/server/codexAppServerBridge.directOwnership.test.ts --no-cache --configLoader runner`.
2. Start a disposable thread through `thread/start` without explicit permission fields. Confirm native payload uses `approvalPolicy: "never"` and `sandbox: "danger-full-access"` and native readback agrees.
3. Prepare a legacy disposable thread under `read-only` / `on-request`, materialize its metadata without generation, unsubscribe, wait for the matching `thread/closed`, then cold resume through the app without permission choices. Confirm the same YOLO payload/readback, unchanged ID/model/provider/cwd and bounded history page. Never remove a writer lock to force closure.
4. Open an already loaded restricted fixture thread. Confirm hot rejoin sends only bounded `thread/read` / `thread/turns/list` requests, not `thread/resume`, `thread/settings/update`, interrupt or unsubscribe. Confirm an active turn is unaffected.
5. In the synthetic transport only, start the next owner-requested turn without permission choices. Confirm the `turn/start` payload uses `approvalPolicy: "never"` and `sandboxPolicy: { "type": "dangerFullAccess" }`. It must not introduce a settings mutation, retry or extra thread acquisition.
6. Start/resume/send a turn with explicit restrictive permissions or a named permissions profile. Confirm those choices are not replaced by unrestricted defaults and that `sandbox`/`sandboxPolicy` is not injected alongside a named profile. Repeat with configuration-level permission overrides and a subsequent turn without new choices.
7. Launch the disposable app with `--sandbox-mode workspace-write --approval-policy on-request` (or equivalent `CODEXUI_*` environment values). Confirm these defaults are honored on start, cold resume and subsequent turns. Native requirements may further restrict the effective policy; surface native rejection without retry or bypass.
8. With an active synthetic turn, verify steering input does not retrofit that turn or its child-spawn snapshot; a later newly constructed turn uses the accepted settings. Check child boundaries through synthetic/native source evidence: existing V2 children are not directly mutated or resumed to override their policy. New children inherit the spawning parent turn snapshot, not a mid-turn settings write. Do not start a real provider turn merely to manufacture an inheritance proof.
9. Exercise thread closure or process replacement during a hot read: old staged permissions must not survive into a freshly restricted acquisition. Stage a permission change, then apply a newer sparse restricted settings change and confirm only the superseded dimensions are discarded. A `thread/settings/update` empty acknowledgement means queued, not applied: confirm `thread/settings/updated` or an asynchronous error before treating the intent as accepted; a closed-thread late reply must not recreate intent.
10. Repeat an already-effective settings update and confirm a native no-op does not leave dependent actions blocked. Deliver a matching settings snapshot before a subsequently rejected RPC and confirm no accepted intent or consumed restriction survives that rejection. Interleave an inherited staged turn with a newer explicit hot restriction and confirm its original intent order is retained. Close the returned ID in the same chunk as a new-thread response and confirm no continuation restores that closed writer.
11. Exercise damaged-history, foreign-writer, deferred-config, timeout quarantine, concurrent Goal/file mutation and explicit caller override negative tests. Confirm no dispatch, process kill, arbitrary pending-approval acceptance or Goal-budget change occurs in a rejected path. Preserve the legacy launcher `on-failure` choice without injecting it into unsupported typed RPC approval fields; native compatibility failures must remain visible, not normalize to `never`.

#### Expected Results
- Fresh start and cold resume follow the configured app defaults rather than stale saved permission fields.
- Hot viewing is read-only and does not change active work. The next owner-started turn applies the configured default using the supported native policy shape.
- Explicit caller and restricted deployment defaults remain meaningful; named permission profiles never conflict with injected sandbox fields.
- No extra permission RPC, unbounded history read, duplicate resume or auto-approved pending request is added.
- YOLO removes command sandboxing/approval only. Business approvals, clarifications, authentication, project instructions, Goal limits and native V2 child ownership remain separate.
- Offline evidence is not a real-provider execution or a production deployment claim.

#### Rollback/Cleanup
- Stop only the disposable test process after bounded work finishes; leave all production writers, projects and rollout files untouched.
- Keep production configuration unchanged. Restore restricted launch flags/environment in the disposable fixture if needed.
- Retain private verification logs outside Git. Remove only the disposable fixture after its evidence is recorded.
