import { randomUUID } from 'node:crypto'
import { AssistEvent } from '../../shared/contracts'

interface GenerateAssistInput {
  model: string
  baseUrl: string
  transcriptId: string
  remoteQuestion: string
  contextLines: string[]
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

const DEFAULT_TIMEOUT_MS = 12000
const PRIMARY_PROMPT =
  'You are a live meeting assistant. Output strict JSON only: {"translation_tr":"...","reply_en":"...","reply_tr":"...","confidence":0.0}. Keep technical terms in English when needed. Replies must be concise and actionable.'
const FALLBACK_PROMPT =
  'Return valid minified JSON only. No markdown, no explanation. Keys required: translation_tr, reply_en, reply_tr, confidence. confidence must be 0.0-1.0.'

export class AssistService {
  async generate(input: GenerateAssistInput): Promise<AssistEvent> {
    const start = Date.now()
    const partialId = randomUUID()

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
      const primary = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        stream: true,
        systemPrompt: PRIMARY_PROMPT,
        remoteQuestion: input.remoteQuestion,
        contextLines: input.contextLines,
        onPartial: (raw, firstTokenMs) => {
          input.onPartial?.({
            id: partialId,
            transcriptId: input.transcriptId,
            state: 'partial',
            rawText: raw,
            latencyMs: Date.now() - start,
            firstTokenMs: firstTokenMs ?? undefined
          })
        }
      })

      const primaryParsed = this.tryParseAssist(primary.raw)
      if (primaryParsed) {
        const primaryHeuristic = this.estimateConfidence(primaryParsed)
        if (primaryHeuristic >= 0.55) {
          return {
            id: partialId,
            transcriptId: input.transcriptId,
            state: 'final',
            translationTr: primaryParsed.translationTr,
            replyEn: primaryParsed.replyEn,
            replyTr: primaryParsed.replyTr,
            confidence: primaryHeuristic,
            latencyMs: Date.now() - start,
            firstTokenMs: primary.firstTokenMs ?? undefined,
            fallbackUsed: false,
            parseMode: 'primary'
          }
        }
      }

      const fallback = await this.requestAssistAttempt({
        model: input.model,
        baseUrl: input.baseUrl,
        signal: controller.signal,
        stream: false,
        systemPrompt: FALLBACK_PROMPT,
        remoteQuestion: input.remoteQuestion,
        contextLines: input.contextLines
      })

      const fallbackParsed = this.parseAssistResponse(fallback.raw)
      const fallbackHeuristic = this.estimateConfidence(fallbackParsed)

      if (primaryParsed) {
        const primaryHeuristic = this.estimateConfidence(primaryParsed)
        if (primaryHeuristic >= fallbackHeuristic - 0.02) {
          return {
            id: partialId,
            transcriptId: input.transcriptId,
            state: 'final',
            translationTr: primaryParsed.translationTr,
            replyEn: primaryParsed.replyEn,
            replyTr: primaryParsed.replyTr,
            confidence: primaryHeuristic,
            latencyMs: Date.now() - start,
            firstTokenMs: primary.firstTokenMs ?? undefined,
            fallbackUsed: true,
            parseMode: 'primary'
          }
        }
      }

      return {
        id: partialId,
        transcriptId: input.transcriptId,
        state: 'final',
        translationTr: fallbackParsed.translationTr,
        replyEn: fallbackParsed.replyEn,
        replyTr: fallbackParsed.replyTr,
        confidence: fallbackHeuristic,
        latencyMs: Date.now() - start,
        firstTokenMs: primary.firstTokenMs ?? fallback.firstTokenMs ?? undefined,
        fallbackUsed: true,
        parseMode: 'fallback'
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

  private async requestAssistAttempt(params: {
    model: string
    baseUrl: string
    signal: AbortSignal
    stream: boolean
    systemPrompt: string
    remoteQuestion: string
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
          num_ctx: 4096
        },
        messages: [
          {
            role: 'system',
            content: params.systemPrompt
          },
          {
            role: 'user',
            content: `Context:\n${params.contextLines.join('\n')}\n\nLatest remote sentence:\n${params.remoteQuestion}`
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

  private tryParseAssist(raw: string): ParsedAssist | null {
    try {
      return this.parseAssistResponse(raw)
    } catch {
      return null
    }
  }

  private parseAssistResponse(raw: string): ParsedAssist {
    const cleaned = raw
      .replace(/^```json/gi, '')
      .replace(/^```/gm, '')
      .replace(/```$/gm, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim()

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

    if (!parsed.translation_tr || !parsed.reply_en || !parsed.reply_tr) {
      throw new Error('Missing required fields from model response.')
    }

    const confidence = Number(parsed.confidence ?? 0.7)

    return {
      translationTr: parsed.translation_tr.trim(),
      replyEn: parsed.reply_en.trim(),
      replyTr: parsed.reply_tr.trim(),
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

  private estimateConfidence(parsed: ParsedAssist): number {
    let score = Number.isFinite(parsed.confidence) ? parsed.confidence : 0.7

    const trLen = parsed.translationTr.length
    const enLen = parsed.replyEn.length
    const trReplyLen = parsed.replyTr.length

    if (trLen < 8) score -= 0.12
    if (enLen < 12) score -= 0.1
    if (trReplyLen < 12) score -= 0.1

    const lowQualityMarkers = /\b(i (cannot|can't)|as an ai|yetersiz|anlayamadim|unknown)\b/i
    if (lowQualityMarkers.test(parsed.replyEn) || lowQualityMarkers.test(parsed.replyTr)) {
      score -= 0.2
    }

    const balancedReply = Math.abs(enLen - trReplyLen) < 80
    if (balancedReply) {
      score += 0.05
    }

    return Math.max(0, Math.min(1, score))
  }
}