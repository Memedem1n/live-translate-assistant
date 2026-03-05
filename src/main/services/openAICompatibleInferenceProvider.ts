import {
  InferenceProvider,
  ProviderGenerateInput,
  ProviderGenerateResult,
  ProviderWarmupInput
} from './inferenceProvider'

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && 'text' in item) {
          return String((item as { text?: unknown }).text || '')
        }
        return ''
      })
      .join('')
  }

  return ''
}

export class OpenAICompatibleInferenceProvider implements InferenceProvider {
  async prewarm(input: ProviderWarmupInput): Promise<number> {
    const startedAt = Date.now()
    await this.generate({
      kind: input.kind,
      model: input.model,
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
      signal: input.signal,
      stream: false,
      systemPrompt: 'Return a short ready signal as plain text.',
      userPrompt: 'ready'
    })
    return Date.now() - startedAt
  }

  async generate(input: ProviderGenerateInput): Promise<ProviderGenerateResult> {
    const startedAt = Date.now()
    const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0.2,
        stream: input.stream !== false,
        messages: [
          {
            role: 'system',
            content: input.systemPrompt
          },
          {
            role: 'user',
            content: input.userPrompt
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`OpenAI-compatible request failed with status ${response.status}`)
    }

    if (input.stream === false) {
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>
      }
      return {
        raw: extractTextContent(payload.choices?.[0]?.message?.content),
        firstTokenMs: Date.now() - startedAt
      }
    }

    if (!response.body) {
      throw new Error('OpenAI-compatible streaming response has no body.')
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
        if (!trimmed.startsWith('data:')) continue

        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue

        let payload: {
          choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>
        }
        try {
          payload = JSON.parse(data)
        } catch {
          continue
        }

        const token = extractTextContent(
          payload.choices?.[0]?.delta?.content ?? payload.choices?.[0]?.message?.content
        )
        if (!token) continue

        raw += token
        if (firstTokenMs === null) {
          firstTokenMs = Date.now() - startedAt
        }
        input.onPartial?.(raw, firstTokenMs)
      }
    }

    return {
      raw,
      firstTokenMs
    }
  }
}
