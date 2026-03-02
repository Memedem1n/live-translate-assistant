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
    const [settings, sources] = await Promise.all([window.api.getSettings(), window.api.getAudioSources()])
    useAppStore.getState().setSettings(settings)
    useAppStore.getState().setAudioSources(sources)
  } catch (error) {
    useAppStore
      .getState()
      .setError(error instanceof Error ? error.message : 'Failed to load startup state.')
  }

  window.api.onTranscriptFinal((event) => useAppStore.getState().addTranscript(event))
  window.api.onAssistUpdate((event) => useAppStore.getState().upsertAssist(event))
  window.api.onSessionState((state) => useAppStore.getState().setSessionState(state))
  window.api.onShortcutMuteToggle((muted) =>
    useAppStore.getState().setSessionState({ ...useAppStore.getState().session, muted })
  )

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
}

void bootstrap()
