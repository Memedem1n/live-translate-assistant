import { describe, expect, it } from 'vitest'
import { AssistEvent, TranscriptEvent, WorkerDiagnosticsEvent } from '../../shared/contracts'
import {
  appendRemoteSegment,
  buildContextLines,
  computeSegmentFlushDelay,
  createRemoteSegment,
  mergeTranscriptText,
  shouldDropSelfTranscriptAsEcho,
  shouldSplitRemoteSegment
} from './transcriptPipeline'

function transcript(partial: Partial<TranscriptEvent> & Pick<TranscriptEvent, 'id' | 'speaker' | 'text'>): TranscriptEvent {
  const now = partial.emittedMs ?? 1000
  return {
    id: partial.id,
    speaker: partial.speaker,
    text: partial.text,
    language: partial.language || 'en',
    languageConfidence: partial.languageConfidence ?? 0.9,
    isFinal: true,
    tStartMs: partial.tStartMs ?? now,
    tEndMs: partial.tEndMs ?? now,
    emittedMs: now,
    confidence: partial.confidence ?? 0.9
  }
}

describe('mergeTranscriptText', () => {
  it('stitches incremental transcripts without duplication', () => {
    expect(mergeTranscriptText('hello wor', 'hello world')).toBe('hello world')
    expect(mergeTranscriptText('micro-', 'phone')).toBe('microphone')
  })
})

describe('remote segment timing', () => {
  it('uses punctuation flush when sentence looks complete', () => {
    const event = transcript({ id: 'r1', speaker: 'remote', text: 'How are you?' })
    const segment = createRemoteSegment(event, 2000)
    const delay = computeSegmentFlushDelay(segment, 2200, {
      punctuationFlushMs: 320,
      pauseFlushMs: 1300,
      maxHoldMs: 5200
    })
    expect(delay).toBe(320)
  })

  it('forces immediate flush when max hold reached', () => {
    const event = transcript({ id: 'r1', speaker: 'remote', text: 'still talking' })
    const segment = createRemoteSegment(event, 2000)
    const delay = computeSegmentFlushDelay(segment, 7200, {
      punctuationFlushMs: 320,
      pauseFlushMs: 1300,
      maxHoldMs: 5200
    })
    expect(delay).toBe(0)
  })

  it('splits segment when long gap is detected', () => {
    const first = transcript({ id: 'r1', speaker: 'remote', text: 'first', emittedMs: 1000 })
    const second = transcript({ id: 'r2', speaker: 'remote', text: 'second', emittedMs: 3205 })
    const segment = createRemoteSegment(first, 1000)
    const merged = appendRemoteSegment(segment, first, 1005)
    expect(shouldSplitRemoteSegment(merged, second, 1800)).toBe(true)
  })
})

describe('buildContextLines', () => {
  it('keeps turn-level context with configured remote/self balance', () => {
    const history: TranscriptEvent[] = [
      transcript({ id: '1', speaker: 'remote', text: 'opening question' }),
      transcript({ id: '2', speaker: 'remote', text: 'with more detail' }),
      transcript({ id: '3', speaker: 'self', text: 'quick answer' }),
      transcript({ id: '4', speaker: 'remote', text: 'follow-up question' }),
      transcript({ id: '5', speaker: 'self', text: 'second answer' }),
      transcript({ id: '6', speaker: 'remote', text: 'final ask' })
    ]

    const assists: AssistEvent[] = [
      {
        id: 'a1',
        transcriptId: '6',
        state: 'final',
        answerEn: 'I would solve this in two steps.',
        helperAnswerTr: 'Bunu iki adimda cozerim.',
        latencyMs: 800
      }
    ]

    const lines = buildContextLines(history, assists, {
      remoteTurns: 2,
      selfTurns: 1,
      assistantTurns: 1
    })

    expect(lines).toEqual([
      '[remote] follow-up question',
      '[self] second answer',
      '[remote] final ask',
      '[assistant] I would solve this in two steps.'
    ])
  })
})

describe('shouldDropSelfTranscriptAsEcho', () => {
  const lastRemote = transcript({
    id: 'r1',
    speaker: 'remote',
    text: 'Can you share the timeline update?',
    emittedMs: 1000
  })

  it('drops self transcript when similarity is high and self rms is low', () => {
    const selfEvent = transcript({
      id: 's1',
      speaker: 'self',
      text: 'can you share the timeline update',
      emittedMs: 1600
    })

    const diagnostics: WorkerDiagnosticsEvent = {
      tsMs: 1600,
      remoteRms: 640,
      selfRms: 120,
      droppedRemote: 0,
      droppedSelf: 0
    }

    expect(shouldDropSelfTranscriptAsEcho(selfEvent, lastRemote, diagnostics)).toBe(true)
  })

  it('keeps self transcript when microphone energy is strong', () => {
    const selfEvent = transcript({
      id: 's2',
      speaker: 'self',
      text: 'can you share the timeline update',
      emittedMs: 1600
    })

    const diagnostics: WorkerDiagnosticsEvent = {
      tsMs: 1600,
      remoteRms: 400,
      selfRms: 420,
      droppedRemote: 0,
      droppedSelf: 0
    }

    expect(shouldDropSelfTranscriptAsEcho(selfEvent, lastRemote, diagnostics)).toBe(false)
  })

  it('supports relaxed similarity/window tuning for echo-heavy setups', () => {
    const selfEvent = transcript({
      id: 's3',
      speaker: 'self',
      text: 'can you share timeline update now',
      emittedMs: 1800
    })

    const diagnostics: WorkerDiagnosticsEvent = {
      tsMs: 1800,
      remoteRms: 700,
      selfRms: 140,
      droppedRemote: 0,
      droppedSelf: 0
    }

    expect(shouldDropSelfTranscriptAsEcho(selfEvent, lastRemote, diagnostics)).toBe(false)
    expect(
      shouldDropSelfTranscriptAsEcho(selfEvent, lastRemote, diagnostics, {
        echoWindowMs: 2500,
        echoSimilarity: 0.7
      })
    ).toBe(true)
  })
})
