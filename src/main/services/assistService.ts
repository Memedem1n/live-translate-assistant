import { randomUUID } from 'node:crypto'
import {
  AssistAnswerMode,
  AssistIntentClass,
  AssistLanguagePolicy,
  AssistEvent,
  AssistOutputPolicy,
  AssistantMode,
  InterviewAnswerStyle
} from '../../shared/contracts'
import { classifyInterviewQuestionFlavor, InterviewQuestionFlavor } from '../utils/assistIntent'

interface GenerateAssistInput {
  model: string
  baseUrl: string
  transcriptId: string
  segmentId?: string
  sourceText: string
  sourceLanguage?: string
  outputPolicy?: AssistOutputPolicy
  contextLines: string[]
  personalizedContextLines?: string[]
  assistantMode?: AssistantMode
  answerStyle?: InterviewAnswerStyle
  intentClass?: AssistIntentClass
  answerMode?: AssistAnswerMode
  languagePolicy?: AssistLanguagePolicy
  signal?: AbortSignal
  timeoutMs?: number
  onPartial?: (event: AssistEvent) => void
}

interface ParsedAssist {
  translationTr: string
  replyEn: string
  replyTr: string
  confidence: number
}

interface AssistAttempt {
  raw: string
  firstTokenMs: number | null
}

interface PrewarmAssistInput {
  model: string
  baseUrl: string
  timeoutMs?: number
}

interface PromptProfile {
  sourceLanguage: 'tr' | 'en' | 'unknown'
  outputPolicy: AssistOutputPolicy
  assistantMode: AssistantMode
  primaryPrompt: string
  fallbackPrompt: string
  requireReplyEn: boolean
  interviewRules?: InterviewReplyRules
}

type InterviewPersonaMode = 'candidate_first_person' | 'neutral_explainer' | 'balanced'

interface InterviewReplyRules {
  minSentences: number
  maxSentences: number
  minWordsPerSentence: number
  personaMode: InterviewPersonaMode
}

interface InterviewReplyValidation {
  ok: boolean
  reasons: string[]
}

const DEFAULT_TIMEOUT_MS = 12000

const PRIMARY_PROMPT_EN =
  'You are a live meeting assistant. Output strict JSON only: {"translation_tr":"...","reply_en":"...","reply_tr":"...","confidence":0.0}. Translation must be faithful and complete, without omitting details. Do not hallucinate facts. Keep technical terms in English when needed. Replies should be concise but specific to the exact sentence.'
const FALLBACK_PROMPT_EN =
  'Return valid minified JSON only. No markdown, no explanation. Keys required: translation_tr, reply_en, reply_tr, confidence. translation_tr must preserve all details from the source sentence. confidence must be 0.0-1.0.'
const PRIMARY_PROMPT_TR =
  'You are a live meeting assistant for Turkish source speech. Output strict JSON only: {"translation_tr":"...","reply_tr":"...","reply_en":"...","confidence":0.0}. translation_tr must preserve the original Turkish meaning fully. reply_tr must be concise and actionable. reply_en may be empty string. No markdown.'
const FALLBACK_PROMPT_TR =
  'Return valid minified JSON only. Keys required: translation_tr, reply_tr, confidence. Optional key: reply_en. Use Turkish for translation_tr and reply_tr. confidence must be 0.0-1.0.'
const INTERVIEW_PROMPT_EN =
  'You are an interview copilot. Output strict JSON only: {"translation_tr":"...","reply_en":"...","reply_tr":"...","confidence":0.0}. Give a direct, natural spoken answer in one flow. Do not use labels such as Situation/Task/Action/Result or Turkish equivalents.'
const INTERVIEW_FALLBACK_EN =
  'Return valid minified JSON only. Required keys: translation_tr, reply_en, reply_tr, confidence. Interview mode: direct natural answer, no markdown, no STAR-style labels.'
const INTERVIEW_PROMPT_TR =
  'Sen bir mulakat asistanisin. Sadece su JSON formatinda cikti ver: {"translation_tr":"...","reply_tr":"...","reply_en":"...","confidence":0.0}. Cevap tek akista, dogal ve direkt olmali. Durum/Gorev/Aksiyon/Sonuc gibi etiketler kullanma.'
const INTERVIEW_FALLBACK_TR =
  'Sadece gecerli minified JSON dondur. Zorunlu alanlar: translation_tr, reply_tr, confidence. Opsiyonel: reply_en. Mulakat modu: direkt dogal cevap, markdown ve STAR etiketleri kullanma.'
const TRANSLATION_REPAIR_PROMPT =
  'Return strict minified JSON only: {"translation_tr":"..."}. Translate the latest remote sentence into Turkish faithfully and fully. No extra keys, no markdown.'
const INTERVIEW_REPLY_REPAIR_PROMPT =
  'Return strict minified JSON only: {"reply_en":"...","reply_tr":"..."}. Rewrite the draft answer only, keep meaning aligned with the latest question, and never output STAR labels.'
const STAR_LABEL_PREFIX_RE =
  /^\s*(durum|gorev|g\u00f6rev|aksiyon|eylem|sonuc|sonu\u00e7|situation|task|action|result)\s*[:\-]\s*/iu
const FIRST_PERSON_MARKERS_RE =
  /\b(i|i'm|i've|i'd|my|mine|we|our|ben|benim|bana|biz|bizim)\b/giu
const MOJIBAKE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\u00c3\u00a7/g, '\u00e7'],
  [/\u00c3\u0087/g, '\u00c7'],
  [/\u00c4\u009f/g, '\u011f'],
  [/\u00c4\u009e/g, '\u011e'],
  [/\u00c5\u009f/g, '\u015f'],
  [/\u00c5\u009e/g, '\u015e'],
  [/\u00c4\u00b1/g, '\u0131'],
  [/\u00c4\u00b0/g, '\u0130'],
  [/\u00c3\u00b6/g, '\u00f6'],
  [/\u00c3\u0096/g, '\u00d6'],
  [/\u00c3\u00bc/g, '\u00fc'],
  [/\u00c3\u009c/g, '\u00dc'],
  [/\u00e2\u0080\u0099/g, "'"],
  [/\u00e2\u0080\u009c/g, '"'],
  [/\u00e2\u0080\u009d/g, '"'],
  [/\u00e2\u0080\u0098/g, "'"],
  [/\u00e2\u0080\u00a2/g, '-']
]

function countMojibakeMarkers(value: string): number {
  return (String(value || '').match(/(?:[\u00c3\u00e2\u00c5\u00c4].)/g) || []).length
}

function normalizeMojibake(value: string): string {
  let output = String(value || '')
  if (!output) return ''

  for (const [pattern, replacement] of MOJIBAKE_REPLACEMENTS) {
    output = output.replace(pattern, replacement)
  }

  if (/[\u00c3\u00e2\u00c5\u00c4]/.test(output)) {
    try {
      const decoded = Buffer.from(output, 'latin1').toString('utf8')
      if (countMojibakeMarkers(decoded) < countMojibakeMarkers(output)) {
        output = decoded
      }
    } catch {
      // Keep best-effort replacement output.
    }
  }

  return output
}

function normalizeSourceLanguage(language?: string): 'tr' | 'en' | 'unknown' {
  const value = String(language || '').trim().toLowerCase()
  if (value.startsWith('tr')) return 'tr'
  if (value.startsWith('en')) return 'en'
  return 'unknown'
}

function unescapePartialJsonString(value: string): string {
  return value
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
}

function extractPartialJsonStringField(raw: string, key: string): string {
  const source = String(raw || '')
  if (!source) return ''

  const keyIndex = source.lastIndexOf(`"${key}"`)
  if (keyIndex === -1) return ''

  let cursor = source.indexOf(':', keyIndex + key.length + 2)
  if (cursor === -1) return ''

  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1
  }

  if (source[cursor] !== '"') {
    return ''
  }
  cursor += 1

  let buffer = ''
  let escaped = false

  for (; cursor < source.length; cursor += 1) {
    const ch = source[cursor]
    if (escaped) {
      buffer += `\\${ch}`
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      break
    }
    buffer += ch
  }

  return unescapePartialJsonString(buffer).trim()
}

export class AssistService {
  async prewarm(input: PrewarmAssistInput): Promise<number> {
    const started = Date.now()
    const timeoutMs = input.timeoutMs ?? 5000
    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort(new Error(`Assist prewarm timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    try {
      await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        stream: false,
        systemPrompt: FALLBACK_PROMPT_EN,
        sourceText: 'warmup ping',
        contextLines: ['[remote] warmup']
      })
      return Date.now() - started
    } finally {
      clearTimeout(timeout)
    }
  }

  async generate(input: GenerateAssistInput): Promise<AssistEvent> {
    const start = Date.now()
    const partialId = randomUUID()
    const sourceText = input.sourceText.trim()
    const interviewFlavor: InterviewQuestionFlavor | undefined =
      input.assistantMode === 'interview'
        ? classifyInterviewQuestionFlavor(sourceText)
        : undefined
    const profile = this.resolvePromptProfile(
      input.sourceLanguage,
      input.outputPolicy,
      input.assistantMode,
      input.answerStyle,
      input.intentClass,
      input.answerMode,
      input.languagePolicy,
      interviewFlavor
    )
    const resolvedContextLines = [
      ...input.contextLines,
      ...(input.personalizedContextLines || [])
    ].slice(-32)

    const controller = new AbortController()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    let timeoutHandle: NodeJS.Timeout | null = setTimeout(() => {
      controller.abort(new Error(`Assist request timed out after ${timeoutMs}ms.`))
    }, timeoutMs)

    const upstreamAbortListener = () => {
      const reason = input.signal?.reason
      if (reason instanceof Error) {
        controller.abort(reason)
      } else {
        controller.abort(new Error(typeof reason === 'string' ? reason : 'Assist request aborted.'))
      }
    }

    if (input.signal) {
      if (input.signal.aborted) {
        upstreamAbortListener()
      } else {
        input.signal.addEventListener('abort', upstreamAbortListener, { once: true })
      }
    }

    try {
      const qualityFlags: string[] = []
      const primary = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        stream: true,
        systemPrompt: profile.primaryPrompt,
        sourceText,
        contextLines: resolvedContextLines,
        onPartial: (raw, firstTokenMs) => {
          const partialTranslationTr = extractPartialJsonStringField(raw, 'translation_tr')
          const partialReplyTr = this.sanitizeReplyText(extractPartialJsonStringField(raw, 'reply_tr'))
          const partialReplyEn = this.sanitizeReplyText(extractPartialJsonStringField(raw, 'reply_en'))

          input.onPartial?.({
            id: partialId,
            transcriptId: input.transcriptId,
            segmentId: input.segmentId,
            sourceLanguage: profile.sourceLanguage,
            sourceText,
            outputPolicy: profile.outputPolicy,
            personalizationMode:
              input.personalizedContextLines && input.personalizedContextLines.length > 0
                ? 'personalized'
                : 'generic_fallback',
            intentClass: input.intentClass,
            answerMode: input.answerMode,
            languagePolicy: input.languagePolicy,
            state: 'partial',
            translationTr: partialTranslationTr || undefined,
            replyTr: partialReplyTr || undefined,
            replyEn: partialReplyEn || undefined,
            rawText: raw,
            latencyMs: Date.now() - start,
            firstTokenMs: firstTokenMs ?? undefined
          })
        }
      })

      const primaryParsed = this.tryParseAssist(primary.raw, profile.requireReplyEn)
      const primaryHeuristic = primaryParsed
        ? this.estimateConfidence(primaryParsed, profile.requireReplyEn)
        : -1
      if (primaryParsed && primaryHeuristic >= 0.55) {
        const maybeRepaired = await this.maybeRepairTranslation({
          baseParsed: primaryParsed,
          sourceLanguage: profile.sourceLanguage,
          sourceText,
          model: input.model,
          baseUrl: input.baseUrl,
          signal: controller.signal,
          contextLines: resolvedContextLines
        })
        if (maybeRepaired.repaired) {
          qualityFlags.push('translation_retry')
        }
        const maybeShapeRepaired = await this.maybeRepairInterviewReply({
          assistantMode: profile.assistantMode,
          interviewRules: profile.interviewRules,
          baseParsed: maybeRepaired.parsed,
          requireReplyEn: profile.requireReplyEn,
          sourceText,
          model: input.model,
          baseUrl: input.baseUrl,
          signal: controller.signal,
          contextLines: resolvedContextLines
        })
        if (maybeShapeRepaired.repaired) {
          qualityFlags.push('reply_shape_retry')
        } else if (profile.interviewRules && !maybeShapeRepaired.shapeValid) {
          qualityFlags.push('reply_shape_soft_fail')
        }

        const finalParsed = maybeShapeRepaired.parsed

        return {
          id: partialId,
          transcriptId: input.transcriptId,
          segmentId: input.segmentId,
          sourceLanguage: profile.sourceLanguage,
          sourceText,
          outputPolicy: profile.outputPolicy,
          personalizationMode:
            input.personalizedContextLines && input.personalizedContextLines.length > 0
              ? 'personalized'
              : 'generic_fallback',
          intentClass: input.intentClass,
          answerMode: input.answerMode,
          languagePolicy: input.languagePolicy,
          state: 'final',
          translationTr: finalParsed.translationTr,
          replyEn: finalParsed.replyEn,
          replyTr: finalParsed.replyTr,
          confidence: this.estimateConfidence(finalParsed, profile.requireReplyEn),
          qualityFlags,
          latencyMs: Date.now() - start,
          firstTokenMs: primary.firstTokenMs ?? undefined,
          fallbackUsed: false,
          parseMode: 'primary'
        }
      }

      const fallback = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        stream: false,
        systemPrompt: profile.fallbackPrompt,
        sourceText,
        contextLines: resolvedContextLines
      })

      const fallbackParsed = this.parseAssistResponse(fallback.raw, profile.requireReplyEn)
      const fallbackHeuristic = this.estimateConfidence(fallbackParsed, profile.requireReplyEn)

      let winner = fallbackParsed
      let winnerHeuristic = fallbackHeuristic
      let parseMode: 'primary' | 'fallback' = 'fallback'

      if (primaryParsed) {
        if (primaryHeuristic >= fallbackHeuristic - 0.02) {
          winner = primaryParsed
          winnerHeuristic = primaryHeuristic
          parseMode = 'primary'
        }
      }

      const maybeRepaired = await this.maybeRepairTranslation({
        baseParsed: winner,
        sourceLanguage: profile.sourceLanguage,
        sourceText,
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        contextLines: resolvedContextLines
      })
      if (maybeRepaired.repaired) {
        qualityFlags.push('translation_retry')
        winnerHeuristic = this.estimateConfidence(maybeRepaired.parsed, profile.requireReplyEn)
      }
      const maybeShapeRepaired = await this.maybeRepairInterviewReply({
        assistantMode: profile.assistantMode,
        interviewRules: profile.interviewRules,
        baseParsed: maybeRepaired.parsed,
        requireReplyEn: profile.requireReplyEn,
        sourceText,
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        contextLines: resolvedContextLines
      })
      if (maybeShapeRepaired.repaired) {
        qualityFlags.push('reply_shape_retry')
      } else if (profile.interviewRules && !maybeShapeRepaired.shapeValid) {
        qualityFlags.push('reply_shape_soft_fail')
      }

      const finalParsed = maybeShapeRepaired.parsed
      winnerHeuristic = this.estimateConfidence(finalParsed, profile.requireReplyEn)

      return {
        id: partialId,
        transcriptId: input.transcriptId,
        segmentId: input.segmentId,
        sourceLanguage: profile.sourceLanguage,
        sourceText,
        outputPolicy: profile.outputPolicy,
        personalizationMode:
          input.personalizedContextLines && input.personalizedContextLines.length > 0
            ? 'personalized'
            : 'generic_fallback',
        intentClass: input.intentClass,
        answerMode: input.answerMode,
        languagePolicy: input.languagePolicy,
        state: 'final',
        translationTr: finalParsed.translationTr,
        replyEn: finalParsed.replyEn,
        replyTr: finalParsed.replyTr,
        confidence: winnerHeuristic,
        qualityFlags,
        latencyMs: Date.now() - start,
        firstTokenMs: primary.firstTokenMs ?? fallback.firstTokenMs ?? undefined,
        fallbackUsed: true,
        parseMode
      }
    } catch (error) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof Error) {
          throw reason
        }
        throw new Error(typeof reason === 'string' ? reason : 'Assist request aborted.')
      }

      throw error instanceof Error ? error : new Error('Assist request failed.')
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle)
        timeoutHandle = null
      }
      if (input.signal) {
        input.signal.removeEventListener('abort', upstreamAbortListener)
      }
    }
  }

  private resolvePromptProfile(
    sourceLanguage?: string,
    outputPolicy: AssistOutputPolicy = 'source_based',
    assistantMode: AssistantMode = 'meeting',
    answerStyle: InterviewAnswerStyle = 'star_short_30s',
    intentClass: AssistIntentClass = 'mixed',
    answerMode: AssistAnswerMode = 'balanced',
    languagePolicy: AssistLanguagePolicy = 'auto',
    questionFlavor: InterviewQuestionFlavor = 'mixed'
  ): PromptProfile {
    const normalizedLanguage = normalizeSourceLanguage(sourceLanguage)
    const styleHint =
      answerStyle === 'star_short_30s' ? ' Keep the answer complete but compact for interview pace.' : ''

    if (assistantMode === 'interview') {
      const requireReplyEn = this.shouldRequireReplyEn(languagePolicy, normalizedLanguage)
      const preferTrPrompt = languagePolicy === 'tr' || normalizedLanguage === 'tr'
      const interviewRules = this.resolveInterviewReplyRules(intentClass, questionFlavor)
      const policyHint = this.buildInterviewPolicyHint(
        intentClass,
        answerMode,
        languagePolicy,
        questionFlavor,
        interviewRules
      )
      const primaryBase = preferTrPrompt ? INTERVIEW_PROMPT_TR : INTERVIEW_PROMPT_EN
      const fallbackBase = preferTrPrompt ? INTERVIEW_FALLBACK_TR : INTERVIEW_FALLBACK_EN
      return {
        sourceLanguage: normalizedLanguage,
        outputPolicy,
        assistantMode,
        primaryPrompt: `${primaryBase}${styleHint} ${policyHint}`.trim(),
        fallbackPrompt: `${fallbackBase}${styleHint} ${policyHint}`.trim(),
        requireReplyEn,
        interviewRules
      }
    }

    if (outputPolicy === 'bilingual') {
      return {
        sourceLanguage: normalizedLanguage,
        outputPolicy,
        assistantMode,
        primaryPrompt: PRIMARY_PROMPT_EN,
        fallbackPrompt: FALLBACK_PROMPT_EN,
        requireReplyEn: true
      }
    }

    if (normalizedLanguage === 'tr') {
      return {
        sourceLanguage: normalizedLanguage,
        outputPolicy,
        assistantMode,
        primaryPrompt: PRIMARY_PROMPT_TR,
        fallbackPrompt: FALLBACK_PROMPT_TR,
        requireReplyEn: false
      }
    }

    return {
      sourceLanguage: normalizedLanguage,
      outputPolicy,
      assistantMode,
      primaryPrompt: PRIMARY_PROMPT_EN,
      fallbackPrompt: FALLBACK_PROMPT_EN,
      requireReplyEn: true
    }
  }

  private shouldRequireReplyEn(
    languagePolicy: AssistLanguagePolicy,
    sourceLanguage: 'tr' | 'en' | 'unknown'
  ): boolean {
    if (languagePolicy === 'tr') {
      return false
    }
    if (languagePolicy === 'bilingual') {
      return true
    }
    return sourceLanguage !== 'tr'
  }

  private buildInterviewPolicyHint(
    intentClass: AssistIntentClass,
    answerMode: AssistAnswerMode,
    languagePolicy: AssistLanguagePolicy,
    questionFlavor: InterviewQuestionFlavor,
    rules: InterviewReplyRules
  ): string {
    const intentHint =
      intentClass === 'technical_general'
        ? 'Question intent is technical_general: answer the concept first, then add candidate context only if it directly helps.'
        : intentClass === 'candidate_specific'
          ? 'Question intent is candidate_specific: prioritize concrete candidate evidence from provided context.'
          : 'Question intent is mixed: give one short general explanation, then one concise candidate-linked example.'

    const answerModeHint =
      answerMode === 'profile_only'
        ? 'Answer mode is profile_only: avoid generic textbook filler and stay within provided profile evidence.'
        : answerMode === 'general_first'
          ? 'Answer mode is general_first: first explain generally, then optionally map to candidate profile.'
          : answerMode === 'profile_first'
          ? 'Answer mode is profile_first: lead with candidate experience and add short general framing only if needed.'
            : 'Answer mode is balanced: blend general concept and candidate evidence without overfocusing on either.'

    const personaHint =
      rules.personaMode === 'neutral_explainer'
        ? 'Persona rule: use a neutral explanatory tone and avoid writing as if you personally performed the action.'
        : rules.personaMode === 'candidate_first_person'
          ? 'Persona rule: answer in first person with realistic candidate narration when the question is personal.'
          : 'Persona rule: blend concise concept framing with one grounded first-person example.'

    const flavorHint =
      questionFlavor === 'personal_daily'
        ? 'Question flavor is personal_daily: describe a believable day-in-the-life workflow.'
        : 'Question flavor is not personal_daily: keep claims aligned to interview scope and avoid fictional stories.'

    const languageHint =
      languagePolicy === 'tr'
        ? 'Language policy is tr: prioritize reply_tr, keep reply_en empty unless explicitly needed.'
        : languagePolicy === 'bilingual'
          ? 'Language policy is bilingual: always provide both reply_tr and reply_en with matching meaning.'
          : 'Language policy is auto: keep translation_tr faithful and choose reply language naturally.'

    const lengthHint = `Length rule: write ${rules.minSentences}-${rules.maxSentences} complete sentences, each at least ${rules.minWordsPerSentence} words.`

    return `${intentHint} ${flavorHint} ${answerModeHint} ${personaHint} ${lengthHint} ${languageHint} Never output section headers or STAR labels.`
  }

  private resolveInterviewReplyRules(
    intentClass: AssistIntentClass,
    questionFlavor: InterviewQuestionFlavor
  ): InterviewReplyRules {
    let personaMode: InterviewPersonaMode = 'balanced'
    if (questionFlavor === 'personal_daily') {
      personaMode = 'candidate_first_person'
    } else if (intentClass === 'technical_general') {
      personaMode = 'neutral_explainer'
    } else if (intentClass === 'candidate_specific') {
      personaMode = 'candidate_first_person'
    }

    return {
      minSentences: 4,
      maxSentences: 5,
      minWordsPerSentence: 10,
      personaMode
    }
  }

  private async requestAssistAttempt(params: {
    model: string
    baseUrl: string
    signal: AbortSignal
    stream: boolean
    systemPrompt: string
    sourceText: string
    contextLines: string[]
    onPartial?: (raw: string, firstTokenMs: number | null) => void
  }): Promise<AssistAttempt> {
    const startedAt = Date.now()
    const response = await fetch(`${params.baseUrl}/api/chat`, {
      method: 'POST',
      signal: params.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: params.model,
        stream: params.stream,
        options: {
          temperature: 0.2,
          num_ctx: 3072
        },
        messages: [
          {
            role: 'system',
            content: params.systemPrompt
          },
          {
            role: 'user',
            content: `Context:\n${params.contextLines.join('\n')}\n\nLatest remote sentence:\n${params.sourceText}`
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`Ollama request failed with status ${response.status}`)
    }

    if (!params.stream) {
      const payload = (await response.json()) as { message?: { content?: string } }
      const raw = payload.message?.content || ''
      return {
        raw,
        firstTokenMs: Date.now() - startedAt
      }
    }

    if (!response.body) {
      throw new Error('Ollama streaming response has no body.')
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let raw = ''
    let firstTokenMs: number | null = null

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let tokenPayload: { message?: { content?: string } }
        try {
          tokenPayload = JSON.parse(trimmed)
        } catch {
          continue
        }

        const token = tokenPayload.message?.content || ''
        if (!token) continue

        raw += token
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - startedAt
        }
        params.onPartial?.(raw, firstTokenMs)
      }
    }

    return {
      raw,
      firstTokenMs
    }
  }

  private tryParseAssist(raw: string, requireReplyEn: boolean): ParsedAssist | null {
    try {
      return this.parseAssistResponse(raw, requireReplyEn)
    } catch {
      return null
    }
  }

  private cleanModelJson(raw: string): string {
    return normalizeMojibake(String(raw || ''))
      .replace(/^```json/gi, '')
      .replace(/^```/gm, '')
      .replace(/```$/gm, '')
      .trim()
  }

  private parseAssistResponse(raw: string, requireReplyEn: boolean): ParsedAssist {
    const cleaned = this.cleanModelJson(raw)

    const direct = this.safeJsonParse(cleaned)
    const matched = direct ? direct : this.safeJsonParse(cleaned.match(/\{[\s\S]*\}/)?.[0] || '')

    if (!matched) {
      throw new Error('Model did not return valid JSON payload.')
    }

    const parsed = matched as {
      translation_tr?: string
      reply_en?: string
      reply_tr?: string
      confidence?: number
    }

    const translationTr = normalizeMojibake((parsed.translation_tr || '').trim())
    const replyTr = this.sanitizeReplyText((parsed.reply_tr || '').trim())
    const replyEn = this.sanitizeReplyText((parsed.reply_en || '').trim())

    if (!translationTr || !replyTr) {
      throw new Error('Missing required fields from model response.')
    }
    if (requireReplyEn && !replyEn) {
      throw new Error('Missing required reply_en from model response.')
    }

    const confidence = Number(parsed.confidence ?? 0.7)

    return {
      translationTr,
      replyEn,
      replyTr,
      confidence: Math.max(0, Math.min(1, confidence))
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

  private sanitizeReplyText(value: string): string {
    const text = normalizeMojibake(String(value || '')).trim()
    if (!text) return ''

    const cleaned = text
      .split(/\r?\n/)
      .map((line) => line.replace(STAR_LABEL_PREFIX_RE, '').replace(/^[-*]\s*/, '').trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim()

    return cleaned
  }

  private isTranslationWeak(text: string): boolean {
    const value = text.trim()
    if (!value) return true
    if (value.length < 8) return true

    const tokens = value.split(/\s+/).filter(Boolean)
    if (tokens.length < 2) return true

    const refusalMarkers = /\b(anlayamadim|yetersiz|unknown|n\/a)\b/i
    if (refusalMarkers.test(value)) return true
    return false
  }

  private async maybeRepairTranslation(input: {
    baseParsed: ParsedAssist
    sourceLanguage: 'tr' | 'en' | 'unknown'
    sourceText: string
    model: string
    baseUrl: string
    signal: AbortSignal
    contextLines: string[]
  }): Promise<{ parsed: ParsedAssist; repaired: boolean }> {
    if (input.sourceLanguage === 'tr') {
      if (!this.isTranslationWeak(input.baseParsed.translationTr)) {
        return { parsed: input.baseParsed, repaired: false }
      }
      return {
        repaired: true,
        parsed: {
          ...input.baseParsed,
          translationTr: input.sourceText
        }
      }
    }

    if (!this.isTranslationWeak(input.baseParsed.translationTr)) {
      return { parsed: input.baseParsed, repaired: false }
    }

    try {
      const repairAttempt = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: input.signal,
        stream: false,
        systemPrompt: TRANSLATION_REPAIR_PROMPT,
        sourceText: input.sourceText,
        contextLines: input.contextLines
      })

      const repairRaw = this.cleanModelJson(repairAttempt.raw)
      const repairParsed = this.safeJsonParse(repairRaw) as { translation_tr?: string } | null
      const replacement = normalizeMojibake((repairParsed?.translation_tr || '').trim())
      if (this.isTranslationWeak(replacement)) {
        return { parsed: input.baseParsed, repaired: false }
      }

      return {
        repaired: true,
        parsed: {
          ...input.baseParsed,
          translationTr: replacement
        }
      }
    } catch {
      return { parsed: input.baseParsed, repaired: false }
    }
  }

  private async maybeRepairInterviewReply(input: {
    assistantMode: AssistantMode
    interviewRules?: InterviewReplyRules
    baseParsed: ParsedAssist
    requireReplyEn: boolean
    sourceText: string
    model: string
    baseUrl: string
    signal: AbortSignal
    contextLines: string[]
  }): Promise<{ parsed: ParsedAssist; repaired: boolean; shapeValid: boolean }> {
    if (input.assistantMode !== 'interview' || !input.interviewRules) {
      return { parsed: input.baseParsed, repaired: false, shapeValid: true }
    }

    const baseReply = input.requireReplyEn ? input.baseParsed.replyEn : input.baseParsed.replyTr
    const baseValidation = this.validateInterviewReplyShape(baseReply, input.interviewRules)
    if (baseValidation.ok) {
      return { parsed: input.baseParsed, repaired: false, shapeValid: true }
    }

    const shapeIssues = baseValidation.reasons.join('; ')
    const repairContext = [
      ...input.contextLines.slice(-20),
      `[draft_reply_en] ${input.baseParsed.replyEn}`,
      `[draft_reply_tr] ${input.baseParsed.replyTr}`,
      `[shape_issues] ${shapeIssues || 'unknown'}`
    ]

    try {
      const repairAttempt = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: input.signal,
        stream: false,
        systemPrompt: this.buildInterviewReplyRepairPrompt(input.interviewRules, input.requireReplyEn),
        sourceText: input.sourceText,
        contextLines: repairContext
      })
      const repaired = this.parseInterviewReplyRepair(
        repairAttempt.raw,
        input.baseParsed,
        input.requireReplyEn
      )
      if (!repaired) {
        return { parsed: input.baseParsed, repaired: false, shapeValid: false }
      }

      const repairedReply = input.requireReplyEn ? repaired.replyEn : repaired.replyTr
      const repairedValidation = this.validateInterviewReplyShape(repairedReply, input.interviewRules)
      if (!repairedValidation.ok) {
        return { parsed: input.baseParsed, repaired: false, shapeValid: false }
      }

      return { parsed: repaired, repaired: true, shapeValid: true }
    } catch {
      return { parsed: input.baseParsed, repaired: false, shapeValid: false }
    }
  }

  private buildInterviewReplyRepairPrompt(
    rules: InterviewReplyRules,
    requireReplyEn: boolean
  ): string {
    const personaHint =
      rules.personaMode === 'neutral_explainer'
        ? 'Use neutral explanatory style, avoid personal first-person storytelling.'
        : rules.personaMode === 'candidate_first_person'
          ? 'Use first-person candidate voice with realistic interview narration.'
          : 'Use balanced style with one short first-person grounding example.'

    const languageHint = requireReplyEn
      ? 'reply_en must be non-empty fluent English. reply_tr must be accurate Turkish translation of reply_en.'
      : 'reply_tr must be non-empty fluent Turkish. reply_en may be empty.'

    const lengthHint = `Write ${rules.minSentences}-${rules.maxSentences} complete sentences, minimum ${rules.minWordsPerSentence} words each.`

    return `${INTERVIEW_REPLY_REPAIR_PROMPT} ${personaHint} ${lengthHint} ${languageHint}`
  }

  private parseInterviewReplyRepair(
    raw: string,
    baseParsed: ParsedAssist,
    requireReplyEn: boolean
  ): ParsedAssist | null {
    const cleaned = this.cleanModelJson(raw)
    const parsed = this.safeJsonParse(cleaned) as
      | {
          reply_en?: string
          reply_tr?: string
        }
      | null

    if (!parsed) {
      return null
    }

    const replyTr = this.sanitizeReplyText((parsed.reply_tr || baseParsed.replyTr).trim())
    const replyEn = this.sanitizeReplyText((parsed.reply_en || baseParsed.replyEn).trim())
    if (!replyTr) {
      return null
    }
    if (requireReplyEn && !replyEn) {
      return null
    }

    return {
      ...baseParsed,
      replyTr,
      replyEn
    }
  }

  private splitSentences(value: string): string[] {
    return normalizeMojibake(value)
      .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
      ?.map((item) => item.trim())
      .filter(Boolean) || []
  }

  private countWords(value: string): number {
    const compact = normalizeMojibake(value)
      .replace(/[^\p{L}\p{N}'-]+/gu, ' ')
      .trim()
    if (!compact) return 0
    return compact.split(/\s+/).filter(Boolean).length
  }

  private countFirstPersonMarkers(value: string): number {
    return normalizeMojibake(value).match(FIRST_PERSON_MARKERS_RE)?.length || 0
  }

  private validateInterviewReplyShape(
    value: string,
    rules: InterviewReplyRules
  ): InterviewReplyValidation {
    const cleaned = this.sanitizeReplyText(value)
    const reasons: string[] = []
    const sentences = this.splitSentences(cleaned)

    if (sentences.length < rules.minSentences || sentences.length > rules.maxSentences) {
      reasons.push(`sentence_count:${sentences.length}`)
    }

    for (let index = 0; index < sentences.length; index += 1) {
      const words = this.countWords(sentences[index])
      if (words < rules.minWordsPerSentence) {
        reasons.push(`sentence_${index + 1}_too_short:${words}`)
      }
    }

    const firstPersonCount = this.countFirstPersonMarkers(cleaned)
    if (rules.personaMode === 'candidate_first_person' && firstPersonCount < 2) {
      reasons.push(`persona_candidate_missing:${firstPersonCount}`)
    }
    if (rules.personaMode === 'neutral_explainer' && firstPersonCount > 1) {
      reasons.push(`persona_neutral_violated:${firstPersonCount}`)
    }
    if (rules.personaMode === 'balanced' && (firstPersonCount < 1 || firstPersonCount > 4)) {
      reasons.push(`persona_balanced_out_of_range:${firstPersonCount}`)
    }

    return {
      ok: reasons.length === 0,
      reasons
    }
  }

  private estimateConfidence(parsed: ParsedAssist, requireReplyEn: boolean): number {
    let score = Number.isFinite(parsed.confidence) ? parsed.confidence : 0.7

    const trLen = parsed.translationTr.length
    const enLen = parsed.replyEn.length
    const trReplyLen = parsed.replyTr.length

    if (trLen < 8) score -= 0.12
    if (requireReplyEn && enLen < 12) score -= 0.1
    if (trReplyLen < 12) score -= 0.1

    const lowQualityMarkers = /\b(i (cannot|can't)|as an ai|yetersiz|anlayamadim|unknown)\b/i
    if (
      lowQualityMarkers.test(parsed.replyTr) ||
      (requireReplyEn && lowQualityMarkers.test(parsed.replyEn))
    ) {
      score -= 0.2
    }

    if (requireReplyEn) {
      const balancedReply = Math.abs(enLen - trReplyLen) < 80
      if (balancedReply) {
        score += 0.05
      }
    }

    return Math.max(0, Math.min(1, score))
  }
}
