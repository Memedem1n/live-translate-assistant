import { contextBridge, ipcRenderer } from 'electron'
import {
  AppSettings,
  AssistEvent,
  AudioChunkInput,
  AudioSourceItem,
  OverlaySettings,
  SessionStartRequest,
  SessionStateEvent,
  TranscriptEvent,
  TranscriptInjection,
  WindowAPI
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
  getAudioSources: () => ipcRenderer.invoke('audio:sources') as Promise<AudioSourceItem[]>,
  sendAudioChunk: (chunk: AudioChunkInput) => ipcRenderer.send('audio:chunk', chunk),
  injectTranscript: (payload: TranscriptInjection) =>
    ipcRenderer.invoke('transcript:inject', payload) as Promise<{ success: boolean }>,
  setOverlay: (settings: OverlaySettings) =>
    ipcRenderer.invoke('overlay:set', settings) as Promise<{ success: boolean }>,
  onTranscriptFinal: (cb) => createListener<TranscriptEvent>('transcript:final', cb),
  onAssistUpdate: (cb) => createListener<AssistEvent>('assist:update', cb),
  onSessionState: (cb) => createListener<SessionStateEvent>('session:state', cb),
  onShortcutMuteToggle: (cb) => {
    const teardownRequest = createListener<undefined>('shortcut:request-mute-toggle', async () => {
      const result = await ipcRenderer.invoke('assistant:toggle-mute')
      cb(Boolean(result?.muted))
    })

    const teardownDirect = createListener<boolean>('shortcut:mute-toggle', (muted) => cb(muted))

    return () => {
      teardownRequest()
      teardownDirect()
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
