import { ProviderKind } from '../../shared/contracts'

export interface ProviderGenerateResult {
  raw: string
  firstTokenMs: number | null
}

export interface ProviderWarmupInput {
  kind: ProviderKind
  model: string
  baseUrl: string
  apiKey?: string
  signal: AbortSignal
}

export interface ProviderGenerateInput {
  kind: ProviderKind
  model: string
  baseUrl: string
  apiKey?: string
  systemPrompt: string
  userPrompt: string
  signal: AbortSignal
  stream?: boolean
  onPartial?: (raw: string, firstTokenMs: number | null) => void
}

export interface InferenceProvider {
  prewarm(input: ProviderWarmupInput): Promise<number>
  generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult>
}
