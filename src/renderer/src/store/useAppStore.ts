import { create } from 'zustand'
import {
  AppSettings,
  AssistEvent,
  AudioSourceItem,
  CaptureDiagnosticsEvent,
  HistoryListResult,
  HistorySessionSummary,
  LatencyMetricsEvent,
  SessionStateEvent,
  TranscriptEvent,
  WorkerDiagnosticsEvent
} from '../../../shared/contracts'

export type ViewMode = 'control' | 'overlay'

interface AppStore {
  view: ViewMode
  settings: AppSettings | null
  session: SessionStateEvent
  audioSources: AudioSourceItem[]
  selectedSystemSourceId: string
  transcripts: TranscriptEvent[]
  assistUpdates: AssistEvent[]
  workerDiagnostics: WorkerDiagnosticsEvent | null
  captureDiagnostics: CaptureDiagnosticsEvent | null
  latencyMetrics: LatencyMetricsEvent | null
  historyEncryptionAvailable: boolean
  historySessions: HistorySessionSummary[]
  error: string | null

  setView: (view: ViewMode) => void
  setSettings: (settings: AppSettings) => void
  patchSettings: (updates: Partial<AppSettings>) => void
  setSessionState: (state: SessionStateEvent) => void
  setAudioSources: (sources: AudioSourceItem[]) => void
  setSelectedSystemSourceId: (id: string) => void
  addTranscript: (event: TranscriptEvent) => void
  upsertAssist: (event: AssistEvent) => void
  setWorkerDiagnostics: (event: WorkerDiagnosticsEvent) => void
  setCaptureDiagnostics: (event: CaptureDiagnosticsEvent | null) => void
  setLatencyMetrics: (event: LatencyMetricsEvent | null) => void
  setHistoryList: (result: HistoryListResult) => void
  setError: (message: string | null) => void
  reset: () => void
}

export const useAppStore = create<AppStore>((set) => ({
  view: 'control',
  settings: null,
  session: { active: false, muted: false, phase: 'idle', workerReady: false },
  audioSources: [],
  selectedSystemSourceId: '',
  transcripts: [],
  assistUpdates: [],
  workerDiagnostics: null,
  captureDiagnostics: null,
  latencyMetrics: null,
  historyEncryptionAvailable: false,
  historySessions: [],
  error: null,

  setView: (view) => set({ view }),

  setSettings: (settings) => set({ settings }),

  patchSettings: (updates) =>
    set((state) => ({
      settings: state.settings
        ? {
            ...state.settings,
            ...updates,
            hotkeys: {
              ...state.settings.hotkeys,
              ...(updates.hotkeys || {})
            },
            vad: updates.vad
              ? {
                  ...state.settings.vad,
                  ...updates.vad,
                  remote: {
                    ...state.settings.vad.remote,
                    ...(updates.vad.remote || {})
                  },
                  self: {
                    ...state.settings.vad.self,
                    ...(updates.vad.self || {})
                  }
                }
              : state.settings.vad
          }
        : state.settings
    })),

  setSessionState: (session) => set({ session }),

  setAudioSources: (audioSources) =>
    set((state) => ({
      audioSources,
      selectedSystemSourceId: state.selectedSystemSourceId || audioSources[0]?.id || ''
    })),

  setSelectedSystemSourceId: (selectedSystemSourceId) => set({ selectedSystemSourceId }),

  addTranscript: (event) =>
    set((state) => ({
      transcripts: [...state.transcripts.slice(-199), event]
    })),

  upsertAssist: (event) =>
    set((state) => {
      const idx = state.assistUpdates.findIndex((item) => item.id === event.id)
      if (idx === -1) {
        return {
          assistUpdates: [...state.assistUpdates.slice(-79), event]
        }
      }

      const cloned = [...state.assistUpdates]
      cloned[idx] = {
        ...cloned[idx],
        ...event
      }

      return { assistUpdates: cloned }
    }),

  setWorkerDiagnostics: (workerDiagnostics) => set({ workerDiagnostics }),
  setCaptureDiagnostics: (captureDiagnostics) => set({ captureDiagnostics }),
  setLatencyMetrics: (latencyMetrics) => set({ latencyMetrics }),
  setHistoryList: (result) =>
    set({
      historyEncryptionAvailable: result.encryptionAvailable,
      historySessions: result.sessions
    }),

  setError: (error) => set({ error }),

  reset: () =>
    set({
      transcripts: [],
      assistUpdates: [],
      workerDiagnostics: null,
      captureDiagnostics: null,
      latencyMetrics: null,
      historyEncryptionAvailable: false,
      historySessions: [],
      error: null
    })
}))
