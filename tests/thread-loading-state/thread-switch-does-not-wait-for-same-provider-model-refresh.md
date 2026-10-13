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

#### Expected Results
- Same-provider thread navigation does not wait for an unchanged provider catalog refresh.
- The Codex model-list refresh does not fetch the separate provider catalog.
- Initial thread loading waits for the provider catalog when no active catalog exists.
- Projects remain visible and thread navigation does not trigger a full-history request.

#### Rollback/Cleanup
- Remove the local response delay or stub after testing.
- No persistent application data is changed.
