### Feature: Telegram completion notifications

#### Prerequisites
- App server is running from this repository.
- A valid Telegram bot token is available.
- The two recipients have started a private chat with the bot.
- Their numeric chat IDs are known from `/whoami`.

#### Steps
1. Open Settings > Telegram in the WebUI.
2. Enter the bot token and allowlisted user IDs.
3. Enter both numeric chat IDs in Completion notification chat IDs.
4. Save the Telegram configuration.
5. Start a WebUI thread with a prompt that takes long enough to observe completion.
6. Wait for the thread's `turn/completed` event.

#### Expected Results
- Both configured chats receive one Telegram completion message.
- The message includes the thread title or ID, turn status, elapsed time, and final assistant response.
- A duplicate `turn/completed` event does not send a second message for the same turn.
- Failed turns produce a failure notification when the app-server includes an error.
- Existing mapped Telegram chats continue receiving their thread reply behavior.

#### Rollback/Cleanup
- Remove the notification chat IDs in Settings > Telegram and save.
- Delete `~/.codex/telegram-bridge.json` to clear the saved Telegram configuration if needed.
