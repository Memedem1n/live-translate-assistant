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
  supportingContextLines?: string[]
  personalEvidenceLines?: string[]
  requiresHonestExperienceDisclosure?: boolean
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

function isTechnicalDeepResponse(
  intentClass?: AssistIntentClass,
  answerMode?: AssistAnswerMode
): boolean {
  return intentClass === 'technical_general' || (intentClass === 'mixed' && answerMode === 'general_first')
}

function containsHonestyDisclosure(value: string): boolean {
  const text = sanitizeAnswer(value).toLowerCase()
  return (
    /\bi (?:have not|haven't) (?:worked|used|done|built|led|managed|owned)\b/.test(text) ||
    /\bi do not have direct\b/.test(text) ||
    /\bi don't have direct\b/.test(text) ||
    /\bnot worked with that directly\b/.test(text) ||
    /\bnot used that directly\b/.test(text) ||
    /\bnot done that directly\b/.test(text)
  )
}

function hasUnsupportedExperienceClaim(value: string): boolean {
  const text = sanitizeAnswer(value).toLowerCase()
  if (containsHonestyDisclosure(text)) {
    return false
  }

  return (
    /\bi worked on\b/.test(text) ||
    /\bi used\b/.test(text) ||
    /\bi built\b/.test(text) ||
    /\bi led\b/.test(text) ||
    /\bi shipped\b/.test(text) ||
    /\bmy experience with\b/.test(text) ||
    /\bi have experience with\b/.test(text) ||
    /\bi've worked with\b/.test(text) ||
    /\bi've used\b/.test(text)
  )
}

function enforceHonestyLead(value: string): string {
  const answer = sanitizeAnswer(value)
  if (!answer) {
    return 'I have not worked with that directly before, but I understand the core ideas and how I would approach it.'
  }
  if (containsHonestyDisclosure(answer)) {
    return answer
  }
  return sanitizeAnswer(
    `I have not worked with that directly before, but I understand the core ideas and how I would approach it. ${answer}`
  )
}

function buildSystemPrompt(
  intentClass?: AssistIntentClass,
  answerMode?: AssistAnswerMode,
  requiresHonestExperienceDisclosure = false
): string {
  let shared =
    'You are a live technical interview copilot. Return strict minified JSON only with keys answer_en, confidence, and risk_flags. ' +
    'Do not use STAR labels. Do not mention being an AI. Stay grounded in the provided persona context and latest interviewer question. '

  if (requiresHonestExperienceDisclosure) {
    shared +=
      'If direct personal experience is not supported by the candidate evidence, explicitly say you have not done it directly. ' +
      'Do not invent projects, ownership, production usage, or prior hands-on work. ' +
      'It is fine to mention conceptual understanding, adjacent experience, and how you would approach the problem honestly. '
  }

  if (isTechnicalDeepResponse(intentClass, answerMode)) {
    return (
      shared +
      'answer_en must sound like a strong candidate speaking naturally in first person, in 7 to 10 spoken sentences. ' +
      'Start with a direct answer, explain the mechanism clearly, include one real tradeoff or failure mode, and end with one concrete example, metric, or validation step. ' +
      'Keep it concise enough to speak in under one minute.'
    )
  }

  if (intentClass === 'mixed') {
    return (
      shared +
      'answer_en must sound like a real candidate speaking in first person, in natural English, in 5 to 7 sentences. ' +
      'Blend concrete personal context with one short technical explanation or tradeoff when useful.'
    )
  }

  return (
    shared +
    'answer_en must sound like a real candidate speaking in first person, in natural English, in 3 to 5 sentences.'
  )
}

export function extractAnswerFromJsonFragment(raw: string): string {
  const cleaned = cleanJson(raw)
  const marker = cleaned.match(/"answer_en"\s*:\s*"/i)
  if (!marker || marker.index === undefined) {
    return ''
  }

  let cursor = marker.index + marker[0].length
  let output = ''
  let escaping = false

  while (cursor < cleaned.length) {
    const char = cleaned[cursor]
    cursor += 1

    if (escaping) {
      if (char === 'n' || char === 'r' || char === 't') {
        output += ' '
      } else if (char === '"' || char === '\\' || char === '/') {
        output += char
      } else if (char === 'u') {
        const hex = cleaned.slice(cursor, cursor + 4)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          output += String.fromCharCode(Number.parseInt(hex, 16))
          cursor += 4
        }
      } else {
        output += char
      }
      escaping = false
      continue
    }

    if (char === '\\') {
      escaping = true
      continue
    }

    if (char === '"') {
      break
    }

    output += char
  }

  return sanitizeAnswer(output)
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
    const personalEvidenceLines = input.personalEvidenceLines || []
    const supportingContextLines = input.supportingContextLines || []
    const personalizationMode: PersonalizationMode =
      personalEvidenceLines.length > 0 ? 'personalized' : 'generic_fallback'
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
        systemPrompt: buildSystemPrompt(
          input.intentClass,
          input.answerMode,
          input.requiresHonestExperienceDisclosure === true
        ),
        userPrompt: this.buildUserPrompt(
          sourceText,
          input.contextLines,
          supportingContextLines,
          personalEvidenceLines,
          input.intentClass,
          input.answerMode,
          input.requiresHonestExperienceDisclosure === true
        ),
        onPartial: (raw, firstTokenMs) => {
          const partialAnswer = extractAnswerFromJsonFragment(raw)
          if (!partialAnswer) return
          const visiblePartialAnswer =
            input.requiresHonestExperienceDisclosure === true
              ? enforceHonestyLead(partialAnswer)
              : partialAnswer
          input.onPartial?.({
            id: partialId,
            transcriptId: input.transcriptId,
            segmentId: input.segmentId,
            sourceLanguage: input.sourceLanguage,
            sourceText,
            state: 'partial',
            answerEn: visiblePartialAnswer,
            rawText: raw,
            latencyMs: Date.now() - start,
            firstTokenMs: firstTokenMs ?? undefined,
            personalizationMode,
            intentClass: input.intentClass,
            answerMode: input.answerMode,
            supportSignals: {
              contextHitCount: supportingContextLines.length,
              confidenceBand: 'medium',
              riskFlags:
                input.requiresHonestExperienceDisclosure === true
                  ? ['missing_personal_evidence']
                  : []
            }
          })
        }
      })

      const parsed = (await this.parseWithFallback(primary.raw, input, controller.signal)).parsed
      const answerEn =
        input.requiresHonestExperienceDisclosure === true
          ? enforceHonestyLead(parsed.answerEn)
          : parsed.answerEn
      const riskFlags = [...parsed.riskFlags]
      if (input.requiresHonestExperienceDisclosure === true) {
        riskFlags.push('missing_personal_evidence')
      }
      if (
        input.requiresHonestExperienceDisclosure === true &&
        hasUnsupportedExperienceClaim(parsed.answerEn)
      ) {
        riskFlags.push('ungrounded_experience_claim')
      }
      const qualityFlags = this.collectQualityFlags(answerEn, riskFlags)
      const helperAnswerTr = await this.translateIfEnabled(
        answerEn,
        input.providerConfig,
        input.providerConfig.translation.enabled && input.providerConfig.translation.model ? 'tr' : '',
        controller.signal
      )
      const questionTr = await this.translateQuestionIfEnabled(sourceText, input.providerConfig, controller.signal)
      const confidencePenalty =
        (input.requiresHonestExperienceDisclosure === true ? 0.08 : 0) +
        (riskFlags.includes('ungrounded_experience_claim') ? 0.14 : 0)
      const finalConfidence = clampConfidence(parsed.confidence - confidencePenalty)
      const final: AssistEvent = {
        id: randomUUID(),
        transcriptId: input.transcriptId,
        segmentId: input.segmentId,
        sourceLanguage: input.sourceLanguage,
        sourceText,
        questionTr: questionTr || undefined,
        answerEn,
        helperAnswerTr: helperAnswerTr || undefined,
        confidence: finalConfidence,
        qualityFlags,
        supportSignals: {
          contextHitCount: supportingContextLines.length,
          confidenceBand: confidenceBand(finalConfidence),
          riskFlags: Array.from(new Set(riskFlags))
        },
        contextLinesUsed: supportingContextLines.slice(0, 8),
        latencyMs: Date.now() - start,
        firstTokenMs: primary.firstTokenMs ?? undefined,
        fallbackUsed: false,
        parseMode: 'primary',
        personalizationMode,
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

  private buildUserPrompt(
    sourceText: string,
    contextLines: string[],
    supportingContextLines: string[],
    personalEvidenceLines: string[],
    intentClass?: AssistIntentClass,
    answerMode?: AssistAnswerMode,
    requiresHonestExperienceDisclosure = false
  ): string {
    const conversationContextBlock =
      contextLines.length > 0 ? contextLines.join('\n') : '[no conversation context]'
    const personalEvidenceBlock =
      personalEvidenceLines.length > 0
        ? personalEvidenceLines.join('\n')
        : '[no matched direct personal evidence found in candidate docs]'
    const supportingContextBlock =
      supportingContextLines.length > 0 ? supportingContextLines.join('\n') : '[no additional supporting context]'
    const personalizationMode: PersonalizationMode =
      personalEvidenceLines.length > 0 ? 'personalized' : 'generic_fallback'
    const technicalDeep = isTechnicalDeepResponse(intentClass, answerMode)

    return [
      `Persona mode: ${personalizationMode}`,
      'Speak as the candidate in first person.',
      requiresHonestExperienceDisclosure
        ? 'Direct personal evidence is missing. Be explicit that you have not done it directly, then answer using adjacent knowledge or a practical approach.'
        : 'Use direct personal evidence when it is present.',
      technicalDeep
        ? 'Answer like a senior engineer candidate: direct answer first, then mechanism, tradeoff, and one concrete example or validation step.'
        : intentClass === 'mixed'
          ? 'Keep the answer practical and specific, using both candidate context and one short technical explanation when useful.'
          : 'Keep the answer practical, specific, and interview-safe.',
      technicalDeep
        ? 'Do not ramble. Prefer crisp spoken sentences that still show engineering depth.'
        : 'Keep the pacing natural and easy to say out loud.',
      '',
      'Direct personal evidence from candidate docs:',
      personalEvidenceBlock,
      '',
      'Supporting context:',
      supportingContextBlock,
      '',
      'Conversation context:',
      conversationContextBlock,
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
