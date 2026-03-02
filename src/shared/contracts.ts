export type Speaker = 'remote' | 'self'

export interface TranscriptEvent {
  id: string
  speaker: Speaker
  textEn: string
  isFinal: boolean
  tStartMs: number
  tEndMs: number
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
  state: 'partial' | 'final' | 'error'
  rawText?: string
  error?: string
}

export interface HotkeySettings {
  toggleOverlay: string
  muteSuggestions: string
  panicHide: string
}

export interface AppSettings {
  sttModel: string
  answerModel: string
  ollamaBaseUrl: string
  overlayOpacity: number
  overlayVisible: boolean
  overlayClickThrough: boolean
  historyOptIn: boolean
  hotkeys: HotkeySettings
}

export interface SessionStartRequest {
  mode: 'meeting'
  sttModel?: string
}

export interface OverlaySettings {
  visible?: boolean
  opacity?: number
  clickThrough?: boolean
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
}

export interface WindowAPI {
  getSettings: () => Promise<AppSettings>
  updateSettings: (updates: Partial<AppSettings>) => Promise<AppSettings>
  startSession: (payload: SessionStartRequest) => Promise<{ success: boolean }>
  stopSession: () => Promise<{ success: boolean }>
  getAudioSources: () => Promise<AudioSourceItem[]>
  sendAudioChunk: (chunk: AudioChunkInput) => void
  injectTranscript: (payload: TranscriptInjection) => Promise<{ success: boolean }>
  setOverlay: (settings: OverlaySettings) => Promise<{ success: boolean }>
  onTranscriptFinal: (cb: (event: TranscriptEvent) => void) => () => void
  onAssistUpdate: (cb: (event: AssistEvent) => void) => () => void
  onSessionState: (cb: (event: SessionStateEvent) => void) => () => void
  onShortcutMuteToggle: (cb: (muted: boolean) => void) => () => void
}
