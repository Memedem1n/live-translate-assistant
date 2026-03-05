import { randomUUID } from 'node:crypto'
import {
  AssistAnswerMode,
  AssistEvent,
  AssistIntentClass,
  InterviewAnswerStyle,
  PersonalizationMode,
  ProviderConfig
} from '../../shared/contracts'
import { InferenceProvider } from './inferenceProvider'
import { DisabledTranslationProvider, TranslationProvider } from './translationProvider'

interface GenerateAssistInput {
  providerConfig: ProviderConfig
  transcriptId: string
  segmentId?: string
  sourceText: string
  sourceLanguage?: string
  contextLines: string[]
  personalizedContextLines?: string[]
  answerStyle?: InterviewAnswerStyle
  intentClass?: AssistIntentClass
  answerMode?: AssistAnswerMode
  signal?: AbortSignal
  timeoutMs?: number
  onPartial?: (event: AssistEvent) => void
}

interface ParsedAssist {
  answerEn: string
  confidence: number
  riskFlags: string[]
}

const DEFAULT_TIMEOUT_MS = 12000
const PRIMARY_PROMPT =
  'You are a live technical interview copilot. Return strict minified JSON only with keys answer_en, confidence, and risk_flags. ' +
  'answer_en must sound like a real candidate speaking in first person, in natural English, in 3 to 5 sentences. ' +
  'Do not use STAR labels. Do not mention being an AI. Stay grounded in the provided persona context and latest interviewer question.'
const FALLBACK_PROMPT =
  'Return valid minified JSON only with keys answer_en, confidence, and risk_flags. answer_en must be first-person natural spoken English.'

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.72
  return Math.max(0, Math.min(1, value))
}

function confidenceBand(value: number): 'low' | 'medium' | 'high' {
  if (value >= 0.82) return 'high'
  if (value >= 0.58) return 'medium'
  return 'low'
}

function cleanJson(raw: string): string {
  return String(raw || '')
    .replace(/^```json/gi, '')
    .replace(/^```/gm, '')
    .replace(/```$/gm, '')
    .trim()
}

function sanitizeAnswer(value: string): string {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export class AssistService {
  constructor(
    private readonly inferenceProvider: InferenceProvider,
    private readonly translationProvider: TranslationProvider = new DisabledTranslationProvider()
  ) {}

  async prewarm(input: {
    providerConfig: ProviderConfig
    timeoutMs?: number
  }): Promise<number> {
    const timeoutMs = input.timeoutMs ?? 5000
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`Assist prewarm timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    try {
      return await this.inferenceProvider.prewarm({
        kind: input.providerConfig.inference.kind,
        model: input.providerConfig.inference.model,
        baseUrl: input.providerConfig.inference.baseUrl,
        apiKey: input.providerConfig.inference.apiKey,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  }

  async generate(input: GenerateAssistInput): Promise<AssistEvent> {
    const start = Date.now()
    const partialId = randomUUID()
    const sourceText = input.sourceText.trim()
    const personalizedContextLines = input.personalizedContextLines || []
    const mergedContext = [...input.contextLines, ...personalizedContextLines].slice(-24)
    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    const timer = setTimeout(() => {
      controller.abort(new Error(`Assist request timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    const upstreamAbort = () => {
      const reason = input.signal?.reason
      if (reason instanceof Error) {
        controller.abort(reason)
      } else {
        controller.abort(new Error(typeof reason === 'string' ? reason : 'Assist request aborted.'))
      }
    }

    if (input.signal) {
      if (input.signal.aborted) {
        upstreamAbort()
      } else {
        input.signal.addEventListener('abort', upstreamAbort, { once: true })
      }
    }

    try {
      const primary = await this.inferenceProvider.generate({
        kind: input.providerConfig.inference.kind,
        model: input.providerConfig.inference.model,
        baseUrl: input.providerConfig.inference.baseUrl,
        apiKey: input.providerConfig.inference.apiKey,
        signal: controller.signal,
        stream: true,
        systemPrompt: PRIMARY_PROMPT,
        userPrompt: this.buildUserPrompt(sourceText, mergedContext, personalizedContextLines),
        onPartial: (raw, firstTokenMs) => {
          const parsed = this.tryParse(raw)
          const partialAnswer = sanitizeAnswer(parsed?.answerEn || '')
          if (!partialAnswer) return
          input.onPartial?.({
            id: partialId,
            transcriptId: input.transcriptId,
            segmentId: input.segmentId,
            sourceLanguage: input.sourceLanguage,
            sourceText,
            state: 'partial',
            answerEn: partialAnswer,
            rawText: raw,
            latencyMs: Date.now() - start,
            firstTokenMs: firstTokenMs ?? undefined,
            personalizationMode: personalizedContextLines.length > 0 ? 'personalized' : 'generic_fallback',
            intentClass: input.intentClass,
            answerMode: input.answerMode,
            supportSignals: {
              contextHitCount: personalizedContextLines.length,
              confidenceBand: 'medium',
              riskFlags: []
            }
          })
        }
      })

      const parsed = (await this.parseWithFallback(primary.raw, input, controller.signal)).parsed
      const qualityFlags = this.collectQualityFlags(parsed.answerEn, parsed.riskFlags)
      const helperAnswerTr = await this.translateIfEnabled(
        parsed.answerEn,
        input.providerConfig,
        input.providerConfig.translation.enabled && input.providerConfig.translation.model ? 'tr' : '',
        controller.signal
      )
      const questionTr = await this.translateQuestionIfEnabled(sourceText, input.providerConfig, controller.signal)
      const finalConfidence = clampConfidence(parsed.confidence)
      const final: AssistEvent = {
        id: randomUUID(),
        transcriptId: input.transcriptId,
        segmentId: input.segmentId,
        sourceLanguage: input.sourceLanguage,
        sourceText,
        questionTr: questionTr || undefined,
        answerEn: parsed.answerEn,
        helperAnswerTr: helperAnswerTr || undefined,
        confidence: finalConfidence,
        qualityFlags,
        supportSignals: {
          contextHitCount: personalizedContextLines.length,
          confidenceBand: confidenceBand(finalConfidence),
          riskFlags: parsed.riskFlags
        },
        contextLinesUsed: personalizedContextLines.slice(0, 8),
        latencyMs: Date.now() - start,
        firstTokenMs: primary.firstTokenMs ?? undefined,
        fallbackUsed: false,
        parseMode: 'primary',
        personalizationMode: personalizedContextLines.length > 0 ? 'personalized' : 'generic_fallback',
        intentClass: input.intentClass,
        answerMode: input.answerMode,
        state: 'final',
        rawText: primary.raw
      }
      return final
    } finally {
      clearTimeout(timer)
      if (input.signal) {
        input.signal.removeEventListener('abort', upstreamAbort)
      }
    }
  }

  private buildUserPrompt(sourceText: string, contextLines: string[], personalizedContextLines: string[]): string {
    const contextBlock = contextLines.length > 0 ? contextLines.join('\n') : '[no context]'
    const personalizationMode: PersonalizationMode = personalizedContextLines.length > 0 ? 'personalized' : 'generic_fallback'
    return [
      `Persona mode: ${personalizationMode}`,
      'Speak as the candidate in first person.',
      'Keep the answer practical, specific, and interview-safe.',
      '',
      'Context:',
      contextBlock,
      '',
      'Latest interviewer question:',
      sourceText
    ].join('\n')
  }

  private tryParse(raw: string): ParsedAssist | null {
    try {
      return this.parse(raw)
    } catch {
      return null
    }
  }

  private parse(raw: string): ParsedAssist {
    const cleaned = cleanJson(raw)
    const direct = this.safeJsonParse(cleaned)
    const matched = direct ? direct : this.safeJsonParse(cleaned.match(/\{[\s\S]*\}/)?.[0] || '')
    if (!matched || typeof matched !== 'object') {
      throw new Error('Model did not return valid JSON payload.')
    }

    const payload = matched as {
      answer_en?: string
      confidence?: number
      risk_flags?: string[] | string
    }

    const answerEn = sanitizeAnswer(payload.answer_en || '')
    if (!answerEn) {
      throw new Error('Missing answer_en from model response.')
    }

    const riskFlags = Array.isArray(payload.risk_flags)
      ? payload.risk_flags.map((item) => String(item).trim()).filter(Boolean)
      : String(payload.risk_flags || '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)

    return {
      answerEn,
      confidence: clampConfidence(Number(payload.confidence ?? 0.72)),
      riskFlags
    }
  }

  private safeJsonParse(raw: string): unknown | null {
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  private async parseWithFallback(
    raw: string,
    input: GenerateAssistInput,
    signal: AbortSignal
  ): Promise<{ parsed: ParsedAssist }> {
    const direct = this.tryParse(raw)
    if (direct) {
      return { parsed: direct }
    }

    const repair = await this.inferenceProvider.generate({
      kind: input.providerConfig.inference.kind,
      model: input.providerConfig.inference.model,
      baseUrl: input.providerConfig.inference.baseUrl,
      apiKey: input.providerConfig.inference.apiKey,
      signal,
      stream: false,
      systemPrompt: FALLBACK_PROMPT,
      userPrompt: `Rewrite the following into the required JSON only.\n\n${raw}`
    })

    return { parsed: this.parse(repair.raw) }
  }

  private collectQualityFlags(answerEn: string, riskFlags: string[]): string[] {
    const flags = [...riskFlags]
    const lower = answerEn.toLowerCase()
    if (!/\b(i|i'm|i've|my|we|our)\b/.test(lower)) {
      flags.push('not_first_person')
    }
    if (answerEn.split(/\s+/).length < 35) {
      flags.push('too_short')
    }
    if (answerEn.length > 900) {
      flags.push('too_long')
    }
    return Array.from(new Set(flags))
  }

  private async translateIfEnabled(
    text: string,
    providerConfig: ProviderConfig,
    targetLanguage: string,
    signal: AbortSignal
  ): Promise<string> {
    if (!providerConfig.translation.enabled || !targetLanguage || !text.trim()) {
      return ''
    }

    try {
      return await this.translationProvider.translate({
        kind: providerConfig.translation.kind,
        model: providerConfig.translation.model,
        baseUrl: providerConfig.translation.baseUrl,
        apiKey: providerConfig.translation.apiKey,
        sourceLanguage: 'en',
        targetLanguage,
        text,
        signal
      })
    } catch {
      return ''
    }
  }

  private async translateQuestionIfEnabled(
    text: string,
    providerConfig: ProviderConfig,
    signal: AbortSignal
  ): Promise<string> {
    if (!providerConfig.translation.enabled || !text.trim()) {
      return ''
    }

    try {
      return await this.translationProvider.translate({
        kind: providerConfig.translation.kind,
        model: providerConfig.translation.model,
        baseUrl: providerConfig.translation.baseUrl,
        apiKey: providerConfig.translation.apiKey,
        sourceLanguage: 'en',
        targetLanguage: 'tr',
        text,
        signal
      })
    } catch {
      return ''
    }
  }
}



