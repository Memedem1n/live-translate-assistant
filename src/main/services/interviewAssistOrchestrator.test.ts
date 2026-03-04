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
        replyEn: 'Sample answer',
        replyTr: 'Ornek cevap',
        translationTr: 'Ornek ceviri'
      })
    } as any
    const profileMemory = {
      getContextLines: vi.fn().mockReturnValue(['[profile:cv] built scalable backend systems'])
    } as any

    const orchestrator = new InterviewAssistOrchestrator(assistService, profileMemory)
    const result = await orchestrator.generate({
      model: 'qwen2.5:7b-instruct-q4_K_M',
      baseUrl: 'http://127.0.0.1:11434',
      transcriptId: 't1',
      sourceText: 'Tell me about your backend experience',
      sourceLanguage: 'en',
      outputPolicy: 'source_based',
      contextLines: ['[remote] tell me about your backend experience'],
      assistantMode: 'interview',
      personalizationEnabled: true,
      assistPersonalizationPolicy: 'intent_aware',
      assistCompositionPolicy: 'auto',
      assistLanguagePolicy: 'auto',
      answerStyle: 'star_short_30s'
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
      model: 'qwen2.5:7b-instruct-q4_K_M',
      baseUrl: 'http://127.0.0.1:11434',
      transcriptId: 't2',
      sourceText: 'What are your strengths?',
      sourceLanguage: 'en',
      outputPolicy: 'source_based',
      contextLines: [],
      assistantMode: 'meeting',
      personalizationEnabled: false,
      assistPersonalizationPolicy: 'intent_aware',
      assistCompositionPolicy: 'auto',
      assistLanguagePolicy: 'auto',
      answerStyle: 'star_short_30s'
    })

    const input = assistService.generate.mock.calls[0][0]
    expect(input.personalizedContextLines).toEqual([])
    expect(result.personalizationMode).toBe('generic_fallback')
  })
})
