import { app, BrowserWindow, desktopCapturer, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import {
  AppSettings,
  AssistEvent,
  AudioChunkInput,
  HistoryExportRequest,
  HistoryExportResult,
  LatencyMetricsEvent,
  LatencyStatSummary,
  OverlaySettings,
  OverlayStateEvent,
  SessionHistoryRecord,
  SessionPhase,
  SessionStartRequest,
  SessionStateEvent,
  SessionUpdateVadRequest,
  TranscriptEvent,
  TranscriptInjection,
  WorkerDiagnosticsEvent
} from '../../shared/contracts'
import { AssistService } from '../services/assistService'
import { HistoryManager } from '../services/historyManager'
import { SettingsManager } from '../services/settingsManager'
import { SttBridge } from '../services/sttBridge'

interface WindowRefs {
  controlWindow: BrowserWindow
  overlayWindow: BrowserWindow
}

const HISTORY_LIMIT = 120
const CONTEXT_LIMIT = 12
const ASSIST_TIMEOUT_MS = 12000
const START_SESSION_TIMEOUT_MS = 20000
const LATENCY_HISTORY_LIMIT = 300

let refs: WindowRefs | null = null
let settingsManager: SettingsManager | null = null
let sttBridge: SttBridge | null = null
let assistService: AssistService | null = null
let historyManager: HistoryManager | null = null
let sessionActive = false
let suggestionsMuted = false
let workerReady = false
let sessionPhase: SessionPhase = 'idle'
let sessionReason: string | undefined
let sessionLastError: string | undefined
let transcriptHistory: TranscriptEvent[] = []
let activeSessionId: string | null = null
let activeSessionStartedAtMs = 0
let activeSessionSttModel = ''
let activeSessionAnswerModel = ''
let activeSessionTranscripts: TranscriptEvent[] = []
let activeSessionAssists: AssistEvent[] = []
let lastSessionSnapshot: SessionHistoryRecord | null = null
let overlayState: OverlayStateEvent = {
  visible: true,
  opacity: 0.78,
  clickThrough: true
}
let assistAbortController: AbortController | null = null
let assistTranscriptId: string | null = null
let audioChunkListener: ((event: Electron.IpcMainEvent, chunk: AudioChunkInput) => void) | null = null
let intentionalWorkerStop = false

let sttFirstChunkHistory: number[] = []
let assistFirstTokenHistory: number[] = []
let assistFinalHistory: number[] = []
let workerErrorCount = 0
let workerTranscriptCount = 0

function resolveWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'scripts', 'stt_worker.py')
  }

  return resolve(__dirname, '../../../scripts/stt_worker.py')
}

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
    muted: suggestionsMuted,
    phase: sessionPhase,
    workerReady,
    reason: sessionReason,
    lastError: sessionLastError
  }
  broadcast('session:state', payload)
}

function emitOverlayState(): void {
  broadcast('overlay:state', overlayState)
}

function clampOpacity(value: number): number {
  return Math.max(0.25, Math.min(1, value))
}

function applyOverlayState(): void {
  if (!refs) return

  const overlay = refs.overlayWindow
  overlay.setOpacity(overlayState.opacity)

  if (overlayState.visible) {
    overlay.showInactive()
  } else {
    overlay.hide()
  }

  overlay.setIgnoreMouseEvents(overlayState.clickThrough, {
    forward: overlayState.clickThrough
  })

  emitOverlayState()
}

function applyOverlaySettings(settings: OverlaySettings, options?: { persist?: boolean }): void {
  const next: OverlayStateEvent = {
    visible: settings.visible !== undefined ? settings.visible : overlayState.visible,
    opacity: settings.opacity !== undefined ? clampOpacity(settings.opacity) : overlayState.opacity,
    clickThrough: settings.clickThrough !== undefined ? settings.clickThrough : overlayState.clickThrough
  }

  overlayState = next

  if (options?.persist && settingsManager) {
    settingsManager.update({
      overlayOpacity: overlayState.opacity,
      overlayVisible: overlayState.visible,
      overlayClickThrough: overlayState.clickThrough
    })
  }

  applyOverlayState()
}

function normalizeContext(history: TranscriptEvent[]): string[] {
  return history.slice(-CONTEXT_LIMIT).map((item) => `[${item.speaker}] ${item.textEn}`)
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

function cancelActiveAssist(reason: string): void {
  if (assistAbortController) {
    assistAbortController.abort(new Error(reason))
    assistAbortController = null
    assistTranscriptId = null
  }
}

function resetActiveSessionBuffers(): void {
  activeSessionId = null
  activeSessionStartedAtMs = 0
  activeSessionSttModel = ''
  activeSessionAnswerModel = ''
  activeSessionTranscripts = []
  activeSessionAssists = []
}

function cloneSessionRecord(record: SessionHistoryRecord): SessionHistoryRecord {
  return {
    ...record,
    transcripts: record.transcripts.map((item) => ({ ...item })),
    assists: record.assists.map((item) => ({ ...item }))
  }
}

function buildActiveSessionSnapshot(endedAtMs: number): SessionHistoryRecord | null {
  if (!activeSessionId || activeSessionStartedAtMs <= 0) {
    return null
  }

  return {
    id: activeSessionId,
    startedAtMs: activeSessionStartedAtMs,
    endedAtMs,
    sttModel: activeSessionSttModel,
    answerModel: activeSessionAnswerModel,
    transcripts: activeSessionTranscripts.map((item) => ({ ...item })),
    assists: activeSessionAssists.map((item) => ({ ...item }))
  }
}

function finalizeActiveSession(): void {
  const snapshot = buildActiveSessionSnapshot(Date.now())
  if (!snapshot) return

  if (snapshot.transcripts.length === 0 && snapshot.assists.length === 0) {
    resetActiveSessionBuffers()
    return
  }

  lastSessionSnapshot = snapshot

  if (settingsManager?.get().historyOptIn && historyManager) {
    historyManager.persistSession(snapshot)
  }

  resetActiveSessionBuffers()
}

function trackAssistForSession(event: AssistEvent): void {
  if (!activeSessionId) return
  if (event.state === 'partial') return

  const idx = activeSessionAssists.findIndex((item) => item.transcriptId === event.transcriptId)
  if (idx === -1) {
    activeSessionAssists.push({ ...event })
    return
  }

  activeSessionAssists[idx] = {
    ...activeSessionAssists[idx],
    ...event
  }
}

function resolveSessionForExport(sessionId?: string): SessionHistoryRecord | null {
  if (sessionId) {
    if (activeSessionId === sessionId) {
      return buildActiveSessionSnapshot(Date.now())
    }

    if (lastSessionSnapshot?.id === sessionId) {
      return cloneSessionRecord(lastSessionSnapshot)
    }

    return historyManager?.getSessionById(sessionId) || null
  }

  const active = buildActiveSessionSnapshot(Date.now())
  if (active) return active
  if (lastSessionSnapshot) return cloneSessionRecord(lastSessionSnapshot)
  return null
}

function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return Number(sorted[idx].toFixed(2))
}

function buildSummary(values: number[]): LatencyStatSummary {
  const latest = values.length > 0 ? Number(values[values.length - 1].toFixed(2)) : null
  return {
    latest,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    count: values.length
  }
}

function emitLatencyMetrics(): void {
  const total = workerTranscriptCount + workerErrorCount
  const workerErrorRate = total > 0 ? Number((workerErrorCount / total).toFixed(4)) : 0

  const payload: LatencyMetricsEvent = {
    sttFirstChunkMs: buildSummary(sttFirstChunkHistory),
    assistFirstTokenMs: buildSummary(assistFirstTokenHistory),
    assistFinalMs: buildSummary(assistFinalHistory),
    workerErrorRate,
    updatedAtMs: Date.now()
  }

  broadcast('metrics:latency', payload)
}

function resetSessionMetrics(): void {
  sttFirstChunkHistory = []
  assistFirstTokenHistory = []
  assistFinalHistory = []
  workerErrorCount = 0
  workerTranscriptCount = 0
  emitLatencyMetrics()
}

async function handleRemoteTranscript(event: TranscriptEvent): Promise<void> {
  if (!assistService || !settingsManager || suggestionsMuted) return

  cancelActiveAssist('superseded_by_new_remote_transcript')

  const controller = new AbortController()
  assistAbortController = controller
  assistTranscriptId = event.id

  const settings = settingsManager.get()

  try {
    const finalAssist = await assistService.generate({
      model: settings.answerModel,
      baseUrl: settings.ollamaBaseUrl,
      transcriptId: event.id,
      remoteQuestion: event.textEn,
      contextLines: normalizeContext(transcriptHistory),
      signal: controller.signal,
      timeoutMs: ASSIST_TIMEOUT_MS,
      onPartial: (partial: AssistEvent) => {
        broadcast('assist:update', partial)
      }
    })

    if (assistTranscriptId === event.id) {
      if (typeof finalAssist.firstTokenMs === 'number') {
        assistFirstTokenHistory.push(finalAssist.firstTokenMs)
        if (assistFirstTokenHistory.length > LATENCY_HISTORY_LIMIT) {
          assistFirstTokenHistory = assistFirstTokenHistory.slice(-LATENCY_HISTORY_LIMIT)
        }
      }

      assistFinalHistory.push(finalAssist.latencyMs)
      if (assistFinalHistory.length > LATENCY_HISTORY_LIMIT) {
        assistFinalHistory = assistFinalHistory.slice(-LATENCY_HISTORY_LIMIT)
      }

      trackAssistForSession(finalAssist)
      emitLatencyMetrics()
      broadcast('assist:update', finalAssist)
    }
  } catch (error) {
    const message = asErrorMessage(error)

    if (controller.signal.aborted && message.includes('superseded_by_new_remote_transcript')) {
      return
    }

    const failed: AssistEvent = {
      id: randomUUID(),
      transcriptId: event.id,
      state: 'error',
      error: message,
      latencyMs: 0
    }

    trackAssistForSession(failed)
    broadcast('assist:update', failed)
  } finally {
    if (assistAbortController === controller) {
      assistAbortController = null
      assistTranscriptId = null
    }
  }
}

export function toggleSuggestionsMuteFromShortcut(): void {
  suggestionsMuted = !suggestionsMuted
  sessionReason = 'mute_toggled'
  emitSessionState()
  broadcast('shortcut:mute-toggle', suggestionsMuted)
}

export function toggleOverlayFromShortcut(): void {
  applyOverlaySettings({ visible: !overlayState.visible })
}

export function panicHideOverlayFromShortcut(): void {
  applyOverlaySettings({ visible: false })
}

function setupBridgeListeners(): void {
  if (!sttBridge) return

  sttBridge.on('transcript', (event: TranscriptEvent) => {
    transcriptHistory.push(event)
    transcriptHistory = transcriptHistory.slice(-HISTORY_LIMIT)
    if (activeSessionId) {
      activeSessionTranscripts.push({ ...event })
    }

    workerTranscriptCount += 1
    const sttFirstChunkMs = Math.max(0, event.emittedMs - event.tEndMs)
    sttFirstChunkHistory.push(sttFirstChunkMs)
    if (sttFirstChunkHistory.length > LATENCY_HISTORY_LIMIT) {
      sttFirstChunkHistory = sttFirstChunkHistory.slice(-LATENCY_HISTORY_LIMIT)
    }

    emitLatencyMetrics()
    broadcast('transcript:final', event)

    if (event.speaker === 'remote') {
      void handleRemoteTranscript(event)
    }
  })

  sttBridge.on('error', (error: Error) => {
    workerErrorCount += 1
    emitLatencyMetrics()

    workerReady = false
    sessionPhase = 'degraded'
    sessionReason = 'worker_error'
    sessionLastError = `STT worker error: ${error.message}`
    emitSessionState()

    const failed: AssistEvent = {
      id: randomUUID(),
      transcriptId: randomUUID(),
      state: 'error',
      error: sessionLastError,
      latencyMs: 0
    }
    trackAssistForSession(failed)
    broadcast('assist:update', failed)
  })

  sttBridge.on('stopped', () => {
    if (intentionalWorkerStop) {
      intentionalWorkerStop = false
      return
    }

    if (sessionActive) {
      finalizeActiveSession()
      sessionActive = false
      workerReady = false
      sessionPhase = 'error'
      sessionReason = 'worker_stopped_unexpectedly'
      sessionLastError = 'STT worker stopped unexpectedly.'
      emitSessionState()
    }
  })

  sttBridge.on('diagnostics', (diagnostics: WorkerDiagnosticsEvent) => {
    broadcast('diagnostics:update', diagnostics)
  })
}

export function initializeIpcHandlers(windowRefs: WindowRefs): void {
  refs = windowRefs
  settingsManager = new SettingsManager()
  assistService = new AssistService()
  historyManager = new HistoryManager()
  sttBridge = new SttBridge({
    workerPath: resolveWorkerPath()
  })

  setupBridgeListeners()

  ipcMain.handle('settings:get', () => {
    return settingsManager?.get() || ({} as AppSettings)
  })

  ipcMain.handle('settings:update', (_event, updates: Partial<AppSettings>) => {
    const saved = settingsManager?.update(updates)
    if (!saved) throw new Error('Settings manager unavailable.')

    applyOverlaySettings(
      {
        opacity: saved.overlayOpacity,
        visible: saved.overlayVisible,
        clickThrough: saved.overlayClickThrough
      },
      { persist: false }
    )

    return saved
  })

  ipcMain.handle('audio:sources', async () => {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window']
    })

    return sources.map((source) => ({ id: source.id, name: source.name }))
  })

  ipcMain.handle('history:list', () => {
    return (
      historyManager?.listSessions() || {
        encryptionAvailable: false,
        sessions: []
      }
    )
  })

  ipcMain.handle('history:export', (_event, payload: HistoryExportRequest) => {
    if (!historyManager) {
      throw new Error('History manager unavailable.')
    }

    const format = payload.format === 'markdown' ? 'markdown' : 'json'
    const record = resolveSessionForExport(payload.sessionId)
    if (!record) {
      throw new Error('No session data available to export.')
    }

    const filePath = historyManager.exportSession(record, format)
    const result: HistoryExportResult = {
      success: true,
      format,
      path: filePath,
      sessionId: record.id
    }
    return result
  })

  ipcMain.handle('session:start', async (_event, payload: SessionStartRequest) => {
    if (sessionActive || sessionPhase === 'starting') {
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
    resetSessionMetrics()
    resetActiveSessionBuffers()
    activeSessionId = randomUUID()
    activeSessionStartedAtMs = Date.now()
    activeSessionSttModel = payload.sttModel || settings.sttModel
    activeSessionAnswerModel = settings.answerModel

    sessionActive = true
    workerReady = false
    sessionPhase = 'starting'
    sessionReason = 'start_requested'
    sessionLastError = undefined
    intentionalWorkerStop = false
    emitSessionState()

    try {
      await sttBridge.start(payload.sttModel || settings.sttModel, {
        vad: payload.vad || settings.vad,
        timeoutMs: START_SESSION_TIMEOUT_MS
      })
      workerReady = true
      sessionPhase = 'running'
      sessionReason = 'worker_ready'
      emitSessionState()
      return { success: true }
    } catch (error) {
      resetActiveSessionBuffers()
      sessionActive = false
      workerReady = false
      sessionPhase = 'error'
      sessionReason = 'start_failed'
      sessionLastError = asErrorMessage(error)
      emitSessionState()
      throw error
    }
  })

  ipcMain.handle('session:stop', () => {
    if (!sessionActive && sessionPhase === 'idle') {
      return { success: true }
    }

    cancelActiveAssist('session_stopped')

    sessionPhase = 'stopping'
    sessionReason = 'stop_requested'
    emitSessionState()

    if (sttBridge) {
      intentionalWorkerStop = true
      sttBridge.stop()
    }

    finalizeActiveSession()
    sessionActive = false
    workerReady = false
    sessionPhase = 'idle'
    sessionReason = 'stopped'
    emitSessionState()
    return { success: true }
  })

  ipcMain.handle('session:update-vad', (_event, payload: SessionUpdateVadRequest) => {
    if (!settingsManager || !sttBridge) {
      throw new Error('Session dependencies unavailable.')
    }

    const current = settingsManager.get()
    const nextApplyMode = payload.applyMode || current.vadApplyMode
    const saved = settingsManager.update({
      vad: payload.vad,
      vadApplyMode: nextApplyMode
    })

    if (nextApplyMode === 'restart') {
      return {
        success: true,
        applied: false,
        requiresRestart: sessionActive
      }
    }

    if (!sessionActive || !workerReady) {
      return {
        success: true,
        applied: false,
        requiresRestart: false
      }
    }

    const applied = sttBridge.updateVad(saved.vad)
    return {
      success: true,
      applied,
      requiresRestart: false
    }
  })

  audioChunkListener = (_event, chunk: AudioChunkInput) => {
    if (!sessionActive || !workerReady || !sttBridge) return
    sttBridge.sendAudioChunk(chunk)
  }
  ipcMain.on('audio:chunk', audioChunkListener)

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
    toggleSuggestionsMuteFromShortcut()
    return { success: true, muted: suggestionsMuted }
  })

  const currentSettings = settingsManager.get()
  overlayState = {
    visible: currentSettings.overlayVisible,
    opacity: clampOpacity(currentSettings.overlayOpacity),
    clickThrough: currentSettings.overlayClickThrough
  }
  applyOverlayState()

  sessionPhase = 'idle'
  sessionReason = 'initialized'
  sessionLastError = undefined
  sessionActive = false
  workerReady = false
  emitSessionState()
  emitLatencyMetrics()
}

export function cleanupIpcHandlers(): void {
  cancelActiveAssist('ipc_cleanup')

  if (sttBridge) {
    sttBridge.stop()
    sttBridge.removeAllListeners()
  }

  finalizeActiveSession()

  if (audioChunkListener) {
    ipcMain.removeListener('audio:chunk', audioChunkListener)
    audioChunkListener = null
  }

  sttBridge = null
  settingsManager = null
  assistService = null
  historyManager = null
  refs = null
  sessionActive = false
  suggestionsMuted = false
  workerReady = false
  sessionPhase = 'idle'
  sessionReason = undefined
  sessionLastError = undefined
  transcriptHistory = []
  resetActiveSessionBuffers()
  lastSessionSnapshot = null
  overlayState = {
    visible: true,
    opacity: 0.78,
    clickThrough: true
  }
  intentionalWorkerStop = false

  sttFirstChunkHistory = []
  assistFirstTokenHistory = []
  assistFinalHistory = []
  workerErrorCount = 0
  workerTranscriptCount = 0

  ipcMain.removeHandler('settings:get')
  ipcMain.removeHandler('settings:update')
  ipcMain.removeHandler('audio:sources')
  ipcMain.removeHandler('history:list')
  ipcMain.removeHandler('history:export')
  ipcMain.removeHandler('session:start')
  ipcMain.removeHandler('session:stop')
  ipcMain.removeHandler('session:update-vad')
  ipcMain.removeHandler('transcript:inject')
  ipcMain.removeHandler('overlay:set')
  ipcMain.removeHandler('assistant:toggle-mute')
}
