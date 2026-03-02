import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  AssistEvent,
  AudioChunkInput,
  AudioSourceItem,
  HistoryExportRequest,
  HistoryExportResult,
  HistoryListResult,
  OverlaySettings,
  OverlayStateEvent,
  LatencyMetricsEvent,
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
  listHistorySessions: () => ipcRenderer.invoke('history:list') as Promise<HistoryListResult>,
  exportSessionHistory: (payload: HistoryExportRequest) =>
    ipcRenderer.invoke('history:export', payload) as Promise<HistoryExportResult>,
  setOverlay: (settings: OverlaySettings) =>
    ipcRenderer.invoke('overlay:set', settings) as Promise<{ success: boolean }>,
  onTranscriptFinal: (cb) => createListener<TranscriptEvent>('transcript:final', cb),
  onAssistUpdate: (cb) => createListener<AssistEvent>('assist:update', cb),
  onSessionState: (cb) => createListener<SessionStateEvent>('session:state', cb),
  onOverlayState: (cb) => createListener<OverlayStateEvent>('overlay:state', cb),
  onDiagnosticsUpdate: (cb) => createListener<WorkerDiagnosticsEvent>('diagnostics:update', cb),
  onLatencyMetrics: (cb) => createListener<LatencyMetricsEvent>('metrics:latency', cb),
  onShortcutMuteToggle: (cb) =>
    createListener<boolean>('shortcut:mute-toggle', (muted) => cb(muted))
}

contextBridge.exposeInMainWorld('api', api)
