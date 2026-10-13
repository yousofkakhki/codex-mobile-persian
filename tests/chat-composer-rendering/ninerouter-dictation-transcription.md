### Feature status: NineRouter dictation transport hardened; transcription unavailable

NineRouter **0.5.95 and 0.5.99 do not implement Codex STT**. Isolated packaged
verification found `/v1/audio/transcriptions` with the literal model
`cx/codex-dictation` returns HTTP 400 (`Provider 'codex' does not support STT`)
before credential lookup. `/v1/models/stt` does not advertise Codex STT.
The `cx` chat-provider alias is not an audio capability. Do not claim that a
Codex OAuth connection enables this route, and do not silently substitute a
paid OpenAI model/provider or change the fixed model metadata.

#### Safe route contract
- If local Codex OAuth is present, the existing ChatGPT transcription transport
  retains precedence and is unchanged. This patch only hardens the imported
  NineRouter fallback when NineRouter is active and local Codex OAuth is absent.
- The authorized private gateway remains
  `http://127.0.0.1:20128/v1/audio/transcriptions`; redirects are rejected.
- Exactly one model field, `cx/codex-dictation`, is emitted. Every caller model
  field is removed. Exactly one nonempty audio `file` and at most one valid
  `language` are permitted; bytes, filename, audio media type, and language are
  preserved. Unknown fields, duplicate file/language, malformed headers,
  CR/LF injection, invalid boundary/closing framing are rejected with HTTP 400.
- Only the optional server-side `NINEROUTER_API_KEY` is used. Missing or blank
  keys work for keyless instances; browser Authorization is never forwarded.
- Request bodies are capped at **25 MiB**, including multipart overhead, by
  declared length and consumed bytes. Responses are capped at **1 MiB** of
  consumed (decompressed) bytes. Content-Length is not trusted as a sole bound.
- One **300,000 ms** deadline covers incoming body reads, upstream acquisition,
  and every upstream body read. Incomplete input times out with HTTP 408;
  oversized input returns HTTP 413; upstream timeouts return HTTP 504.
  Cancellation is initiated without awaiting potentially unbounded cleanup.
- Upstream HTTP 400 becomes HTTP 503 with the fixed JSON error
  `NineRouter dictation is unavailable`. Other upstream/transport/schema/media
  errors become fixed HTTP 502 JSON; raw provider errors/exceptions never reach
  the browser. Only JSON `{ "text": string }` or `{ "transcription": string }`
  is accepted on success; unrelated provider fields are not forwarded.
- All NineRouter responses are application-owned JSON with `nosniff` and
  `Cache-Control: no-store`. No active upstream HTML is promoted to app origin.

#### Reproducible non-billable fixture verification
From the isolated clone, with existing compatible dependencies and Node >=22.16:

```sh
python3 ../isolated-verify.py --label dictation-fixture-UNIQUE --cwd "$PWD" \
  --timeout 120 --fixtures -- node node_modules/vitest/vitest.mjs run \
  src/server/dictationTranscription.test.ts \
  src/server/dictationTranscription.http.test.ts --no-cache --configLoader runner
```

The runner assigns private HOME/CODEX_HOME before middleware import, starts a
separate loopback-only network namespace, and mounts live shared homes read-only.
The HTTP fixture binds its synthetic gateway to port 20128 only within that
namespace. It exercises the actual middleware on a real HTTP listener and the
real native-fetch gateway transport. Synthetic controls cover thrown exceptions,
false length and streams whose fetch/read/cancel ignores abort; ordinary provider
errors, redirects, media types, multipart and size limits are tested over sockets.
Stalled controls shorten the same deadline to 80 ms; production remains 300 s.
Original duplicate-model observation was explicitly corrected to require one model;
the keyless success fixture now explicitly declares the required JSON media type.

These are transport/security fixtures, **not proof of working speech recognition**.
No live login, model/provider refresh, OAuth request, or billable transcription was
performed. Packaged capability evidence was separately provided in
`/root/.hermes/cache/scratch/nine-stage-du3g6gkt/STAGING-REPORT.json`.
Any manual microphone check requires separately confirmed STT implementation;
until then the composer should show the safe unavailable error rather than a
missing-token claim or supposed successful transcript.

#### Rollback/Cleanup
Revert only these dictation route changes if rolling back. Keep credentials
server-side. This patch performs no deployment, restart, or live state change.
