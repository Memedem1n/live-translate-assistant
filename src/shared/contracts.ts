export type Speaker = 'remote' | 'self'
export type SessionPhase = 'idle' | 'starting' | 'running' | 'degraded' | 'stopping' | 'error'
export type VadApplyMode = 'live' | 'restart'
export type ReconnectState = 'stable' | 'retrying' | 'fallback' | 'failed'

export interface TranscriptEvent {
  id: string
  speaker: Speaker
  textEn: string
  isFinal: boolean
  tStartMs: number
  tEndMs: number
  emittedMs: number
  confidence: number
}

export interface AssistEvent {
  id: string
  transcriptId: string
  translationTr?: string
  replyEn?: string
  replyTr?: string
  confidence?: number
  latencyMs: number
  firstTokenMs?: number
  fallbackUsed?: boolean
  parseMode?: 'primary' | 'fallback'
  state: 'partial' | 'final' | 'error'
  rawText?: string
  error?: string
}

export interface HotkeySettings {
  toggleOverlay: string
  muteSuggestions: string
  panicHide: string
}

export interface VadChannelConfig {
  minAudioMs: number
  silenceMs: number
  voiceRmsThreshold: number
}

export interface VadConfig {
  remote: VadChannelConfig
  self: VadChannelConfig
}

export interface WorkerDiagnosticsEvent {
  tsMs: number
  remoteRms: number
  selfRms: number
  droppedRemote: number
  droppedSelf: number
}

export interface CaptureDiagnosticsEvent extends WorkerDiagnosticsEvent {
  reconnectState: ReconnectState
  reconnectAttempt: number
  activeSourceId: string
  activeSourceName: string
}

export interface LatencyStatSummary {
  latest: number | null
  p50: number | null
  p95: number | null
  count: number
}

export interface LatencyMetricsEvent {
  sttFirstChunkMs: LatencyStatSummary
  assistFirstTokenMs: LatencyStatSummary
  assistFinalMs: LatencyStatSummary
  workerErrorRate: number
  updatedAtMs: number
}

export type HistoryExportFormat = 'json' | 'markdown'

export interface SessionHistoryRecord {
  id: string
  startedAtMs: number
  endedAtMs: number
  sttModel: string
  answerModel: string
  transcripts: TranscriptEvent[]
  assists: AssistEvent[]
}

export interface HistorySessionSummary {
  id: string
  startedAtMs: number
  endedAtMs: number
  persistedAtMs: number
  transcriptCount: number
  assistCount: number
}

export interface HistoryListResult {
  encryptionAvailable: boolean
  sessions: HistorySessionSummary[]
}

export interface HistoryExportRequest {
  format: HistoryExportFormat
  sessionId?: string
}

export interface HistoryExportResult {
  success: boolean
  format: HistoryExportFormat
  path: string
  sessionId: string
}

export interface AppSettings {
  sttModel: string
  answerModel: string
  ollamaBaseUrl: string
  overlayOpacity: number
  overlayVisible: boolean
  overlayClickThrough: boolean
  autoHideControlWindow: boolean
  systemAudioMode: 'auto' | 'manual'
  manualSystemSourceId: string
  historyOptIn: boolean
  hotkeys: HotkeySettings
  vad: VadConfig
  vadApplyMode: VadApplyMode
}

export interface SessionStartRequest {
  mode: 'meeting'
  sttModel?: string
  vad?: VadConfig
}

export interface SessionUpdateVadRequest {
  vad: VadConfig
  applyMode?: VadApplyMode
}

export interface OverlaySettings {
  visible?: boolean
  opacity?: number
  clickThrough?: boolean
}

export interface OverlayStateEvent {
  visible: boolean
  opacity: number
  clickThrough: boolean
}

export interface AudioSourceItem {
  id: string
  name: string
}

export interface AudioChunkInput {
  speaker: Speaker
  pcmBase64: string
  sampleRate: number
}

export interface TranscriptInjection {
  speaker: Speaker
  textEn: string
}

export interface SessionStateEvent {
  active: boolean
  muted: boolean
  phase: SessionPhase
  workerReady: boolean
  reason?: string
  lastError?: string
}

export interface WindowAPI {
  getSettings: () => Promise<AppSettings>
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>
  startSession: (payload: SessionStartRequest) => Promise<{ success: boolean }>
  stopSession: () => Promise<{ success: boolean }>
  updateSessionVad: (
    payload: SessionUpdateVadRequest
  ) => Promise<{ success: boolean; applied: boolean; requiresRestart: boolean }>
  getAudioSources: () => Promise<AudioSourceItem[]>
  sendAudioChunk: (chunk: AudioChunkInput) => void
  injectTranscript: (payload: TranscriptInjection) => Promise<{ success: boolean }>
  listHistorySessions: () => Promise<HistoryListResult>
  exportSessionHistory: (payload: HistoryExportRequest) => Promise<HistoryExportResult>
  setOverlay: (settings: OverlaySettings) => Promise<{ success: boolean }>
  hideControlWindow: () => Promise<{ success: boolean }>
  showControlWindow: () => Promise<{ success: boolean }>
  toggleControlWindowVisibility: () => Promise<{ success: boolean; visible: boolean }>
  onTranscriptFinal: (cb: (event: TranscriptEvent) => void) => () => void
  onAssistUpdate: (cb: (event: AssistEvent) => void) => () => void
  onSessionState: (cb: (event: SessionStateEvent) => void) => () => void
  onOverlayState: (cb: (event: OverlayStateEvent) => void) => () => void
  onDiagnosticsUpdate: (cb: (event: WorkerDiagnosticsEvent) => void) => () => void
  onLatencyMetrics: (cb: (event: LatencyMetricsEvent) => void) => () => void
  onShortcutMuteToggle: (cb: (muted: boolean) => void) => () => void
}
