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
  if (!token) throw new Error('NineRouter API key is unavailable')

  const response = await request(`${NINEROUTER_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': contentType,
    },
    body: new Uint8Array(body),
    redirect: 'error',
    signal: AbortSignal.timeout(300_000),
  })

  return { status: response.status, body: await response.text() }
}
