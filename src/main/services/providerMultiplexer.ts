import { ProviderKind } from '../../shared/contracts'
import {
  InferenceProvider,
  ProviderGenerateInput,
  ProviderGenerateResult,
  ProviderWarmupInput
} from './inferenceProvider'
import { TranslationInput, TranslationProvider } from './translationProvider'

export class MultiplexInferenceProvider implements InferenceProvider {
  constructor(private readonly providers: Record<ProviderKind, InferenceProvider>) {}

  async prewarm(input: ProviderWarmupInput): Promise<number> {
    return this.resolveInference(input.kind).prewarm(input)
  }

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    return this.resolveInference(input.kind).generate(input)
  }

  private resolveInference(kind: ProviderKind): InferenceProvider {
    const provider = this.providers[kind]
    if (!provider) {
      throw new Error(`No inference provider registered for kind ${kind}.`)
    }
    return provider
  }
}

export class MultiplexTranslationProvider implements TranslationProvider {
  constructor(private readonly providers: Record<ProviderKind, TranslationProvider>) {}

  async translate(input: TranslationInput): Promise<string> {
    return this.resolveTranslation(input.kind).translate(input)
  }

  private resolveTranslation(kind: ProviderKind): TranslationProvider {
    const provider = this.providers[kind]
    if (!provider) {
      throw new Error(`No translation provider registered for kind ${kind}.`)
    }
    return provider
  }
}
