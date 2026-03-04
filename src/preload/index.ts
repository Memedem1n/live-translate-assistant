import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  AssistEvent,
  AudioChunkInput,
  AudioSourceItem,
  GlossaryIngestRequest,
  GlossaryIngestResult,
  GithubSyncRequest,
  HistoryExportRequest,
  HistoryExportResult,
  HistoryListResult,
  ManualAssistRequest,
  ManualAssistResult,
  InterviewContextPreview,
  ProfileClearSourceRequest,
  ProfileImportFileRequest,
  ProfileImportFileResult,
  ProfileImportRequest,
  ProfileImportResult,
  ProfileReindexResult,
  ProfileSnapshot,
  ProfileSyncStatus,
  WebCorpusSyncRequest,
  WebCorpusSyncResult,
  OverlaySettings,
  OverlayStateEvent,
  LatencyMetricsEvent,
  SttRuntimeStatusEvent,
  SessionStartRequest,
  SessionStateEvent,
  SessionUpdateVadRequest,
  TranscriptEvent,
  TranscriptInjection,
  WindowAPI,
  WorkerDiagnosticsEvent
} from '../shared/contracts'

const createListener = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const listener = (_event: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: WindowAPI = {
  getSettings: () => ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
  updateSettings: (updates: Partial<AppSettings>) =>
    ipcRenderer.invoke('settings:update', updates) as Promise<AppSettings>,
  getProfileSnapshot: () => ipcRenderer.invoke('profile:get') as Promise<ProfileSnapshot>,
  importProfileSource: (payload: ProfileImportRequest) =>
    ipcRenderer.invoke('profile:import-source', payload) as Promise<ProfileImportResult>,
  importProfileFile: (payload: ProfileImportFileRequest) =>
    ipcRenderer.invoke('profile:import-file', payload) as Promise<ProfileImportFileResult>,
  syncGithubProfile: (payload: GithubSyncRequest) =>
    ipcRenderer.invoke('profile:sync-github', payload) as Promise<ProfileSyncStatus>,
  syncWebCorpus: (payload?: WebCorpusSyncRequest) =>
    ipcRenderer.invoke('profile:sync-web-corpus', payload || {}) as Promise<WebCorpusSyncResult>,
  ingestGlossary: (payload?: GlossaryIngestRequest) =>
    ipcRenderer.invoke('profile:ingest-glossary', payload || {}) as Promise<GlossaryIngestResult>,
  reindexProfileMemory: () => ipcRenderer.invoke('profile:reindex') as Promise<ProfileReindexResult>,
  getInterviewContextPreview: (query?: string) =>
    ipcRenderer.invoke('profile:context-preview', query) as Promise<InterviewContextPreview>,
  clearProfileSource: (payload: ProfileClearSourceRequest) =>
    ipcRenderer.invoke('profile:clear-source', payload) as Promise<{ success: boolean }>,
  startSession: (payload: SessionStartRequest) =>
    ipcRenderer.invoke('session:start', payload) as Promise<{ success: boolean }>,
  stopSession: () => ipcRenderer.invoke('session:stop') as Promise<{ success: boolean }>,
  updateSessionVad: (payload: SessionUpdateVadRequest) =>
    ipcRenderer.invoke('session:update-vad', payload) as Promise<{
      success: boolean
      applied: boolean
      requiresRestart: boolean
    }>,
  getAudioSources: () => ipcRenderer.invoke('audio:sources') as Promise<AudioSourceItem[]>,
  sendAudioChunk: (chunk: AudioChunkInput) => ipcRenderer.send('audio:chunk', chunk),
  injectTranscript: (payload: TranscriptInjection) =>
    ipcRenderer.invoke('transcript:inject', payload) as Promise<{ success: boolean }>,
  generateManualAssist: (payload: ManualAssistRequest) =>
    ipcRenderer.invoke('assist:manual-generate', payload) as Promise<ManualAssistResult>,
  listHistorySessions: () => ipcRenderer.invoke('history:list') as Promise<HistoryListResult>,
  exportSessionHistory: (payload: HistoryExportRequest) =>
    ipcRenderer.invoke('history:export', payload) as Promise<HistoryExportResult>,
  setOverlay: (settings: OverlaySettings) =>
    ipcRenderer.invoke('overlay:set', settings) as Promise<{ success: boolean }>,
  hideControlWindow: () => ipcRenderer.invoke('control:hide') as Promise<{ success: boolean }>,
  showControlWindow: () => ipcRenderer.invoke('control:show') as Promise<{ success: boolean }>,
  toggleControlWindowVisibility: () =>
    ipcRenderer.invoke('control:toggle') as Promise<{ success: boolean; visible: boolean }>,
  toggleAssistantMute: () =>
    ipcRenderer.invoke('assistant:toggle-mute') as Promise<{ success: boolean; muted: boolean }>,
  redetectAudioSource: () =>
    ipcRenderer.invoke('session:redetect-audio-source') as Promise<{ success: boolean }>,
  onTranscriptFinal: (cb) => createListener<TranscriptEvent>('transcript:final', cb),
  onAssistUpdate: (cb) => createListener<AssistEvent>('assist:update', cb),
  onSessionState: (cb) => createListener<SessionStateEvent>('session:state', cb),
  onOverlayState: (cb) => createListener<OverlayStateEvent>('overlay:state', cb),
  onDiagnosticsUpdate: (cb) => createListener<WorkerDiagnosticsEvent>('diagnostics:update', cb),
  onLatencyMetrics: (cb) => createListener<LatencyMetricsEvent>('metrics:latency', cb),
  onSttRuntimeStatus: (cb) => createListener<SttRuntimeStatusEvent>('stt:runtime-status', cb),
  onShortcutMuteToggle: (cb) =>
    createListener<boolean>('shortcut:mute-toggle', (muted) => cb(muted)),
  onProfileSyncStatus: (cb) => createListener<ProfileSyncStatus>('profile:sync-status', cb)
}

contextBridge.exposeInMainWorld('api', api)
