import { describe, expect, it, vi } from 'vitest'
import { AssistService, extractAnswerFromJsonFragment } from './assistService'
import { DisabledTranslationProvider } from './translationProvider'

describe('extractAnswerFromJsonFragment', () => {
  it('returns a spoken partial answer from an incomplete JSON stream', () => {
    const partial =
      '{"answer_en":"I would start by checking the request path and the database indexes, because latency usually comes from one of those two layers'

    expect(extractAnswerFromJsonFragment(partial)).toBe(
      'I would start by checking the request path and the database indexes, because latency usually comes from one of those two layers'
    )
  })

  it('unescapes streamed JSON text fragments', () => {
    const partial =
      '{"answer_en":"I would add a cache first, but I would also watch for stale reads.\\nThen I would validate it with hit-rate metrics'

    expect(extractAnswerFromJsonFragment(partial)).toBe(
      'I would add a cache first, but I would also watch for stale reads. Then I would validate it with hit-rate metrics'
    )
  })

  it('returns an empty string before answer_en appears', () => {
    expect(extractAnswerFromJsonFragment('{"confidence":0.82')).toBe('')
  })

  it('adds an honest lead when personal evidence is missing', async () => {
    const inferenceProvider = {
      prewarm: vi.fn(),
      generate: vi.fn().mockResolvedValue({
        raw: '{"answer_en":"I would start by learning the deployment model and validating it in a small test environment.","confidence":0.84,"risk_flags":[]}',
        firstTokenMs: 120
      })
    }

    const service = new AssistService(inferenceProvider as any, new DisabledTranslationProvider())
    const result = await service.generate({
      providerConfig: {
        inference: {
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'llama3.1:8b-instruct-q4_K_M'
        },
        translation: {
          enabled: false,
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen2.5:3b-instruct-q4_K_M'
        }
      },
      transcriptId: 't1',
      sourceText: 'Have you used Kafka in production before?',
      contextLines: [],
      supportingContextLines: ['[profile:knowledge_base] Kafka decouples producers and consumers.'],
      personalEvidenceLines: [],
      requiresHonestExperienceDisclosure: true,
      intentClass: 'candidate_specific',
      answerMode: 'profile_first'
    })

    expect(result.answerEn).toContain('I have not worked with that directly before')
    expect(result.supportSignals?.riskFlags).toContain('missing_personal_evidence')
  })
})
