import { app, BrowserWindow, desktopCapturer, dialog, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, delimiter, join, resolve } from 'node:path'
import {
  AppSettings,
  AssistEvent,
  GlossaryIngestRequest,
  GlossaryIngestResult,
  GithubSyncRequest,
  InterviewContextPreview,
  AudioChunkInput,
  HistoryExportRequest,
  HistoryExportResult,
  LatencyMetricsEvent,
  ManualAssistRequest,
  ManualAssistResult,
  OverlaySettings,
  OverlayStateEvent,
  ProfileClearSourceRequest,
  ProfileImportFileRequest,
  ProfileImportFileResult,
  ProfileImportOcrMode,
  ProfileImportRequest,
  ProfileImportResult,
  ProfileReindexResult,
  ProfileSnapshot,
  ProfileSyncStatus,
  WebCorpusSyncRequest,
  WebCorpusSyncResult,
  SessionHistoryRecord,
  SessionPhase,
  SessionStartRequest,
  SessionStateEvent,
  SessionUpdateVadRequest,
  SttRuntimeMode,
  SttRuntimeStatusEvent,
  TranscriptEvent,
  TranscriptInjection,
  WorkerDiagnosticsEvent
} from '../../shared/contracts'
import { AssistService } from '../services/assistService'
import { ConnectorService } from '../services/connectorService'
import { HistoryManager } from '../services/historyManager'
import { InterviewAssistOrchestrator } from '../services/interviewAssistOrchestrator'
import { ProfileFileImportService } from '../services/profileFileImportService'
import { ProfileKnowledgeSyncService } from '../services/profileKnowledgeSyncService'
import { ProfileMemoryService } from '../services/profileMemoryService'
import { SettingsManager } from '../services/settingsManager'
import { SttBridge } from '../services/sttBridge'
import { buildLatencySummary } from '../utils/latencyStats'
import {
  appendRemoteSegment,
  buildContextLines,
  computeSegmentFlushDelay,
  createRemoteSegment,
  RemoteAssistSegment,
  shouldDropSelfTranscriptAsEcho as shouldDropSelfEcho,
  shouldSplitRemoteSegment
} from '../utils/transcriptPipeline'

interface WindowRefs {
  controlWindow: BrowserWindow
  overlayWindow: BrowserWindow
}

const HISTORY_LIMIT = 120
const CONTEXT_REMOTE_TURNS = 8
const CONTEXT_SELF_TURNS = 2
const CONTEXT_ASSIST_TURNS = 2
const CONTEXT_MAX_CHARS = 180
const ASSIST_TIMEOUT_MS = 12000
const MANUAL_ASSIST_TIMEOUT_MS = 45000
const MANUAL_ASSIST_PREWARM_TIMEOUT_MS = 15000
const START_SESSION_TIMEOUT_MS = 240000
const LATENCY_HISTORY_LIMIT = 300
const STT_CUDA_RETRY_COUNT = 1
const ASSIST_PREWARM_TIMEOUT_MS = 5000
const REMOTE_SEGMENT_PUNCT_FLUSH_MS = 320
const REMOTE_SEGMENT_PAUSE_FLUSH_MS = 1200
const REMOTE_SEGMENT_MAX_HOLD_MS = 4200
const REMOTE_SEGMENT_MERGE_GAP_MS = 2200
const ASSIST_QUEUE_MAX = 2
const SELF_ECHO_HOLD_MS = 650
const SELF_ECHO_WINDOW_MS = 1400
const SELF_ECHO_SIMILARITY = 0.9

let refs: WindowRefs | null = null
let settingsManager: SettingsManager | null = null
let sttBridge: SttBridge | null = null
let assistService: AssistService | null = null
let profileMemoryService: ProfileMemoryService | null = null
let profileFileImportService: ProfileFileImportService | null = null
let profileKnowledgeSyncService: ProfileKnowledgeSyncService | null = null
let connectorService: ConnectorService | null = null
let interviewAssistOrchestrator: InterviewAssistOrchestrator | null = null
let historyManager: HistoryManager | null = null
let sessionActive = false
let suggestionsMuted = false
let workerReady = false
let sessionPhase: SessionPhase = 'idle'
let sessionReason: string | undefined
let sessionLastError: string | undefined
let sessionDegradedCode: SessionStateEvent['degradedCode'] | undefined
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
let pendingRemoteSegment: RemoteAssistSegment | null = null
let pendingRemoteAssistTimer: NodeJS.Timeout | null = null
let assistQueue: RemoteAssistSegment[] = []
let assistQueueRunning = false
let audioChunkListener: ((event: Electron.IpcMainEvent, chunk: AudioChunkInput) => void) | null =
  null
let intentionalWorkerStop = false

let sttFirstChunkHistory: number[] = []
let assistFirstTokenHistory: number[] = []
let assistFinalHistory: number[] = []
let workerErrorCount = 0
let workerTranscriptCount = 0
let sttRuntimeStatus: SttRuntimeStatusEvent | null = null
let lastRemoteTranscript: TranscriptEvent | null = null
let lastWorkerDiagnostics: WorkerDiagnosticsEvent | null = null
let pendingSelfTranscript: TranscriptEvent | null = null
let pendingSelfTranscriptTimer: NodeJS.Timeout | null = null

function resolveScriptPath(scriptName: string): string {
  if (app.isPackaged) {
    const packagedScript = join(process.resourcesPath, 'scripts', scriptName)
    if (existsSync(packagedScript)) {
      return packagedScript
    }
  }

  const root = resolveProjectRoot()
  const fromRoot = join(root, 'scripts', scriptName)
  if (existsSync(fromRoot)) {
    return fromRoot
  }

  return resolve(__dirname, `../../../scripts/${scriptName}`)
}

function resolveConfigPath(configName: string): string {
  if (app.isPackaged) {
    const packagedConfig = join(process.resourcesPath, 'configs', configName)
    if (existsSync(packagedConfig)) {
      return packagedConfig
    }
  }

  const root = resolveProjectRoot()
  const fromRoot = join(root, 'configs', configName)
  if (existsSync(fromRoot)) {
    return fromRoot
  }

  return resolve(__dirname, `../../../configs/${configName}`)
}

function resolveWorkerPath(): string {
  return resolveScriptPath('stt_worker.py')
}

function resolvePythonBinary(): string {
  const fromEnv = process.env.LIVETRANSLATE_PYTHON_BIN
  if (fromEnv) {
    return fromEnv
  }

  const root = resolveProjectRoot()
  const venvPythonFromRoot = join(root, '.venv311', 'Scripts', 'python.exe')
  if (existsSync(venvPythonFromRoot)) {
    return venvPythonFromRoot
  }

  if (!app.isPackaged) {
    const venvPythonFromDir = resolve(__dirname, '../../../.venv311/Scripts/python.exe')
    if (existsSync(venvPythonFromDir)) {
      return venvPythonFromDir
    }
  }

  return 'python'
}

function resolveProjectRoot(): string {
  const envRoot = process.env.LIVETRANSLATE_PROJECT_ROOT
  if (envRoot) {
    const resolvedEnvRoot = resolve(envRoot)
    if (existsSync(join(resolvedEnvRoot, 'package.json'))) {
      return resolvedEnvRoot
    }
  }

  const cwd = process.cwd()
  if (existsSync(join(cwd, 'package.json'))) {
    return cwd
  }

  const appPath = app.getAppPath()
  const candidates = [
    appPath,
    resolve(appPath, '..'),
    resolve(__dirname, '../../../'),
    resolve(__dirname, '../../')
  ]

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'package.json'))) {
      return candidate
    }
  }

  return cwd
}

function mergePathEntries(entries: string[], currentPath: string | undefined): string {
  const seen = new Set<string>()
  const ordered: string[] = []

  const pushEntry = (entry: string): void => {
    const normalized = entry.trim()
    if (!normalized) return
    const key = normalized.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    ordered.push(normalized)
  }

  for (const entry of entries) {
    if (!existsSync(entry)) continue
    pushEntry(entry)
  }

  for (const entry of (currentPath || '').split(delimiter)) {
    pushEntry(entry)
  }

  return ordered.join(delimiter)
}

function resolvePythonEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  const root = resolveProjectRoot()
  const runtimePathEntries: string[] = [
    'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v13.1\\bin',
    'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.6\\bin',
    'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.4\\bin'
  ]

  if (!app.isPackaged) {
    const venvNvidiaRoot = join(root, '.venv311', 'Lib', 'site-packages', 'nvidia')
    if (existsSync(venvNvidiaRoot)) {
      for (const child of readdirSync(venvNvidiaRoot, { withFileTypes: true })) {
        if (!child.isDirectory()) continue
        runtimePathEntries.push(join(venvNvidiaRoot, child.name, 'bin'))
      }
    }
  }

  env.PATH = mergePathEntries(runtimePathEntries, env.PATH)
  return env
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
    lastError: sessionLastError,
    degradedCode: sessionDegradedCode
  }
  broadcast('session:state', payload)
}

function emitOverlayState(): void {
  broadcast('overlay:state', overlayState)
}

function emitProfileSyncStatus(status: ProfileSyncStatus): void {
  broadcast('profile:sync-status', status)
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
    clickThrough:
      settings.clickThrough !== undefined ? settings.clickThrough : overlayState.clickThrough
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

function setControlWindowVisible(visible: boolean): boolean {
  if (!refs || refs.controlWindow.isDestroyed()) {
    return false
  }

  if (visible) {
    refs.controlWindow.setSkipTaskbar(false)
    if (refs.controlWindow.isMinimized()) {
      refs.controlWindow.restore()
    }
    refs.controlWindow.show()
    refs.controlWindow.focus()
    return true
  }

  refs.controlWindow.hide()
  refs.controlWindow.setSkipTaskbar(true)
  return false
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

interface WebCorpusDocument {
  url?: string
  title?: string
  category?: string
  language?: string
  text?: string
  quality_score?: number
}

interface GlossaryEntry {
  term?: string
  definition_en?: string
  definition_tr?: string
  tags?: string[]
  source?: string
}

function parseJsonlFile<T>(filePath: string): T[] {
  const raw = readFileSync(filePath, 'utf8')
  const output: T[] = []
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      output.push(JSON.parse(trimmed) as T)
    } catch {
      continue
    }
  }
  return output
}

function ingestWebCorpusFromFile(filePath: string, limit: number): {
  importedSources: number
  importedChunks: number
  documentCount: number
} {
  if (!profileMemoryService) {
    throw new Error('Profile memory service unavailable.')
  }

  const docs = parseJsonlFile<WebCorpusDocument>(filePath)
  let importedSources = 0
  let importedChunks = 0
  const maxDocs = Math.max(1, limit)

  for (const doc of docs.slice(0, maxDocs)) {
    const text = String(doc.text || '').trim()
    if (text.length < 120) {
      continue
    }

    const title = String(doc.title || '').trim() || 'Web Corpus'
    const url = String(doc.url || '').trim()
    const category = String(doc.category || '').trim()
    const language = String(doc.language || '').trim() || 'unknown'
    const qualityScore = Number.isFinite(doc.quality_score) ? Number(doc.quality_score) : undefined
    const sourceName = `WEB ${title}`.slice(0, 140)

    const imported = profileMemoryService.importSource({
      type: 'web_corpus',
      name: sourceName,
      content: text,
      metadata: {
        ...(url ? { url } : {}),
        ...(category ? { category } : {}),
        language,
        ...(qualityScore !== undefined ? { qualityScore: qualityScore.toFixed(4) } : {})
      }
    })

    importedSources += 1
    importedChunks += imported.chunkCount
  }

  return {
    importedSources,
    importedChunks,
    documentCount: docs.length
  }
}

function ingestGlossaryFromFile(filePath: string, limit: number): {
  importedSources: number
  importedTerms: number
} {
  if (!profileMemoryService) {
    throw new Error('Profile memory service unavailable.')
  }

  const entries = parseJsonlFile<GlossaryEntry>(filePath)
  let importedSources = 0
  let importedTerms = 0
  const maxTerms = Math.max(1, limit)

  for (const entry of entries.slice(0, maxTerms)) {
    const term = String(entry.term || '').trim()
    if (!term) continue

    const definitionEn = String(entry.definition_en || '').trim()
    const definitionTr = String(entry.definition_tr || '').trim()
    const tags = Array.isArray(entry.tags) ? entry.tags.map((item) => String(item).trim()) : []
    const source = String(entry.source || '').trim()
    const content = [
      `Term: ${term}`,
      definitionEn ? `Definition EN: ${definitionEn}` : '',
      definitionTr ? `Definition TR: ${definitionTr}` : '',
      tags.length > 0 ? `Tags: ${tags.filter(Boolean).join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('\n')
      .trim()

    if (content.length < 16) continue

    profileMemoryService.importSource({
      type: 'glossary',
      name: `Glossary ${term}`.slice(0, 120),
      content,
      metadata: source ? { source } : undefined
    })

    importedSources += 1
    importedTerms += 1
  }

  return {
    importedSources,
    importedTerms
  }
}

function cancelActiveAssist(reason: string): void {
  if (assistAbortController) {
    assistAbortController.abort(new Error(reason))
    assistAbortController = null
    assistTranscriptId = null
  }
}

function clearPendingRemoteAssistTimer(): void {
  if (!pendingRemoteAssistTimer) return
  clearTimeout(pendingRemoteAssistTimer)
  pendingRemoteAssistTimer = null
}

function buildNormalizedContext(history: TranscriptEvent[]): string[] {
  return buildContextLines(history, activeSessionAssists, {
    remoteTurns: CONTEXT_REMOTE_TURNS,
    selfTurns: CONTEXT_SELF_TURNS,
    assistantTurns: CONTEXT_ASSIST_TURNS,
    maxCharsPerLine: CONTEXT_MAX_CHARS
  })
}

function enqueueAssistSegment(segment: RemoteAssistSegment): void {
  if (!segment.text.trim()) return

  if (assistQueue.length >= ASSIST_QUEUE_MAX) {
    assistQueue.shift()
    console.warn('[assist] queue saturated, dropping oldest pending segment')
  }

  assistQueue.push(segment)
  void processAssistQueue()
}

async function flushPendingRemoteAssist(): Promise<void> {
  if (!pendingRemoteSegment) return

  const next = pendingRemoteSegment
  pendingRemoteSegment = null
  clearPendingRemoteAssistTimer()
  enqueueAssistSegment(next)
}

function schedulePendingRemoteSegmentFlush(segment: RemoteAssistSegment): void {
  const delay = computeSegmentFlushDelay(segment, Date.now(), {
    punctuationFlushMs: REMOTE_SEGMENT_PUNCT_FLUSH_MS,
    pauseFlushMs: REMOTE_SEGMENT_PAUSE_FLUSH_MS,
    maxHoldMs: REMOTE_SEGMENT_MAX_HOLD_MS
  })

  clearPendingRemoteAssistTimer()
  if (delay === 0) {
    void flushPendingRemoteAssist()
    return
  }

  pendingRemoteAssistTimer = setTimeout(() => {
    void flushPendingRemoteAssist()
  }, delay)
}

function queueRemoteAssistFromTranscript(event: TranscriptEvent): void {
  if (event.speaker !== 'remote') return
  const text = (event.text || event.textEn || '').trim()
  if (!text) return

  const now = Date.now()

  if (!pendingRemoteSegment) {
    pendingRemoteSegment = createRemoteSegment(
      {
        ...event,
        text,
        textEn: text
      },
      now
    )
    schedulePendingRemoteSegmentFlush(pendingRemoteSegment)
    return
  }

  if (shouldSplitRemoteSegment(pendingRemoteSegment, event, REMOTE_SEGMENT_MERGE_GAP_MS)) {
    const previous = pendingRemoteSegment
    pendingRemoteSegment = createRemoteSegment(
      {
        ...event,
        text,
        textEn: text
      },
      now
    )
    enqueueAssistSegment(previous)
    schedulePendingRemoteSegmentFlush(pendingRemoteSegment)
    return
  }

  pendingRemoteSegment = appendRemoteSegment(
    pendingRemoteSegment,
    {
      ...event,
      text,
      textEn: text
    },
    now
  )
  schedulePendingRemoteSegmentFlush(pendingRemoteSegment)
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

function emitLatencyMetrics(): void {
  const total = workerTranscriptCount + workerErrorCount
  const workerErrorRate = total > 0 ? Number((workerErrorCount / total).toFixed(4)) : 0

  const payload: LatencyMetricsEvent = {
    sttFirstChunkMs: buildLatencySummary(sttFirstChunkHistory),
    assistFirstTokenMs: buildLatencySummary(assistFirstTokenHistory),
    assistFinalMs: buildLatencySummary(assistFinalHistory),
    workerErrorRate,
    updatedAtMs: Date.now()
  }

  broadcast('metrics:latency', payload)
}

function emitSttRuntimeStatus(status?: SttRuntimeStatusEvent): void {
  if (status) {
    sttRuntimeStatus = status
  }

  if (!sttRuntimeStatus) return
  broadcast('stt:runtime-status', sttRuntimeStatus)
}

function resetSessionMetrics(): void {
  sttFirstChunkHistory = []
  assistFirstTokenHistory = []
  assistFinalHistory = []
  workerErrorCount = 0
  workerTranscriptCount = 0
  emitLatencyMetrics()
}

function clearPendingSelfTranscriptTimer(): void {
  if (!pendingSelfTranscriptTimer) return
  clearTimeout(pendingSelfTranscriptTimer)
  pendingSelfTranscriptTimer = null
}

function dropPendingSelfTranscript(): void {
  pendingSelfTranscript = null
  clearPendingSelfTranscriptTimer()
}

function commitTranscriptEvent(event: TranscriptEvent): void {
  if (event.speaker === 'remote') {
    lastRemoteTranscript = { ...event }
  }

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
    queueRemoteAssistFromTranscript(event)
  }
}

function flushPendingSelfTranscript(): void {
  if (!pendingSelfTranscript) return
  const next = pendingSelfTranscript
  pendingSelfTranscript = null
  clearPendingSelfTranscriptTimer()
  commitTranscriptEvent(next)
}

function queueSelfTranscriptForEchoCheck(event: TranscriptEvent): void {
  pendingSelfTranscript = { ...event }
  clearPendingSelfTranscriptTimer()
  pendingSelfTranscriptTimer = setTimeout(() => {
    flushPendingSelfTranscript()
  }, SELF_ECHO_HOLD_MS)
}

function maybeDropPendingSelfAgainstRemote(remoteEvent: TranscriptEvent): void {
  if (!pendingSelfTranscript) return

  const shouldDropPending = shouldDropSelfEcho(
    pendingSelfTranscript,
    remoteEvent,
    lastWorkerDiagnostics,
    {
      echoWindowMs: SELF_ECHO_WINDOW_MS,
      echoSimilarity: SELF_ECHO_SIMILARITY
    }
  )
  if (shouldDropPending) {
    dropPendingSelfTranscript()
    return
  }

  if (pendingSelfTranscript.emittedMs <= remoteEvent.emittedMs) {
    flushPendingSelfTranscript()
  }
}

async function processAssistQueue(): Promise<void> {
  if (assistQueueRunning) return
  assistQueueRunning = true

  try {
    while (assistQueue.length > 0) {
      if (!sessionActive || !assistService || !settingsManager || suggestionsMuted) {
        assistQueue = []
        break
      }

      const next = assistQueue.shift()
      if (!next) break
      await handleRemoteSegment(next)
    }
  } finally {
    assistQueueRunning = false
  }
}

async function handleRemoteSegment(segment: RemoteAssistSegment): Promise<void> {
  if (!interviewAssistOrchestrator || !settingsManager || suggestionsMuted) return

  const controller = new AbortController()
  assistAbortController = controller
  assistTranscriptId = segment.id

  const settings = settingsManager.get()

  try {
    const finalAssist = await interviewAssistOrchestrator.generate({
      model: settings.answerModel,
      baseUrl: settings.ollamaBaseUrl,
      transcriptId: segment.id,
      segmentId: segment.id,
      sourceText: segment.text,
      sourceLanguage: segment.language,
      outputPolicy: settings.assistOutputPolicy,
      contextLines: buildNormalizedContext(transcriptHistory),
      assistantMode: settings.assistantMode,
      personalizationEnabled: settings.personalizationEnabled,
      assistPersonalizationPolicy: settings.assistPersonalizationPolicy,
      assistCompositionPolicy: settings.assistCompositionPolicy,
      assistLanguagePolicy: settings.assistLanguagePolicy,
      answerStyle: settings.interviewAnswerStyle,
      signal: controller.signal,
      timeoutMs: ASSIST_TIMEOUT_MS,
      onPartial: (partial: AssistEvent) => {
        partial.segmentId = segment.id
        broadcast('assist:update', partial)
      }
    })

    if (assistTranscriptId === segment.id) {
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

      if (finalAssist.qualityFlags?.includes('translation_retry')) {
        sessionDegradedCode = 'assist_quality_retry'
        emitSessionState()
      } else if (sessionDegradedCode === 'assist_quality_retry') {
        sessionDegradedCode = undefined
        emitSessionState()
      }

      trackAssistForSession(finalAssist)
      emitLatencyMetrics()
      broadcast('assist:update', finalAssist)
    }
  } catch (error) {
    const message = asErrorMessage(error)
    if (controller.signal.aborted) return

    const failed: AssistEvent = {
      id: randomUUID(),
      transcriptId: segment.id,
      segmentId: segment.id,
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
  if (suggestionsMuted) {
    cancelActiveAssist('muted')
    pendingRemoteSegment = null
    assistQueue = []
    assistQueueRunning = false
    clearPendingRemoteAssistTimer()
  }
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

export function hideControlWindowFromMain(): void {
  setControlWindowVisible(false)
}

export function showControlWindowFromMain(): void {
  setControlWindowVisible(true)
}

function setupBridgeListeners(): void {
  if (!sttBridge) return

  sttBridge.on('log', (line: string) => {
    console.warn(`[stt][worker] ${line}`)
  })

  sttBridge.on('runtime-status', (status: SttRuntimeStatusEvent) => {
    emitSttRuntimeStatus(status)

    if (!sessionActive) return

    if (status.phase === 'degraded') {
      workerReady = true
      sessionPhase = 'degraded'
      sessionReason = status.lastError ? 'stt_runtime_degraded' : 'stt_runtime_fallback'
      sessionDegradedCode =
        status.activeDevice === 'cpu' && status.requestedMode !== 'cpu' ? 'cuda_fallback' : undefined
      if (status.lastError) {
        sessionLastError = status.lastError
      }
      emitSessionState()
    } else if (status.phase === 'error') {
      sessionPhase = 'error'
      sessionReason = 'stt_runtime_error'
      sessionDegradedCode = undefined
      sessionLastError = status.lastError || 'STT runtime entered error phase.'
      emitSessionState()
    } else if (status.phase === 'running' && sessionPhase === 'degraded') {
      sessionPhase = 'running'
      sessionReason = 'stt_runtime_recovered'
      sessionDegradedCode = undefined
      sessionLastError = undefined
      emitSessionState()
    }
  })

  sttBridge.on('transcript', (event: TranscriptEvent) => {
    if (
      event.speaker === 'self' &&
      shouldDropSelfEcho(event, lastRemoteTranscript, lastWorkerDiagnostics, {
        echoWindowMs: SELF_ECHO_WINDOW_MS,
        echoSimilarity: SELF_ECHO_SIMILARITY
      })
    ) {
      return
    }

    if (event.speaker === 'remote') {
      maybeDropPendingSelfAgainstRemote(event)
      commitTranscriptEvent(event)
      return
    }

    if (event.speaker === 'self') {
      queueSelfTranscriptForEchoCheck(event)
      return
    }

    commitTranscriptEvent(event)
  })

  sttBridge.on('error', (error: Error) => {
    if (!sessionActive && sessionPhase !== 'starting') {
      return
    }

    workerErrorCount += 1
    emitLatencyMetrics()

    workerReady = false
    sessionPhase = 'degraded'
    sessionReason = 'worker_error'
    sessionDegradedCode = sessionDegradedCode || 'cuda_fallback'
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
      dropPendingSelfTranscript()
      finalizeActiveSession()
      sessionActive = false
      workerReady = false
      sessionPhase = 'error'
      sessionReason = 'worker_stopped_unexpectedly'
      sessionDegradedCode = undefined
      sessionLastError = 'STT worker stopped unexpectedly.'
      emitSessionState()
    }
  })

  sttBridge.on('diagnostics', (diagnostics: WorkerDiagnosticsEvent) => {
    lastWorkerDiagnostics = diagnostics
    broadcast('diagnostics:update', diagnostics)
  })
}

export function initializeIpcHandlers(windowRefs: WindowRefs): void {
  refs = windowRefs
  settingsManager = new SettingsManager()
  assistService = new AssistService()
  profileMemoryService = new ProfileMemoryService()
  connectorService = new ConnectorService(profileMemoryService)
  interviewAssistOrchestrator = new InterviewAssistOrchestrator(assistService, profileMemoryService)
  historyManager = new HistoryManager()
  const resolvedWorkerPath = resolveWorkerPath()
  const resolvedProfileExtractPath = resolveScriptPath('extract_profile_text.py')
  const resolvedWebCorpusSyncPath = resolveScriptPath('sync_web_corpus.py')
  const resolvedGlossaryBuildPath = resolveScriptPath('build_glossary_lexicon.py')
  const resolvedPython = resolvePythonBinary()
  const resolvedPythonEnv = resolvePythonEnvironment()
  profileFileImportService = new ProfileFileImportService({
    scriptPath: resolvedProfileExtractPath,
    pythonBin: resolvedPython,
    pythonEnv: resolvedPythonEnv
  })
  profileKnowledgeSyncService = new ProfileKnowledgeSyncService({
    webCorpusScriptPath: resolvedWebCorpusSyncPath,
    glossaryScriptPath: resolvedGlossaryBuildPath,
    pythonBin: resolvedPython,
    pythonEnv: resolvedPythonEnv
  })

  console.info(
    `[stt] init projectRoot=${resolveProjectRoot()} python=${resolvedPython} worker=${resolvedWorkerPath}`
  )

  sttBridge = new SttBridge({
    workerPath: resolvedWorkerPath,
    pythonBin: resolvedPython,
    pythonEnv: resolvedPythonEnv
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

  ipcMain.handle('profile:get', () => {
    if (!profileMemoryService) {
      throw new Error('Profile memory service unavailable.')
    }
    return profileMemoryService.getSnapshot() as ProfileSnapshot
  })

  ipcMain.handle('profile:import-source', (_event, payload: ProfileImportRequest) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda profil kaynagi degistirilemez.')
    }
    if (!profileMemoryService) {
      throw new Error('Profile memory service unavailable.')
    }
    const imported = profileMemoryService.importSource(payload) as ProfileImportResult
    emitProfileSyncStatus({
      state: 'done',
      sourceType: payload.type,
      message: `${payload.type} kaynagi eklendi.`,
      progress: 1,
      updatedAtMs: Date.now()
    })
    return imported
  })

  ipcMain.handle('profile:import-file', async (_event, payload: ProfileImportFileRequest) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda profil kaynagi degistirilemez.')
    }
    if (!profileMemoryService || !profileFileImportService) {
      throw new Error('Profile services unavailable.')
    }

    const sourceType = payload.type
    const ocrMode: ProfileImportOcrMode =
      payload.ocrMode === 'always' ? 'always' : payload.ocrMode === 'never' ? 'never' : 'auto'

    let filePath = String(payload.filePath || '').trim()
    if (!filePath) {
      const ownerWindow = refs?.controlWindow && !refs.controlWindow.isDestroyed() ? refs.controlWindow : null
      const pickerOptions = {
        title: 'Profil dosyasi sec',
        properties: ['openFile'] as Array<'openFile'>,
        filters: [
          {
            name: 'Supported',
            extensions: [
              'pdf',
              'docx',
              'txt',
              'md',
              'markdown',
              'json',
              'yaml',
              'yml',
              'csv',
              'tsv',
              'png',
              'jpg',
              'jpeg',
              'webp',
              'bmp'
            ]
          }
        ]
      }
      const pick = ownerWindow
        ? await dialog.showOpenDialog(ownerWindow, pickerOptions)
        : await dialog.showOpenDialog(pickerOptions)

      if (pick.canceled || pick.filePaths.length === 0) {
        const cancelled: ProfileImportFileResult = {
          success: false,
          cancelled: true
        }
        return cancelled
      }

      filePath = pick.filePaths[0]
    }

    emitProfileSyncStatus({
      state: 'running',
      sourceType,
      message: 'Dosya okunuyor...',
      progress: 0.15,
      updatedAtMs: Date.now()
    })

    try {
      const extracted = await profileFileImportService.extractFromFile(filePath, ocrMode)
      const sourceName = String(payload.name || '').trim() || basename(filePath)
      const metadata: Record<string, string> = {
        filePath,
        parser: extracted.parser,
        ocrUsed: extracted.ocrUsed ? 'true' : 'false'
      }
      for (const [key, value] of Object.entries(extracted.metadata)) {
        if (value === undefined || value === null) continue
        metadata[key] = String(value)
      }

      const imported = profileMemoryService.importSource({
        type: sourceType,
        name: sourceName,
        content: extracted.text,
        metadata
      }) as ProfileImportResult

      emitProfileSyncStatus({
        state: 'done',
        sourceType,
        message: `${sourceType} dosya import tamamlandi (${extracted.parser}${extracted.ocrUsed ? ', ocr' : ''}).`,
        progress: 1,
        updatedAtMs: Date.now()
      })

      const result: ProfileImportFileResult = {
        success: true,
        cancelled: false,
        source: imported.source,
        chunkCount: imported.chunkCount,
        filePath,
        parser: extracted.parser,
        ocrUsed: extracted.ocrUsed,
        extractedChars: extracted.text.length,
        warnings: extracted.warnings
      }
      return result
    } catch (error) {
      emitProfileSyncStatus({
        state: 'error',
        sourceType,
        message: asErrorMessage(error),
        progress: 0,
        updatedAtMs: Date.now()
      })
      throw error
    }
  })

  ipcMain.handle('profile:sync-github', async (_event, payload: GithubSyncRequest) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda GitHub senkronu kapali.')
    }
    if (!connectorService) {
      throw new Error('Connector service unavailable.')
    }
    return connectorService.syncGithub(payload, {
      onStatus: (status) => {
        emitProfileSyncStatus(status)
      }
    })
  })

  ipcMain.handle('profile:sync-web-corpus', async (_event, payload: WebCorpusSyncRequest = {}) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda web corpus senkronu kapali.')
    }
    if (!profileMemoryService || !profileKnowledgeSyncService) {
      throw new Error('Profile knowledge services unavailable.')
    }

    const runtimeCorpusDir = join(app.getPath('userData'), 'corpus')
    const resolvedConfigPath =
      String(payload.configPath || '').trim() || resolveConfigPath('web_corpus_sources.yaml')
    const resolvedOutputPath =
      String(payload.outputPath || '').trim() || join(runtimeCorpusDir, 'web_corpus.jsonl')
    const importLimit = Math.max(1, Number(payload.importLimit || 120))
    const shouldBuildGlossary = payload.buildGlossary !== false

    emitProfileSyncStatus({
      state: 'running',
      sourceType: 'web_corpus',
      message: 'Web corpus kaynaklari toplaniyor...',
      progress: 0.1,
      updatedAtMs: Date.now()
    })

    try {
      const build = await profileKnowledgeSyncService.syncWebCorpus({
        ...payload,
        configPath: resolvedConfigPath,
        outputPath: resolvedOutputPath
      })
      const imported = ingestWebCorpusFromFile(build.outputPath, importLimit)
      let warnings = [...build.warnings]
      let glossaryPath: string | undefined
      let glossaryTerms: number | undefined

      if (shouldBuildGlossary) {
        emitProfileSyncStatus({
          state: 'running',
          sourceType: 'glossary',
          message: 'Meslek sozlugu olusturuluyor...',
          progress: 0.72,
          updatedAtMs: Date.now()
        })
        const glossaryBuild = await profileKnowledgeSyncService.buildGlossary({
          corpusPath: build.outputPath,
          glossaryRequest: {
            glossaryPath: join(runtimeCorpusDir, 'glossary.jsonl'),
            maxTerms: 600
          },
          seedPath: resolveConfigPath('glossary_seed.json')
        })
        const glossaryImported = ingestGlossaryFromFile(glossaryBuild.outputPath, 500)
        glossaryPath = glossaryBuild.outputPath
        glossaryTerms = glossaryImported.importedTerms
        warnings = [...warnings, ...glossaryBuild.warnings]
      }

      profileMemoryService.reindex()
      emitProfileSyncStatus({
        state: 'done',
        sourceType: 'web_corpus',
        message: `Web corpus sync tamamlandi (${imported.importedSources} kaynak).`,
        progress: 1,
        updatedAtMs: Date.now()
      })

      const result: WebCorpusSyncResult = {
        success: true,
        outputPath: build.outputPath,
        documentCount: imported.documentCount,
        importedSources: imported.importedSources,
        importedChunks: imported.importedChunks,
        warnings: warnings.length > 0 ? warnings : undefined,
        glossaryPath,
        glossaryTerms
      }
      return result
    } catch (error) {
      emitProfileSyncStatus({
        state: 'error',
        sourceType: 'web_corpus',
        message: asErrorMessage(error),
        progress: 0,
        updatedAtMs: Date.now()
      })
      throw error
    }
  })

  ipcMain.handle('profile:ingest-glossary', async (_event, payload: GlossaryIngestRequest = {}) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda glossary import kapali.')
    }
    if (!profileMemoryService || !profileKnowledgeSyncService) {
      throw new Error('Profile knowledge services unavailable.')
    }

    const glossaryPath =
      String(payload.glossaryPath || '').trim() || join(app.getPath('userData'), 'corpus', 'glossary.jsonl')
    const maxTerms = Math.max(1, Number(payload.maxTerms || 500))

    emitProfileSyncStatus({
      state: 'running',
      sourceType: 'glossary',
      message: 'Glossary import ediliyor...',
      progress: 0.2,
      updatedAtMs: Date.now()
    })

    try {
      const imported = ingestGlossaryFromFile(glossaryPath, maxTerms)
      profileMemoryService.reindex()

      emitProfileSyncStatus({
        state: 'done',
        sourceType: 'glossary',
        message: `Glossary import tamamlandi (${imported.importedTerms} terim).`,
        progress: 1,
        updatedAtMs: Date.now()
      })

      const result: GlossaryIngestResult = {
        success: true,
        glossaryPath,
        importedSources: imported.importedSources,
        importedTerms: imported.importedTerms
      }
      return result
    } catch (error) {
      emitProfileSyncStatus({
        state: 'error',
        sourceType: 'glossary',
        message: asErrorMessage(error),
        progress: 0,
        updatedAtMs: Date.now()
      })
      throw error
    }
  })

  ipcMain.handle('profile:reindex', () => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda reindex kapali.')
    }
    if (!profileMemoryService) {
      throw new Error('Profile memory service unavailable.')
    }
    const result = profileMemoryService.reindex() as ProfileReindexResult
    emitProfileSyncStatus({
      state: 'done',
      sourceType: 'note',
      message: `Reindex tamamlandi (${result.chunkCount} chunk).`,
      progress: 1,
      updatedAtMs: Date.now()
    })
    return result
  })

  ipcMain.handle('profile:context-preview', (_event, query?: string) => {
    if (!profileMemoryService) {
      throw new Error('Profile memory service unavailable.')
    }
    return profileMemoryService.getContextPreview(String(query || ''), 5) as InterviewContextPreview
  })

  ipcMain.handle('profile:clear-source', (_event, payload: ProfileClearSourceRequest) => {
    if (sessionActive) {
      throw new Error('Canli oturum sirasinda kaynak silme kapali.')
    }
    if (!profileMemoryService) {
      throw new Error('Profile memory service unavailable.')
    }
    const result = profileMemoryService.clearSource(payload)
    emitProfileSyncStatus({
      state: 'done',
      sourceType: 'note',
      message: 'Kaynak silindi.',
      progress: 1,
      updatedAtMs: Date.now()
    })
    return result
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
    const requestedRuntimeMode: SttRuntimeMode = payload.sttRuntimeMode || settings.sttRuntimeMode || 'auto'
    const requestedLanguageMode = payload.sttLanguageMode || settings.sttLanguageMode || 'segment_auto'
    const requestedManualLanguage = payload.manualSttLanguage || settings.manualSttLanguage || 'tr'

    transcriptHistory = []
    lastRemoteTranscript = null
    lastWorkerDiagnostics = null
    dropPendingSelfTranscript()
    pendingRemoteSegment = null
    clearPendingRemoteAssistTimer()
    assistQueue = []
    assistQueueRunning = false
    resetSessionMetrics()
    resetActiveSessionBuffers()
    activeSessionId = randomUUID()
    activeSessionStartedAtMs = Date.now()
    activeSessionSttModel = payload.sttModel || settings.sttModel
    activeSessionAnswerModel = settings.answerModel

    sessionActive = true
    suggestionsMuted = false
    workerReady = false
    sessionPhase = 'starting'
    sessionReason = 'start_requested'
    sessionLastError = undefined
    sessionDegradedCode = undefined
    intentionalWorkerStop = false
    emitSessionState()

    try {
      await sttBridge.start(payload.sttModel || settings.sttModel, {
        vad: payload.vad || settings.vad,
        runtimeMode: requestedRuntimeMode,
        sttLanguageMode: requestedLanguageMode,
        manualSttLanguage: requestedManualLanguage,
        cudaRetryCount: STT_CUDA_RETRY_COUNT,
        eagerWarmup: true,
        timeoutMs: START_SESSION_TIMEOUT_MS
      })
      workerReady = true
      sessionPhase = 'running'
      sessionReason = 'worker_ready'
      sessionLastError = undefined
      sessionDegradedCode = undefined

      if (assistService) {
        try {
          await assistService.prewarm({
            model: settings.answerModel,
            baseUrl: settings.ollamaBaseUrl,
            timeoutMs: ASSIST_PREWARM_TIMEOUT_MS
          })
        } catch (prewarmError) {
          sessionPhase = 'degraded'
          sessionReason = 'assist_prewarm_failed'
          sessionLastError = asErrorMessage(prewarmError)
          sessionDegradedCode = 'assist_quality_retry'
        }
      }

      emitSessionState()
      return { success: true }
    } catch (error) {
      resetActiveSessionBuffers()
      sessionActive = false
      workerReady = false
      sessionPhase = 'error'
      sessionReason = 'start_failed'
      sessionLastError = asErrorMessage(error)
      sessionDegradedCode = undefined
      emitSessionState()
      throw error
    }
  })

  ipcMain.handle('session:stop', () => {
    if (!sessionActive && sessionPhase === 'idle') {
      return { success: true }
    }

    cancelActiveAssist('session_stopped')
    dropPendingSelfTranscript()
    pendingRemoteSegment = null
    assistQueue = []
    assistQueueRunning = false
    clearPendingRemoteAssistTimer()

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
    sessionDegradedCode = undefined
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

    sttBridge.injectTranscript(payload.speaker, payload.text, payload.language)
    return { success: true }
  })

  ipcMain.handle('assist:manual-generate', async (_event, payload: ManualAssistRequest) => {
    if (sessionActive) {
      throw new Error('Canli oturum acikken manuel test kapali. Oturumu durdurup tekrar deneyin.')
    }
    if (!settingsManager || !interviewAssistOrchestrator) {
      throw new Error('Assist dependencies unavailable.')
    }
    if (suggestionsMuted) {
      throw new Error('Asistan sessizde. Once asistani aktif edin.')
    }

    const text = String(payload.text || '').trim()
    if (!text) {
      throw new Error('Test sorusu bos olamaz.')
    }

    const speaker = payload.speaker === 'self' ? 'self' : 'remote'
    const language = String(payload.language || '').trim() || 'unknown'
    const now = Date.now()
    const transcript: TranscriptEvent = {
      id: randomUUID(),
      speaker,
      text,
      textEn: text,
      language,
      languageConfidence: 1,
      isFinal: true,
      tStartMs: now,
      tEndMs: now,
      emittedMs: now,
      confidence: 0.95
    }

    commitTranscriptEvent(transcript)
    if (speaker !== 'remote') {
      const noAssistResult: ManualAssistResult = {
        success: true,
        transcriptId: transcript.id
      }
      return noAssistResult
    }

    const settings = settingsManager.get()
    try {
      if (assistService) {
        try {
          await assistService.prewarm({
            model: settings.answerModel,
            baseUrl: settings.ollamaBaseUrl,
            timeoutMs: MANUAL_ASSIST_PREWARM_TIMEOUT_MS
          })
        } catch {
          // Best effort only; generation below still runs with extended timeout.
        }
      }

      const finalAssist = await interviewAssistOrchestrator.generate({
        model: settings.answerModel,
        baseUrl: settings.ollamaBaseUrl,
        transcriptId: transcript.id,
        segmentId: transcript.id,
        sourceText: text,
        sourceLanguage: language,
        outputPolicy: settings.assistOutputPolicy,
        contextLines: buildNormalizedContext(transcriptHistory),
        assistantMode: settings.assistantMode,
        personalizationEnabled: settings.personalizationEnabled,
        assistPersonalizationPolicy: settings.assistPersonalizationPolicy,
        assistCompositionPolicy: settings.assistCompositionPolicy,
        assistLanguagePolicy: settings.assistLanguagePolicy,
        answerStyle: settings.interviewAnswerStyle,
        timeoutMs: MANUAL_ASSIST_TIMEOUT_MS,
        onPartial: (partial: AssistEvent) => {
          partial.segmentId = transcript.id
          broadcast('assist:update', partial)
        }
      })

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
      emitLatencyMetrics()

      trackAssistForSession(finalAssist)
      broadcast('assist:update', finalAssist)
      const result: ManualAssistResult = {
        success: true,
        transcriptId: transcript.id,
        assistId: finalAssist.id
      }
      return result
    } catch (error) {
      const failed: AssistEvent = {
        id: randomUUID(),
        transcriptId: transcript.id,
        segmentId: transcript.id,
        sourceLanguage: language,
        sourceText: text,
        state: 'error',
        error: asErrorMessage(error),
        latencyMs: Date.now() - now
      }
      trackAssistForSession(failed)
      broadcast('assist:update', failed)
      throw error
    }
  })

  ipcMain.handle('overlay:set', (_event, settings: OverlaySettings) => {
    applyOverlaySettings(settings)
    return { success: true }
  })

  ipcMain.handle('control:hide', () => {
    setControlWindowVisible(false)
    return { success: true }
  })

  ipcMain.handle('control:show', () => {
    setControlWindowVisible(true)
    return { success: true }
  })

  ipcMain.handle('control:toggle', () => {
    const visible = setControlWindowVisible(!refs?.controlWindow.isVisible())
    return { success: true, visible }
  })

  ipcMain.handle('assistant:toggle-mute', () => {
    toggleSuggestionsMuteFromShortcut()
    return { success: true, muted: suggestionsMuted }
  })

  ipcMain.handle('session:redetect-audio-source', () => {
    return { success: true }
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
  sessionDegradedCode = undefined
  sessionActive = false
  workerReady = false
  sttRuntimeStatus = null
  emitSessionState()
  emitProfileSyncStatus({
    state: 'idle',
    sourceType: 'note',
    message: 'Profil bellek hazir.',
    progress: 0,
    updatedAtMs: Date.now()
  })
  emitLatencyMetrics()
}

export function cleanupIpcHandlers(): void {
  cancelActiveAssist('ipc_cleanup')
  dropPendingSelfTranscript()
  pendingRemoteSegment = null
  assistQueue = []
  assistQueueRunning = false
  clearPendingRemoteAssistTimer()

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
  profileMemoryService = null
  profileFileImportService = null
  profileKnowledgeSyncService = null
  connectorService = null
  interviewAssistOrchestrator = null
  historyManager = null
  refs = null
  sessionActive = false
  suggestionsMuted = false
  workerReady = false
  sessionPhase = 'idle'
  sessionReason = undefined
  sessionLastError = undefined
  sessionDegradedCode = undefined
  transcriptHistory = []
  lastRemoteTranscript = null
  lastWorkerDiagnostics = null
  pendingSelfTranscript = null
  clearPendingSelfTranscriptTimer()
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
  sttRuntimeStatus = null

  ipcMain.removeHandler('settings:get')
  ipcMain.removeHandler('settings:update')
  ipcMain.removeHandler('profile:get')
  ipcMain.removeHandler('profile:import-source')
  ipcMain.removeHandler('profile:import-file')
  ipcMain.removeHandler('profile:sync-github')
  ipcMain.removeHandler('profile:sync-web-corpus')
  ipcMain.removeHandler('profile:ingest-glossary')
  ipcMain.removeHandler('profile:reindex')
  ipcMain.removeHandler('profile:context-preview')
  ipcMain.removeHandler('profile:clear-source')
  ipcMain.removeHandler('audio:sources')
  ipcMain.removeHandler('history:list')
  ipcMain.removeHandler('history:export')
  ipcMain.removeHandler('session:start')
  ipcMain.removeHandler('session:stop')
  ipcMain.removeHandler('session:update-vad')
  ipcMain.removeHandler('transcript:inject')
  ipcMain.removeHandler('assist:manual-generate')
  ipcMain.removeHandler('overlay:set')
  ipcMain.removeHandler('control:hide')
  ipcMain.removeHandler('control:show')
  ipcMain.removeHandler('control:toggle')
  ipcMain.removeHandler('assistant:toggle-mute')
  ipcMain.removeHandler('session:redetect-audio-source')
}
