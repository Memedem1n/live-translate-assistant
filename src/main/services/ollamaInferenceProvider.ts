import {
  InferenceProvider,
  ProviderGenerateInput,
  ProviderGenerateResult,
  ProviderWarmupInput
} from './inferenceProvider'

async function buildOllamaError(response: Response, model: string): Promise<Error> {
  let detail = ''

  try {
    const raw = await response.text()
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { error?: string }
        detail = String(parsed.error || '').trim()
      } catch {
        detail = raw.trim()
      }
    }
  } catch {
    detail = ''
  }

  if (response.status === 404) {
    const suffix = detail ? ` ${detail}` : ` Model "${model}" was not found in Ollama.`
    return new Error(`Ollama request failed with status 404.${suffix}`)
  }

  return new Error(
    detail
      ? `Ollama request failed with status ${response.status}. ${detail}`
      : `Ollama request failed with status ${response.status}`
  )
}

export class OllamaInferenceProvider implements InferenceProvider {
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
    const response = await fetch(`${input.baseUrl}/api/chat`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        stream: input.stream !== false,
        options: {
          temperature: 0.2,
          num_ctx: 3072
        },
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
      throw await buildOllamaError(response, input.model)
    }

    if (input.stream === false) {
      const payload = (await response.json()) as { message?: { content?: string } }
      return {
        raw: payload.message?.content || '',
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
        input.onPartial?.(raw, firstTokenMs)
      }
    }

    return {
      raw,
      firstTokenMs
    }
  }
}
