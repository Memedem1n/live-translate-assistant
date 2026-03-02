import { create } from 'zustand'
import {
  AppSettings,
  AssistEvent,
  AudioSourceItem,
  SessionStateEvent,
  TranscriptEvent
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
  error: string | null

  setView: (view: ViewMode) => void
  setSettings: (settings: AppSettings) => void
  patchSettings: (updates: Partial<AppSettings>) => void
  setSessionState: (state: SessionStateEvent) => void
  setAudioSources: (sources: AudioSourceItem[]) => void
  setSelectedSystemSourceId: (id: string) => void
  addTranscript: (event: TranscriptEvent) => void
  upsertAssist: (event: AssistEvent) => void
  setError: (message: string | null) => void
  reset: () => void
}

export const useAppStore = create<AppStore>((set) => ({
  view: 'control',
  settings: null,
  session: { active: false, muted: false },
  audioSources: [],
  selectedSystemSourceId: '',
  transcripts: [],
  assistUpdates: [],
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
            }
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
      transcripts: [...state.transcripts.slice(-200), event]
    })),

  upsertAssist: (event) =>
    set((state) => {
      const idx = state.assistUpdates.findIndex((item) => item.id === event.id)
      if (idx === -1) {
        return {
          assistUpdates: [...state.assistUpdates.slice(-80), event]
        }
      }

      const cloned = [...state.assistUpdates]
      cloned[idx] = {
        ...cloned[idx],
        ...event
      }

      return { assistUpdates: cloned }
    }),

  setError: (error) => set({ error }),

  reset: () =>
    set({
      transcripts: [],
      assistUpdates: [],
      error: null
    })
}))
