### Feature: Dictation transcription through NineRouter

#### Prerequisites
- WebUI is using NineRouter and has its server-side `NINEROUTER_API_KEY` configured.
- NineRouter has at least one speech-to-text provider/model configured and available to that key.
- Browser microphone permission is granted; no ChatGPT OAuth session is required.

#### Steps
1. Open a thread and hold the microphone button while speaking a short test phrase.
2. Release the button and wait for transcription.
3. Repeat with a preferred language selected in Settings.
4. Repeat without ChatGPT OAuth and verify the WebUI does not expose or request the NineRouter API key.

#### Expected Results
- The server forwards the recorded multipart audio to `http://127.0.0.1:20128/v1/audio/transcriptions` using its server-only NineRouter key.
- A successful transcription appears in the composer and follows the configured auto-send preference.
- If NineRouter has no accessible STT provider/model, its configuration error is displayed instead of a misleading missing ChatGPT-token error.
- Other active providers continue using the existing ChatGPT OAuth transcription path when available.

#### Rollback/Cleanup
- Stop recording and remove any unsent dictated text from the composer.
- Revert the transcription proxy changes if reverting the feature; keep NineRouter credentials in server configuration only.
