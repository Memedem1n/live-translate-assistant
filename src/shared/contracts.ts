export type Speaker = 'remote' | 'self'
export type SessionPhase = 'idle' | 'starting' | 'running' | 'degraded' | 'stopping' | 'error'
export type VadApplyMode = 'live' | 'restart'
export type ReconnectState = 'stable' | 'retrying' | 'fallback' | 'failed'
export type SttRuntimeMode = 'auto' | 'cuda' | 'cpu'
export type SttRuntimePhase = 'idle' | 'loading' | 'warming' | 'running' | 'degraded' | 'error'
export type SystemAudioStrategy = 'auto_live' | 'picker_each_start' | 'manual'
export type SttLanguageMode = 'segment_auto' | 'session_lock' | 'manual'
export type MeetingLanguage = 'en' | 'tr'
export type AssistOutputPolicy = 'source_based' | 'bilingual'
export type AssistantMode = 'meeting' | 'interview'
export type InterviewAnswerStyle = 'star_short_30s'
export type AssistIntentClass = 'candidate_specific' | 'technical_general' | 'mixed'
export type AssistAnswerMode = 'general_first' | 'profile_first' | 'profile_only' | 'balanced'
export type AssistPersonalizationPolicy = 'intent_aware' | 'always'
export type AssistCompositionPolicy = 'auto' | 'general_then_profile' | 'profile_only'
export type AssistLanguagePolicy = 'auto' | 'tr' | 'bilingual'
export type ProfileSourceType =
  | 'cv'
  | 'github'
  | 'linkedin'
  | 'job_desc'
  | 'note'
  | 'knowledge_base'
  | 'web_corpus'
  | 'glossary'
export type ProfileSyncState = 'idle' | 'running' | 'done' | 'error'
export type ProfileImportOcrMode = 'auto' | 'always' | 'never'
export type ProfileImportParser = 'text' | 'docx' | 'pdf_text' | 'ocr'

export interface TranscriptEvent {
  id: string
  speaker: Speaker
  text: string
  language: string
  languageConfidence?: number
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
  segmentId?: string
  sourceLanguage?: string
  sourceText?: string
  outputPolicy?: AssistOutputPolicy
  translationTr?: string
  replyEn?: string
  replyTr?: string
  confidence?: number
  qualityFlags?: string[]
  latencyMs: number
  firstTokenMs?: number
  fallbackUsed?: boolean
  parseMode?: 'primary' | 'fallback'
  personalizationMode?: 'personalized' | 'generic_fallback'
  intentClass?: AssistIntentClass
  answerMode?: AssistAnswerMode
  languagePolicy?: AssistLanguagePolicy
  state: 'partial' | 'final' | 'error'
  rawText?: string
  error?: string
}

export interface ProfileSourceRecord {
  id: string
  type: ProfileSourceType
  name: string
  importedAtMs: number
  updatedAtMs: number
  contentChars: number
  metadata?: Record<string, string>
}

export interface ProfileSnapshot {
  updatedAtMs: number
  sourceCount: number
  chunkCount: number
  sources: ProfileSourceRecord[]
}

export interface InterviewContextPreviewItem {
  sourceId: string
  sourceType: ProfileSourceType
  sourceName: string
  text: string
  score: number
}

export interface InterviewContextPreview {
  generatedAtMs: number
  items: InterviewContextPreviewItem[]
}

export interface ProfileSyncStatus {
  state: ProfileSyncState
  updatedAtMs: number
  sourceType?: ProfileSourceType
  message?: string
  progress?: number
}

export interface ProfileImportRequest {
  type: ProfileSourceType
  name?: string
  content: string
  metadata?: Record<string, string>
}

export interface ProfileImportResult {
  success: boolean
  source: ProfileSourceRecord
  chunkCount: number
}

export interface ProfileImportFileRequest {
  type: ProfileSourceType
  filePath?: string
  name?: string
  ocrMode?: ProfileImportOcrMode
}

export interface ProfileImportFileResult {
  success: boolean
  cancelled?: boolean
  source?: ProfileSourceRecord
  chunkCount?: number
  filePath?: string
  parser?: ProfileImportParser
  ocrUsed?: boolean
  extractedChars?: number
  warnings?: string[]
}

export interface GithubSyncRequest {
  username: string
  repoNames?: string[]
  token?: string
}

export interface WebCorpusSyncRequest {
  configPath?: string
  outputPath?: string
  maxDocs?: number
  maxPerCategory?: number
  includeSearch?: boolean
  importLimit?: number
  buildGlossary?: boolean
}

export interface WebCorpusSyncResult {
  success: boolean
  outputPath: string
  documentCount: number
  importedSources: number
  importedChunks: number
  warnings?: string[]
  glossaryPath?: string
  glossaryTerms?: number
}

export interface GlossaryIngestRequest {
  glossaryPath?: string
  maxTerms?: number
}

export interface GlossaryIngestResult {
  success: boolean
  glossaryPath: string
  importedSources: number
  importedTerms: number
  warnings?: string[]
}

export interface ProfileReindexResult {
  success: boolean
  sourceCount: number
  chunkCount: number
}

export interface ProfileClearSourceRequest {
  sourceId: string
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
  sourceSwitchCount?: number
  lastErrorCode?: string
  lastErrorMessage?: string
  remoteSilenceMs?: number
  sourceHealth?: 'healthy' | 'suspect' | 'switching'
  lastSwitchReason?: 'low_rms' | 'no_transcript' | 'devicechange' | 'manual_override'
  candidateScores?: Array<{ id: string; peakRms: number; score: number }>
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

export interface SttRuntimeStatusEvent {
  phase: SttRuntimePhase
  requestedMode: SttRuntimeMode
  activeDevice: 'cuda' | 'cpu' | null
  computeType: string | null
  cudaDetected: boolean
  cudaDeviceCount: number
  cudaRetryCount: number
  fallbackToCpuCount: number
  warmupMs: number | null
  lastError?: string
  model?: string
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
  assistantMode: AssistantMode
  personalizationEnabled: boolean
  assistPersonalizationPolicy: AssistPersonalizationPolicy
  assistCompositionPolicy: AssistCompositionPolicy
  assistLanguagePolicy: AssistLanguagePolicy
  githubSyncEnabled: boolean
  interviewAnswerStyle: InterviewAnswerStyle
  sttModel: string
  sttRuntimeMode: SttRuntimeMode
  sttLanguageMode: SttLanguageMode
  manualSttLanguage: MeetingLanguage
  answerModel: string
  assistOutputPolicy: AssistOutputPolicy
  ollamaBaseUrl: string
  overlayOpacity: number
  overlayVisible: boolean
  overlayClickThrough: boolean
  autoHideControlWindow: boolean
  captureMicrophone: boolean
  systemAudioMode: 'auto' | 'manual'
  systemAudioStrategy: SystemAudioStrategy
  manualSystemSourceId: string
  historyOptIn: boolean
  hotkeys: HotkeySettings
  vad: VadConfig
  vadApplyMode: VadApplyMode
}

export interface SessionStartRequest {
  mode: 'meeting'
  sttModel?: string
  sttRuntimeMode?: SttRuntimeMode
  sttLanguageMode?: SttLanguageMode
  manualSttLanguage?: MeetingLanguage
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
  text: string
  language?: string
}

export interface ManualAssistRequest {
  text: string
  language?: string
  speaker?: Speaker
}

export interface ManualAssistResult {
  success: boolean
  transcriptId: string
  assistId?: string
}

export interface SessionStateEvent {
  active: boolean
  muted: boolean
  phase: SessionPhase
  workerReady: boolean
  reason?: string
  lastError?: string
  degradedCode?: 'cuda_fallback' | 'audio_source_fallback' | 'assist_quality_retry'
}

export interface WindowAPI {
  getSettings: () => Promise<AppSettings>
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>
  getProfileSnapshot: () => Promise<ProfileSnapshot>
  importProfileSource: (payload: ProfileImportRequest) => Promise<ProfileImportResult>
  importProfileFile: (payload: ProfileImportFileRequest) => Promise<ProfileImportFileResult>
  syncGithubProfile: (payload: GithubSyncRequest) => Promise<ProfileSyncStatus>
  syncWebCorpus: (payload?: WebCorpusSyncRequest) => Promise<WebCorpusSyncResult>
  ingestGlossary: (payload?: GlossaryIngestRequest) => Promise<GlossaryIngestResult>
  reindexProfileMemory: () => Promise<ProfileReindexResult>
  getInterviewContextPreview: (query?: string) => Promise<InterviewContextPreview>
  clearProfileSource: (payload: ProfileClearSourceRequest) => Promise<{ success: boolean }>
  startSession: (payload: SessionStartRequest) => Promise<{ success: boolean }>
  stopSession: () => Promise<{ success: boolean }>
  updateSessionVad: (
    payload: SessionUpdateVadRequest
  ) => Promise<{ success: boolean; applied: boolean; requiresRestart: boolean }>
  getAudioSources: () => Promise<AudioSourceItem[]>
  sendAudioChunk: (chunk: AudioChunkInput) => void
  injectTranscript: (payload: TranscriptInjection) => Promise<{ success: boolean }>
  generateManualAssist: (payload: ManualAssistRequest) => Promise<ManualAssistResult>
  listHistorySessions: () => Promise<HistoryListResult>
  exportSessionHistory: (payload: HistoryExportRequest) => Promise<HistoryExportResult>
  setOverlay: (settings: OverlaySettings) => Promise<{ success: boolean }>
  hideControlWindow: () => Promise<{ success: boolean }>
  showControlWindow: () => Promise<{ success: boolean }>
  toggleControlWindowVisibility: () => Promise<{ success: boolean; visible: boolean }>
  toggleAssistantMute: () => Promise<{ success: boolean; muted: boolean }>
  redetectAudioSource: () => Promise<{ success: boolean }>
  onTranscriptFinal: (cb: (event: TranscriptEvent) => void) => () => void
  onAssistUpdate: (cb: (event: AssistEvent) => void) => () => void
  onSessionState: (cb: (event: SessionStateEvent) => void) => () => void
  onOverlayState: (cb: (event: OverlayStateEvent) => void) => () => void
  onDiagnosticsUpdate: (cb: (event: WorkerDiagnosticsEvent) => void) => () => void
  onLatencyMetrics: (cb: (event: LatencyMetricsEvent) => void) => () => void
  onSttRuntimeStatus: (cb: (event: SttRuntimeStatusEvent) => void) => () => void
  onShortcutMuteToggle: (cb: (muted: boolean) => void) => () => void
  onProfileSyncStatus: (cb: (event: ProfileSyncStatus) => void) => () => void
}
