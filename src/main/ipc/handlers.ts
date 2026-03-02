import { BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import {
  AppSettings,
  AssistEvent,
  AudioChunkInput,
  OverlaySettings,
  SessionStartRequest,
  SessionStateEvent,
  TranscriptEvent,
  TranscriptInjection
} from '../../shared/contracts'
import { AssistService } from '../services/assistService'
import { SettingsManager } from '../services/settingsManager'
import { SttBridge } from '../services/sttBridge'

interface WindowRefs {
  controlWindow: BrowserWindow
  overlayWindow: BrowserWindow
}

const HISTORY_LIMIT = 120
const CONTEXT_LIMIT = 12

let refs: WindowRefs | null = null
let settingsManager: SettingsManager | null = null
let sttBridge: SttBridge | null = null
let assistService: AssistService | null = null
let sessionActive = false
let suggestionsMuted = false
let transcriptHistory: TranscriptEvent[] = []

function broadcast(channel: string, payload: unknown): void {
  if (!refs) return

  if (!refs.controlWindow.isDestroyed()) {
    refs.controlWindow.webContents.send(channel, payload)
  }

  if (!refs.overlayWindow.isDestroyed()) {
    refs.overlayWindow.webContents.send(channel, payload)
  }
}

function emitSessionState(): void {
  const payload: SessionStateEvent = {
    active: sessionActive,
    muted: suggestionsMuted
  }
  broadcast('session:state', payload)
}

function normalizeContext(history: TranscriptEvent[]): string[] {
  return history.slice(-CONTEXT_LIMIT).map((item) => `[${item.speaker}] ${item.textEn}`)
}

async function handleRemoteTranscript(event: TranscriptEvent): Promise<void> {
  if (!assistService || !settingsManager || suggestionsMuted) return

  const settings = settingsManager.get()

  try {
    const finalAssist = await assistService.generate({
      model: settings.answerModel,
      baseUrl: settings.ollamaBaseUrl,
      transcriptId: event.id,
      remoteQuestion: event.textEn,
      contextLines: normalizeContext(transcriptHistory),
      onPartial: (partial: AssistEvent) => {
        broadcast('assist:update', partial)
      }
    })

    broadcast('assist:update', finalAssist)
  } catch (error) {
    const failed: AssistEvent = {
      id: randomUUID(),
      transcriptId: event.id,
      state: 'error',
      error: error instanceof Error ? error.message : 'Assist generation failed',
      latencyMs: 0
    }

    broadcast('assist:update', failed)
  }
}

function setupBridgeListeners(): void {
  if (!sttBridge) return

  sttBridge.on('transcript', async (event: TranscriptEvent) => {
    transcriptHistory.push(event)
    transcriptHistory = transcriptHistory.slice(-HISTORY_LIMIT)

    broadcast('transcript:final', event)

    if (event.speaker === 'remote') {
      await handleRemoteTranscript(event)
    }
  })

  sttBridge.on('error', (error: Error) => {
    const failed: AssistEvent = {
      id: randomUUID(),
      transcriptId: randomUUID(),
      state: 'error',
      error: `STT worker error: ${error.message}`,
      latencyMs: 0
    }
    broadcast('assist:update', failed)
  })
}

export function initializeIpcHandlers(windowRefs: WindowRefs): void {
  refs = windowRefs
  settingsManager = new SettingsManager()
  assistService = new AssistService()
  sttBridge = new SttBridge({
    workerPath: resolve(process.cwd(), 'scripts', 'stt_worker.py')
  })

  setupBridgeListeners()

  ipcMain.handle('settings:get', () => {
    return settingsManager?.get() || ({} as AppSettings)
  })

  ipcMain.handle('settings:update', (_event, updates: Partial<AppSettings>) => {
    const saved = settingsManager?.update(updates)
    if (!saved) throw new Error('Settings manager unavailable.')

    applyOverlaySettings({
      opacity: saved.overlayOpacity,
      visible: saved.overlayVisible,
      clickThrough: saved.overlayClickThrough
    })

    return saved
  })

  ipcMain.handle('audio:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window']
    })

    return sources.map((source) => ({ id: source.id, name: source.name }))
  })

  ipcMain.handle('session:start', (_event, payload: SessionStartRequest) => {
    if (sessionActive) {
      return { success: true }
    }

    if (payload.mode !== 'meeting') {
      throw new Error('Unsupported mode requested.')
    }

    const settings = settingsManager?.get()
    if (!settings || !sttBridge) {
      throw new Error('Session dependencies unavailable.')
    }

    transcriptHistory = []
    sessionActive = true

    try {
      sttBridge.start(payload.sttModel || settings.sttModel)
      emitSessionState()
      return { success: true }
    } catch (error) {
      sessionActive = false
      emitSessionState()
      throw error
    }
  })

  ipcMain.handle('session:stop', () => {
    if (sttBridge) {
      sttBridge.stop()
    }
    sessionActive = false
    emitSessionState()
    return { success: true }
  })

  ipcMain.on('audio:chunk', (_event, chunk: AudioChunkInput) => {
    if (!sessionActive || !sttBridge) return
    sttBridge.sendAudioChunk(chunk)
  })

  ipcMain.handle('transcript:inject', (_event, payload: TranscriptInjection) => {
    if (!sttBridge) {
      throw new Error('STT bridge unavailable.')
    }

    sttBridge.injectTranscript(payload.speaker, payload.textEn)
    return { success: true }
  })

  ipcMain.handle('overlay:set', (_event, settings: OverlaySettings) => {
    applyOverlaySettings(settings)
    return { success: true }
  })

  ipcMain.handle('assistant:toggle-mute', () => {
    suggestionsMuted = !suggestionsMuted
    emitSessionState()
    broadcast('shortcut:mute-toggle', suggestionsMuted)
    return { success: true, muted: suggestionsMuted }
  })

  const currentSettings = settingsManager.get()
  applyOverlaySettings({
    visible: currentSettings.overlayVisible,
    opacity: currentSettings.overlayOpacity,
    clickThrough: currentSettings.overlayClickThrough
  })
  emitSessionState()
}

function applyOverlaySettings(settings: OverlaySettings): void {
  if (!refs || !settingsManager) return

  const current = settingsManager.get()
  const persisted = settingsManager.update({
    overlayOpacity: settings.opacity !== undefined ? Math.max(0.25, Math.min(1, settings.opacity)) : current.overlayOpacity,
    overlayVisible: settings.visible !== undefined ? settings.visible : current.overlayVisible,
    overlayClickThrough: settings.clickThrough !== undefined ? settings.clickThrough : current.overlayClickThrough
  })

  const overlay = refs.overlayWindow
  overlay.setOpacity(persisted.overlayOpacity)

  if (persisted.overlayVisible) {
    overlay.showInactive()
  } else {
    overlay.hide()
  }

  overlay.setIgnoreMouseEvents(persisted.overlayClickThrough, {
    forward: persisted.overlayClickThrough
  })
}

export function cleanupIpcHandlers(): void {
  if (sttBridge) {
    sttBridge.stop()
    sttBridge.removeAllListeners()
  }

  sttBridge = null
  settingsManager = null
  assistService = null
  refs = null
  sessionActive = false
  suggestionsMuted = false
  transcriptHistory = []

  ipcMain.removeHandler('settings:get')
  ipcMain.removeHandler('settings:update')
  ipcMain.removeHandler('audio:sources')
  ipcMain.removeHandler('session:start')
  ipcMain.removeHandler('session:stop')
  ipcMain.removeHandler('transcript:inject')
  ipcMain.removeHandler('overlay:set')
  ipcMain.removeHandler('assistant:toggle-mute')
}
