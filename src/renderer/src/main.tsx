import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { useAppStore } from './store/useAppStore'
import './styles.css'

async function bootstrap(): Promise<void> {
  const params = new URLSearchParams(window.location.search)
  const view = params.get('view') === 'overlay' ? 'overlay' : 'control'
  useAppStore.getState().setView(view)

  try {
    const [settings, sources, profileSnapshot, interviewContextPreview] = await Promise.all([
      window.api.getSettings(),
      window.api.getAudioSources(),
      window.api.getProfileSnapshot(),
      window.api.getInterviewContextPreview('')
    ])
    const store = useAppStore.getState()
    store.setSettings(settings)
    store.setAudioSources(sources)
    store.setProfileSnapshot(profileSnapshot)
    store.setInterviewContextPreview(interviewContextPreview)

    if (settings.systemAudioMode === 'manual' && settings.manualSystemSourceId) {
      const matched = sources.find((item) => item.id === settings.manualSystemSourceId)
      if (matched) {
        store.setSelectedSystemSourceId(matched.id)
      }
    }
  } catch (error) {
    useAppStore
      .getState()
      .setError(error instanceof Error ? error.message : 'Failed to load startup state.')
  }

  window.api.onTranscriptFinal((event) => useAppStore.getState().addTranscript(event))
  window.api.onAssistUpdate((event) => useAppStore.getState().upsertAssist(event))
  window.api.onSessionState((session) => useAppStore.getState().setSessionState(session))
  window.api.onDiagnosticsUpdate((event) => useAppStore.getState().setWorkerDiagnostics(event))
  window.api.onLatencyMetrics((event) => useAppStore.getState().setLatencyMetrics(event))
  window.api.onSttRuntimeStatus((event) => useAppStore.getState().setSttRuntimeStatus(event))
  window.api.onProfileSyncStatus((status) => {
    const store = useAppStore.getState()
    store.setProfileSyncStatus(status)
    if (status.state === 'done') {
      void window.api.getProfileSnapshot().then((snapshot) => store.setProfileSnapshot(snapshot))
    }
  })
  window.api.onOverlayState((overlay) =>
    useAppStore.getState().patchSettings({
      overlayVisible: overlay.visible,
      overlayOpacity: overlay.opacity,
      overlayClickThrough: overlay.clickThrough
    })
  )

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
