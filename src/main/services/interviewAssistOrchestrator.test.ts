import { describe, expect, it, vi } from 'vitest'
import { InterviewAssistOrchestrator } from './interviewAssistOrchestrator'

describe('InterviewAssistOrchestrator', () => {
  it('injects personalized context in interview mode', async () => {
    const assistService = {
      generate: vi.fn().mockResolvedValue({
        id: 'a1',
        transcriptId: 't1',
        state: 'final',
        latencyMs: 120,
        answerEn: 'I have built scalable backend systems for production workloads.',
        helperAnswerTr: 'Uretim yuklerinde olceklenebilir backend sistemleri gelistirdim.'
      })
    } as any
    const profileMemory = {
      getContextLines: vi.fn().mockReturnValue(['[profile:cv] built scalable backend systems'])
    } as any

    const orchestrator = new InterviewAssistOrchestrator(assistService, profileMemory)
    const result = await orchestrator.generate({
      providerConfig: {
        inference: {
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'llama3.1:8b-instruct-q4_K_M'
        },
        translation: {
          enabled: true,
          kind: 'ollama',
          baseUrl: 'http://127.0.0.1:11434',
          model: 'qwen2.5:3b-instruct-q4_K_M'
        }
      },
      transcriptId: 't1',
      sourceText: 'Tell me about your backend experience',
      sourceLanguage: 'en',
      contextLines: ['[remote] tell me about your backend experience'],
      productMode: 'interview_live',
      personalizationEnabled: true,
      assistPersonalizationPolicy: 'intent_aware',
      assistCompositionPolicy: 'auto',
      answerStyle: 'natural_first_person'
    })

    expect(assistService.generate).toHaveBeenCalledTimes(1)
    const input = assistService.generate.mock.calls[0][0]
    expect(input.personalizedContextLines.length).toBeGreaterThan(0)
    expect(input.intentClass).toBe('candidate_specific')
    expect(result.personalizationMode).toBe('personalized')
  })

  it('falls back to generic mode when personalization is off', async () => {
    const assistService = {
      generate: vi.fn().mockResolvedValue({
        id: 'a2',
        transcriptId: 't2',
        state: 'final',
        latencyMs: 100
      })
    } as any
    const profileMemory = {
      getContextLines: vi.fn().mockReturnValue(['ignored'])
    } as any

    const orchestrator = new InterviewAssistOrchestrator(assistService, profileMemory)
    const result = await orchestrator.generate({
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
      transcriptId: 't2',
      sourceText: 'What are your strengths?',
      sourceLanguage: 'en',
      contextLines: [],
      productMode: 'interview_live',
      personalizationEnabled: false,
      assistPersonalizationPolicy: 'intent_aware',
      assistCompositionPolicy: 'auto',
      answerStyle: 'natural_first_person'
    })

    const input = assistService.generate.mock.calls[0][0]
    expect(input.personalizedContextLines).toEqual([])
    expect(result.personalizationMode).toBe('generic_fallback')
  })
})
