import { randomUUID } from 'node:crypto'
import { AssistEvent } from '../../shared/contracts'

interface GenerateAssistInput {
  model: string
  baseUrl: string
  transcriptId: string
  remoteQuestion: string
  contextLines: string[]
  onPartial?: (event: AssistEvent) => void
}

interface ParsedAssist {
  translationTr: string
  replyEn: string
  replyTr: string
  confidence: number
}

export class AssistService {
  async generate(input: GenerateAssistInput): Promise<AssistEvent> {
    const start = Date.now()
    const partialId = randomUUID()

    const response = await fetch(`${input.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: input.model,
        stream: true,
        options: {
          temperature: 0.3,
          num_ctx: 4096
        },
        messages: [
          {
            role: 'system',
            content:
              'You are a live meeting assistant. Output only valid JSON with this exact schema: {"translation_tr":"...","reply_en":"...","reply_tr":"...","confidence":0.0}. Keep replies short (2-4 sentences). Preserve technical terms in English when needed.'
          },
          {
            role: 'user',
            content: `Context:\n${input.contextLines.join('\n')}\n\nLatest remote sentence:\n${input.remoteQuestion}\n\nReturn strict JSON only.`
          }
        ]
      })
    })

    if (!response.ok || !response.body) {
      throw new Error(`Ollama request failed with status ${response.status}`)
    }

    const decoder = new TextDecoder()
    const reader = response.body.getReader()
    let buffer = ''
    let raw = ''

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
        if (token) {
          raw += token
          input.onPartial?.({
            id: partialId,
            transcriptId: input.transcriptId,
            state: 'partial',
            rawText: raw,
            latencyMs: Date.now() - start
          })
        }
      }
    }

    const parsed = this.parseAssistResponse(raw)

    return {
      id: partialId,
      transcriptId: input.transcriptId,
      state: 'final',
      translationTr: parsed.translationTr,
      replyEn: parsed.replyEn,
      replyTr: parsed.replyTr,
      confidence: parsed.confidence,
      latencyMs: Date.now() - start
    }
  }

  private parseAssistResponse(raw: string): ParsedAssist {
    const cleaned = raw
      .replace(/^```json/gi, '')
      .replace(/^```/gm, '')
      .replace(/```$/gm, '')
      .trim()

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (!jsonMatch) {
      throw new Error('Model did not return valid JSON payload.')
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
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
}
