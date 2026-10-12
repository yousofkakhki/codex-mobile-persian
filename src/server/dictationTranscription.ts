import { NINEROUTER_BASE_URL, NINEROUTER_PROVIDER_ID, type FreeModeState } from './freeMode.js'

export function usesNineRouterDictation(state: FreeModeState | null, configuredProvider: string | null): boolean {
  if (state?.provider === 'codex') return false
  if (state?.enabled) return state.provider === NINEROUTER_PROVIDER_ID
  return state?.provider === NINEROUTER_PROVIDER_ID || configuredProvider === NINEROUTER_PROVIDER_ID
}

export async function proxyNineRouterDictation(
  body: Buffer,
  contentType: string,
  apiKey: string,
  request: typeof fetch = fetch,
): Promise<{ status: number; body: string }> {
  const token = apiKey.trim()

  if (!/^multipart\/form-data(?:;|$)/iu.test(contentType)) {
    return { status: 400, body: JSON.stringify({ error: 'Invalid multipart form data' }) }
  }

  const boundaryMatch = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu.exec(contentType)
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2]
  if (!boundary || /[\r\n]/u.test(boundary)) {
    return { status: 400, body: JSON.stringify({ error: 'Invalid multipart form data' }) }
  }

  const delimiter = Buffer.from(`--${boundary}\r\n`)
  if (!body.subarray(0, delimiter.length).equals(delimiter)) {
    return { status: 400, body: JSON.stringify({ error: 'Invalid multipart form data' }) }
  }

  const modelField = Buffer.from('Content-Disposition: form-data; name="model"\r\n\r\ncx/codex-dictation\r\n')
  const forwardedBody = Buffer.concat([delimiter, modelField, delimiter, body.subarray(delimiter.length)])

  const response = await request(`${NINEROUTER_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'Content-Type': contentType,
    },
    body: forwardedBody,
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
  })

  return { status: response.status, body: await response.text() }
}
