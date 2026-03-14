import {
  AssistEvent,
  CaptureDiagnosticsEvent,
  ProfileSourceType,
  ReviewLabel,
  SessionStateEvent,
  TranscriptEvent
} from '../../../../shared/contracts'

export type CapturePhase =
  | 'idle'
  | 'waiting_for_source'
  | 'running'
  | 'reconnecting_audio'
  | 'degraded_listening'

export type ControlTab = 'live' | 'practice' | 'prepare'

export const PROFILE_PRESETS = [
  { id: 'llama3_1_8b_primary', title: 'Balanced', model: 'llama3.1:8b-instruct-q4_K_M' },
  { id: 'qwen2_5_7b_latency', title: 'Fast', model: 'qwen2.5:7b-instruct-q4_K_M' },
  { id: 'mistral_7b_natural', title: 'Natural', model: 'mistral:7b-instruct-v0.3-q4_K_M' }
] as const

export const STT_MODELS = ['medium.en', 'large-v3-turbo', 'large-v3']

export const SOURCE_LABEL: Record<ProfileSourceType, string> = {
  cv: 'CV',
  github: 'GitHub',
  linkedin: 'LinkedIn',
  job_desc: 'Job Description',
  note: 'Notes',
  knowledge_base: 'Knowledge Base',
  web_corpus: 'Web Corpus',
  glossary: 'Glossary'
}

export const IMPORTABLE_SOURCE_TYPES: ProfileSourceType[] = ['cv', 'linkedin', 'job_desc', 'note']

export const CHOSEN_TAGS = [
  'grounded',
  'concise',
  'star_ready',
  'technical_tradeoff',
  'calming',
  'accurate'
]

export const REJECTED_TAGS = [
  'too_long',
  'generic',
  'hallucinated',
  'role_confusion',
  'asks_question_back',
  'not_first_person',
  'too_vague',
  'overconfident'
]

export function mainAnswer(item?: AssistEvent | null): string {
  return item?.answerEn || item?.rawText || 'Waiting for an answer...'
}

export function helperAnswer(item?: AssistEvent | null): string {
  return item?.helperAnswerTr || item?.questionTr || 'No helper text yet.'
}

export function reviewLabelOf(item?: AssistEvent | null): ReviewLabel {
  return item?.reviewLabel || 'unreviewed'
}

export function reviewTagsFor(label: ReviewLabel): string[] {
  if (label === 'chosen') return CHOSEN_TAGS
  if (label === 'rejected') return REJECTED_TAGS
  return []
}

export function getFriendlySessionLabel(
  session: SessionStateEvent,
  capturePhase: CapturePhase
): string {
  if (!session.active && session.phase === 'idle') return 'Ready'
  if (capturePhase === 'waiting_for_source') return 'Choose audio source'
  if (capturePhase === 'reconnecting_audio') return 'Reconnecting audio'
  if (capturePhase === 'degraded_listening') return 'Needs attention'

  if (session.phase === 'starting') return 'Starting'
  if (session.phase === 'running') return session.muted ? 'Muted' : 'Listening'
  if (session.phase === 'degraded') return 'Running with warning'
  if (session.phase === 'stopping') return 'Stopping'
  if (session.phase === 'error') return 'Needs attention'
  return 'Ready'
}

export function getCaptureStatusLabel(
  capturePhase: CapturePhase,
  captureDiagnostics: CaptureDiagnosticsEvent | null
): string {
  if (capturePhase === 'waiting_for_source') return 'Waiting for source'
  if (capturePhase === 'reconnecting_audio') return 'Reconnecting'
  if (capturePhase === 'degraded_listening') return 'Needs new source'
  if (captureDiagnostics?.sourceHealth === 'switching') return 'Switching source'
  if (capturePhase === 'running') return 'Listening'
  return 'Idle'
}

export function getSessionIssueMessage(
  session: SessionStateEvent,
  capturePhase: CapturePhase,
  captureDiagnostics: CaptureDiagnosticsEvent | null,
  fallbackError: string | null
): string | null {
  const normalizedSessionError = String(session.lastError || '').trim()

  const captureErrorCode = captureDiagnostics?.lastErrorCode
  if (captureErrorCode) {
    if (captureErrorCode === 'permission_denied') {
      return 'Screen or system-audio capture permission is missing. Reopen the picker and allow access.'
    }
    if (captureErrorCode === 'device_not_found') {
      return 'The selected audio source is no longer available. Choose another tab, window, or screen.'
    }
    if (captureErrorCode === 'device_busy') {
      return 'The selected audio source is busy or blocked by another app. Close the conflicting app or choose another source.'
    }
    if (captureErrorCode === 'stream_aborted') {
      return 'The audio stream was interrupted. Re-select the source to continue listening.'
    }
    if (captureErrorCode === 'microphone_unavailable') {
      return 'Microphone access is unavailable. The session can continue with system audio only.'
    }
    return captureDiagnostics?.lastErrorMessage || fallbackError
  }

  if (capturePhase === 'degraded_listening') {
    return 'Audio capture needs a new source. Use Change source to reconnect.'
  }

  if (session.reason === 'assist_prewarm_failed') {
    if (/status 404/i.test(normalizedSessionError)) {
      return 'Answer model warning: the selected Ollama model was not found. Pick another answer profile or pull that model locally.'
    }
    return session.lastError
      ? `Answer model warmup warning: ${session.lastError}`
      : 'Answer model warmup failed. The next answer may be slower.'
  }

  if (session.reason === 'stt_runtime_degraded' || session.reason === 'stt_runtime_fallback') {
    return session.lastError
      ? `Speech recognition warning: ${session.lastError}`
      : 'Speech recognition is running with reduced capability.'
  }

  if (session.reason === 'worker_error') {
    return session.lastError
      ? `Speech recognition warning: ${session.lastError}`
      : 'Speech recognition hit a recoverable worker warning.'
  }

  if (session.reason === 'stt_runtime_error') {
    return session.lastError
      ? `Speech recognition error: ${session.lastError}`
      : 'Speech recognition hit an unrecoverable runtime error.'
  }

  if (session.reason === 'worker_stopped_unexpectedly') {
    return 'Speech recognition worker stopped unexpectedly. Restart the session.'
  }

  if (session.reason === 'start_failed') {
    return session.lastError ? `Startup failed: ${session.lastError}` : 'Startup failed.'
  }

  return fallbackError
}

export function getActiveQuestion(transcripts: TranscriptEvent[]): TranscriptEvent | null {
  return [...transcripts].reverse().find((item) => item.speaker === 'remote') || null
}

export function getLatestAssist(assistUpdates: AssistEvent[]): AssistEvent | null {
  return [...assistUpdates].reverse().find((item) => item.state !== 'error') || null
}

export function getRecentTimeline(transcripts: TranscriptEvent[]): TranscriptEvent[] {
  return transcripts.slice(-8).reverse()
}

export function findAssistForTranscript(
  assistUpdates: AssistEvent[],
  transcriptId: string
): AssistEvent | null {
  return [...assistUpdates].reverse().find((item) => item.transcriptId === transcriptId && item.state !== 'error') || null
}

export function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}
