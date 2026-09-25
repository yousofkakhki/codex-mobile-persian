### Projects survive stale workspace-root order

#### Feature/Change Name
The Projects pane keeps thread-backed projects visible when `projectOrder` still contains a project that is missing from the saved workspace-root list.

#### Prerequisites/Setup
1. Dev server running (`pnpm run dev`)
2. At least two projects with existing threads
3. One project's path present in `projectOrder` but missing from saved workspace roots
4. Light and dark themes available

#### Steps
1. Open the app in light theme.
2. Open the Projects pane and wait for thread loading to finish.
3. Confirm both existing projects remain visible, including project missing from saved workspace roots.
4. Open the second project and send a prompt.
5. Confirm the first project remains visible while the new prompt is running and after it completes.
6. Repeat steps 2-5 in dark theme.

#### Expected Results
- Thread-backed projects listed in `projectOrder` remain visible even when saved-root order is stale.
- Opening a project and sending a prompt does not hide other projects.
- Empty workspace-root placeholders and explicit project removal behavior remain unchanged.
- Light and dark themes keep project rows readable.

#### Rollback/Cleanup
- Remove any temporary prompt or project created only for this test.
