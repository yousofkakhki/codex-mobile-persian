export type ZenModelMetadata = {
  id: string
  name: string
  upstreamApi: 'responses' | 'chat-completions' | 'unknown'
  routingSource: 'sdk-metadata' | 'provider-catalog'
  contextWindow?: number | null
  configuredContextWindow?: number | null
  maxOutputTokens?: number | null
  supportsReasoning?: boolean | null
  reasoningSource?: 'provider-catalog' | 'codex-family-fallback'
  supportsTools: boolean | null
  inputModalities: string[] | null
  reasoningOptions: unknown[]
  free: boolean
  discoveredAt: string
}
