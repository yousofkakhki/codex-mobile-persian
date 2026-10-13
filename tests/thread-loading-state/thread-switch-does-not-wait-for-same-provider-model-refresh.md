### Feature: Same-provider thread switches do not wait for model refresh

#### Prerequisites
- Run the app from this repository with two threads under the active global provider.
- Keep the Projects section visible and the same-provider thread model already selected.
- Use a local fixture or stubbed API responses; do not send a provider prompt.

#### Steps
1. Delay the model-list response in the local API stub.
2. Switch between the two same-provider threads.
3. Confirm the route, selected sidebar row, conversation, and project list update before the delayed catalog response completes.
4. Release the model-list response and confirm the model dropdown remains valid for the selected thread.
5. In a fresh application state with no provider catalog loaded, select a thread while the initial model catalog response is delayed.
6. Confirm thread loading waits for the initial catalog before resuming the conversation.
7. Defer config discovery as well, change its active provider, and confirm neither resume nor turn-start runs until the new catalog is ready. A send during discovery must fail closed.
8. Select two threads rapidly while their initial catalogs are deferred. Release the older catalog first: it must not resume either thread or publish retired metadata. Release the latest catalog: only the latest thread acquires a writer with its compatible model.
9. With a fresh fixture state and no initial catalog, select A, then B, then A again, waiting for each of the three deferred catalog requests to start. Release first A's catalog while latest A's catalog is still pending, then B's catalog, then latest A's catalog. Confirm abandoned selections do not publish errors or acquire a writer; latest A resumes exactly once with the active provider and compatible model after its own catalog completes.
10. Reject config/catalog discovery or return an empty initial catalog. Confirm sends fail closed without stale provider acquisition.
11. Run `node node_modules/vitest/vitest.mjs run src/composables/useDesktopState.test.ts src/composables/useDesktopState.globalProvider.test.ts src/api/codexGateway.test.ts --no-cache --configLoader runner` in an isolated fixture home.

#### Expected Results
- Same-provider thread navigation verifies authoritative config first, but does not wait for an unchanged, already-ready provider catalog refresh.
- Changed/initial routing waits for its latest catalog; config/catalog failure prevents stale sends.
- The deferred same-provider regression makes one model-list request, no thread-list request, and resolves navigation before releasing the catalog. Rapid initial navigation makes two catalog requests and only one latest-thread resume.
- The initial A-B-A regression makes exactly three catalog requests and one latest-A resume, with no stale navigation error, separate thread-detail request, or turn-start. Selection generations distinguish abandoned first A from latest A even though their thread IDs match.
- Provider/endpoint revision guards continue to discard stale responses and block overtaken writer acquisition.
- The Codex model-list refresh does not fetch the separate provider catalog.
- Initial thread loading waits for the provider catalog when no active catalog exists.
- Projects remain visible and thread navigation does not trigger a full-history request.

#### Rollback/Cleanup
- Remove the local response delay or stub after testing.
- No persistent application data is changed.
