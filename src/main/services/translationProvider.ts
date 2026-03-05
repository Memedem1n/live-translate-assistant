import { ProviderKind } from '../../shared/contracts'

export interface TranslationInput {
  kind: ProviderKind
  model: string
  baseUrl: string
  apiKey?: string
  sourceLanguage: string
  targetLanguage: string
  text: string
  signal: AbortSignal
}

export interface TranslationProvider {
  translate(input: TranslationInput): Promise<string>
}

export class DisabledTranslationProvider implements TranslationProvider {
  async translate(): Promise<string> {
    return ''
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  return String(baseUrl || '').replace(/\/+$/, '')
}

function buildSystemPrompt(sourceLanguage: string, targetLanguage: string): string {
  const sourceLabel = sourceLanguage.toLowerCase().startsWith('tr') ? 'Turkish' : 'English'
  const targetLabel = targetLanguage.toLowerCase().startsWith('tr') ? 'Turkish' : 'English'
  return (
    `You are a faithful technical translator. Translate ${sourceLabel} to ${targetLabel}. ` +
    'Keep numbers, product names, API names, and technical tokens intact. Return only the translation.'
  )
}

export class OllamaTranslationProvider implements TranslationProvider {
  async translate(input: TranslationInput): Promise<string> {
    const response = await fetch(`${input.baseUrl}/api/chat`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        stream: false,
        options: {
          temperature: 0
        },
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(input.sourceLanguage, input.targetLanguage)
          },
          {
            role: 'user',
            content: input.text
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`Translation request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as { message?: { content?: string } }
    return String(payload.message?.content || '').trim()
  }
}

export class OpenAICompatibleTranslationProvider implements TranslationProvider {
  async translate(input: TranslationInput): Promise<string> {
    const response = await fetch(`${normalizeBaseUrl(input.baseUrl)}/chat/completions`, {
      method: 'POST',
      signal: input.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {})
      },
      body: JSON.stringify({
        model: input.model,
        temperature: 0,
        stream: false,
        messages: [
          {
            role: 'system',
            content: buildSystemPrompt(input.sourceLanguage, input.targetLanguage)
          },
          {
            role: 'user',
            content: input.text
          }
        ]
      })
    })

    if (!response.ok) {
      throw new Error(`Translation request failed with status ${response.status}`)
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
    }
    const content = payload.choices?.[0]?.message?.content
    if (typeof content === 'string') {
      return content.trim()
    }
    if (Array.isArray(content)) {
      return content.map((item) => String(item?.text || '')).join('').trim()
    }
    return ''
  }
}
