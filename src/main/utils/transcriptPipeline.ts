import { AssistEvent, TranscriptEvent, WorkerDiagnosticsEvent } from '../../shared/contracts'

export interface RemoteAssistSegment {
  id: string
  speaker: 'remote'
  text: string
  language?: string
  tStartMs: number
  tEndMs: number
  emittedMs: number
  confidence: number
  startedAtMs: number
  updatedAtMs: number
}

export interface SegmentTimingConfig {
  punctuationFlushMs: number
  pauseFlushMs: number
  maxHoldMs: number
}

const TERMINAL_PUNCTUATION = /[.!?]["')\]]?$/

export function mergeTranscriptText(base: string, incoming: string): string {
  const current = base.trim()
  const next = incoming.trim()
  if (!current) return next
  if (!next) return current

  if (current === next) return current
  if (next.startsWith(current)) return next
  if (current.startsWith(next)) return current

  const stitched = current.endsWith('-') ? `${current.slice(0, -1)}${next}` : `${current} ${next}`
  return stitched.replace(/\s+/g, ' ').trim()
}

export function normalizeSpeechText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function tokenJaccard(a: string, b: string): number {
  const aTokens = new Set(normalizeSpeechText(a).split(' ').filter(Boolean))
  const bTokens = new Set(normalizeSpeechText(b).split(' ').filter(Boolean))
  if (aTokens.size === 0 || bTokens.size === 0) return 0

  let intersection = 0
  for (const token of aTokens) {
    if (bTokens.has(token)) intersection += 1
  }

  const union = new Set([...aTokens, ...bTokens]).size
  return union === 0 ? 0 : intersection / union
}

export function shouldDropSelfTranscriptAsEcho(
  event: TranscriptEvent,
  lastRemoteTranscript: TranscriptEvent | null,
  lastDiagnostics: WorkerDiagnosticsEvent | null,
  options?: {
    echoWindowMs?: number
    echoSimilarity?: number
  }
): boolean {
  if (event.speaker !== 'self') return false

  const text = normalizeSpeechText(event.text || '')
  if (!text) return true
  if (text.length < 3) return true

  if (!lastRemoteTranscript) return false
  const deltaMs = Math.abs(event.emittedMs - lastRemoteTranscript.emittedMs)
  if (deltaMs > (options?.echoWindowMs ?? 3000)) return false

  const eventText = event.text || ''
  const remoteText = lastRemoteTranscript.text || ''
  const similarity = tokenJaccard(eventText, remoteText)
  if (similarity < (options?.echoSimilarity ?? 0.86)) return false

  if (!lastDiagnostics) return false
  if (Math.abs((lastDiagnostics.tsMs || 0) - event.emittedMs) > 2000) return false

  const selfRms = Math.max(0, lastDiagnostics.selfRms)
  const remoteRms = Math.max(0, lastDiagnostics.remoteRms)
  const leakageLikely = selfRms <= Math.max(160, remoteRms * 0.45)
  return leakageLikely
}

export function shouldSplitRemoteSegment(
  current: RemoteAssistSegment | null,
  event: TranscriptEvent,
  mergeGapMs: number
): boolean {
  if (!current) return false
  if (event.speaker !== 'remote') return false
  const gap = Math.max(0, event.emittedMs - current.emittedMs)
  return gap > mergeGapMs
}

export function createRemoteSegment(event: TranscriptEvent, nowMs: number): RemoteAssistSegment {
  const nextText = (event.text || '').trim()
  return {
    id: event.id,
    speaker: 'remote',
    text: nextText,
    language: event.language,
    tStartMs: event.tStartMs,
    tEndMs: event.tEndMs,
    emittedMs: event.emittedMs,
    confidence: event.confidence,
    startedAtMs: nowMs,
    updatedAtMs: nowMs
  }
}

export function appendRemoteSegment(
  current: RemoteAssistSegment,
  event: TranscriptEvent,
  nowMs: number
): RemoteAssistSegment {
  const nextText = (event.text || '').trim()
  return {
    ...current,
    id: event.id,
    text: mergeTranscriptText(current.text, nextText),
    language: event.language || current.language,
    tEndMs: event.tEndMs,
    emittedMs: event.emittedMs,
    confidence: Math.max(0, Math.min(1, (current.confidence + event.confidence) / 2)),
    updatedAtMs: nowMs
  }
}

export function computeSegmentFlushDelay(
  segment: RemoteAssistSegment,
  nowMs: number,
  config: SegmentTimingConfig
): number {
  const elapsed = Math.max(0, nowMs - segment.startedAtMs)
  if (elapsed >= config.maxHoldMs) {
    return 0
  }

  const punctuationDelay = TERMINAL_PUNCTUATION.test(segment.text)
    ? config.punctuationFlushMs
    : config.pauseFlushMs
  const maxRemaining = Math.max(0, config.maxHoldMs - elapsed)
  return Math.max(120, Math.min(punctuationDelay, maxRemaining))
}

export function buildContextLines(
  history: TranscriptEvent[],
  assists: AssistEvent[],
  options?: {
    remoteTurns?: number
    selfTurns?: number
    assistantTurns?: number
    maxCharsPerLine?: number
  }
): string[] {
  const remoteTurns = options?.remoteTurns ?? 10
  const selfTurns = options?.selfTurns ?? 4
  const assistantTurns = options?.assistantTurns ?? 3
  const maxCharsPerLine = options?.maxCharsPerLine ?? 220

  const merged: Array<{ speaker: TranscriptEvent['speaker']; text: string }> = []
  for (const item of history.slice(-120)) {
    const text = (item.text || '').trim()
    if (!text) continue

    const prev = merged[merged.length - 1]
    if (prev && prev.speaker === item.speaker) {
      prev.text = mergeTranscriptText(prev.text, text)
      continue
    }

    merged.push({ speaker: item.speaker, text })
  }

  const selectedIndices = new Set<number>()
  let remoteCount = 0
  let selfCount = 0
  for (let idx = merged.length - 1; idx >= 0; idx -= 1) {
    const turn = merged[idx]
    if (turn.speaker === 'remote' && remoteCount < remoteTurns) {
      selectedIndices.add(idx)
      remoteCount += 1
      continue
    }
    if (turn.speaker === 'self' && selfCount < selfTurns) {
      selectedIndices.add(idx)
      selfCount += 1
    }
    if (remoteCount >= remoteTurns && selfCount >= selfTurns) {
      break
    }
  }

  const orderedConversation = [...selectedIndices]
    .sort((a, b) => a - b)
    .map((idx) => {
      const item = merged[idx]
      const text = item.text.length > maxCharsPerLine ? `${item.text.slice(0, maxCharsPerLine)}...` : item.text
      return `[${item.speaker}] ${text}`.trim()
    })

  const assistantLines = assists
    .filter((item) => item.state === 'final' && !!(item.answerEn || item.helperAnswerTr))
    .slice(-assistantTurns)
    .map((item) => {
      const text = (item.answerEn || item.helperAnswerTr || '').trim()
      const clipped = text.length > maxCharsPerLine ? `${text.slice(0, maxCharsPerLine)}...` : text
      return `[assistant] ${clipped}`.trim()
    })

  return [...orderedConversation, ...assistantLines]
}
