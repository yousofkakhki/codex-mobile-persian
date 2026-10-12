### Feature: Dictation transcription through NineRouter

#### Prerequisites
- WebUI is using NineRouter; configure the server-side `NINEROUTER_API_KEY` only if NineRouter requires it.
- NineRouter has an active Codex OAuth connection available to its STT handler.
- Browser microphone permission is granted; Codex Mobile does not need a local ChatGPT OAuth session.

#### Steps
1. Confirm NineRouter's `/v1/models/stt` catalog includes `cx/codex-dictation`.
2. Open a thread and hold the microphone button while speaking a short test phrase.
3. Release the button and wait for transcription.
4. Repeat with a preferred language selected in Settings.
5. Verify the WebUI does not expose or request the NineRouter API key.

#### Expected Results
- The server adds the fixed `cx/codex-dictation` model and forwards multipart audio to `http://127.0.0.1:20128/v1/audio/transcriptions` using its server-only NineRouter key.
- NineRouter sends the audio to the Codex transcription endpoint using its active OAuth connection; neither credential is exposed to the browser.
- A successful transcription appears in the composer and follows the configured auto-send preference.
- If NineRouter has no active Codex OAuth connection, its provider error is displayed instead of a misleading missing ChatGPT-token error.
- Other active providers continue using the existing ChatGPT OAuth transcription path when available.

#### Rollback/Cleanup
- Stop recording and remove any unsent dictated text from the composer.
- Revert the transcription proxy changes if reverting the feature; keep NineRouter credentials in server configuration only.
