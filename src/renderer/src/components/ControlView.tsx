import { useEffect, useMemo, useRef, useState } from 'react'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'

export function ControlView(): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    transcripts,
    assistUpdates,
    error,
    setError,
    patchSettings,
    setSettings,
    setAudioSources,
    setSelectedSystemSourceId
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
  const [remoteInject, setRemoteInject] = useState('')
  const [selfInject, setSelfInject] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        void audioRef.current.stop()
        audioRef.current = null
      }
    }
  }, [])

  const latestAssist = useMemo(() => {
    return [...assistUpdates].reverse().slice(0, 20)
  }, [assistUpdates])

  const refreshSources = async (): Promise<void> => {
    try {
      const sources = await window.api.getAudioSources()
      setAudioSources(sources)
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : 'Failed to list audio sources')
    }
  }

  const startSession = async (): Promise<void> => {
    if (!settings) return

    try {
      setError(null)

      if (!selectedSystemSourceId) {
        throw new Error('Select a system audio source before starting the session.')
      }

      await window.api.startSession({
        mode: 'meeting',
        sttModel: settings.sttModel
      })

      const capture = new MeetingAudioCapture()
      await capture.start(selectedSystemSourceId, (chunk) => {
        window.api.sendAudioChunk(chunk)
      })

      audioRef.current = capture
    } catch (startError) {
      if (audioRef.current) {
        await audioRef.current.stop()
        audioRef.current = null
      }
      await window.api.stopSession()
      setError(startError instanceof Error ? startError.message : 'Failed to start session.')
    }
  }

  const stopSession = async (): Promise<void> => {
    try {
      if (audioRef.current) {
        await audioRef.current.stop()
        audioRef.current = null
      }
      await window.api.stopSession()
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Failed to stop session.')
    }
  }

  const persistSettings = async (): Promise<void> => {
    if (!settings) return

    try {
      setSavingSettings(true)
      const saved = await window.api.updateSettings(settings)
      setSettings(saved)
      setError(null)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Failed to save settings.')
    } finally {
      setSavingSettings(false)
    }
  }

  const injectRemote = async (): Promise<void> => {
    const value = remoteInject.trim()
    if (!value) return

    await window.api.injectTranscript({ speaker: 'remote', textEn: value })
    setRemoteInject('')
  }

  const injectSelf = async (): Promise<void> => {
    const value = selfInject.trim()
    if (!value) return

    await window.api.injectTranscript({ speaker: 'self', textEn: value })
    setSelfInject('')
  }

  const setOverlayOpacity = async (value: number): Promise<void> => {
    patchSettings({ overlayOpacity: value })
    await window.api.setOverlay({ opacity: value })
  }

  const setOverlayVisibility = async (visible: boolean): Promise<void> => {
    patchSettings({ overlayVisible: visible })
    await window.api.setOverlay({ visible })
  }

  const setOverlayClickThrough = async (clickThrough: boolean): Promise<void> => {
    patchSettings({ overlayClickThrough: clickThrough })
    await window.api.setOverlay({ clickThrough })
  }

  if (!settings) {
    return (
      <div className="app-shell">
        <div className="glass card">Loading settings...</div>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <div className="glass header-card">
        <div>
          <div className="title">LiveTranslate Assistant</div>
          <div className="subtitle">
            Local-first meeting copilot | session: {session.active ? 'active' : 'idle'} | muted:{' '}
            {session.muted ? 'yes' : 'no'}
          </div>
        </div>

        <div className="row">
          {session.active ? (
            <button className="danger" onClick={stopSession}>
              Stop Session
            </button>
          ) : (
            <button className="primary" onClick={startSession}>
              Start Session
            </button>
          )}

          <button onClick={refreshSources}>Refresh Sources</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="grid">
        <div className="glass card">
          <h3>Session Controls</h3>

          <div className="row">
            <label style={{ width: 120 }}>System Audio</label>
            <select
              value={selectedSystemSourceId}
              onChange={(e) => setSelectedSystemSourceId(e.target.value)}
              style={{ flex: 1 }}
            >
              {audioSources.length === 0 && <option value="">No source found</option>}
              {audioSources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>STT Model</label>
            <input
              style={{ flex: 1 }}
              value={settings.sttModel}
              onChange={(e) => patchSettings({ sttModel: e.target.value })}
            />
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Answer Model</label>
            <input
              style={{ flex: 1 }}
              value={settings.answerModel}
              onChange={(e) => patchSettings({ answerModel: e.target.value })}
            />
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Ollama URL</label>
            <input
              style={{ flex: 1 }}
              value={settings.ollamaBaseUrl}
              onChange={(e) => patchSettings({ ollamaBaseUrl: e.target.value })}
            />
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Overlay</label>
            <button onClick={() => setOverlayVisibility(!settings.overlayVisible)}>
              {settings.overlayVisible ? 'Hide' : 'Show'} Overlay
            </button>
            <label>
              <input
                type="checkbox"
                checked={settings.overlayClickThrough}
                onChange={(e) => setOverlayClickThrough(e.target.checked)}
              />
              Click-through
            </label>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Opacity</label>
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.01"
              value={settings.overlayOpacity}
              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
              style={{ flex: 1 }}
            />
            <span>{Math.round(settings.overlayOpacity * 100)}%</span>
          </div>

          <div className="row">
            <button onClick={persistSettings} disabled={savingSettings}>
              {savingSettings ? 'Saving...' : 'Save Settings'}
            </button>
          </div>

          <h3>Manual Test Injection</h3>

          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder="Inject remote English sentence"
              value={remoteInject}
              onChange={(e) => setRemoteInject(e.target.value)}
            />
            <button onClick={injectRemote}>Inject Remote</button>
          </div>

          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder="Inject your own sentence"
              value={selfInject}
              onChange={(e) => setSelfInject(e.target.value)}
            />
            <button onClick={injectSelf}>Inject Self</button>
          </div>

          <div className="subtitle">
            Hotkeys: Ctrl+Shift+O (overlay), Ctrl+Shift+M (mute), Ctrl+Shift+H (panic hide)
          </div>
        </div>

        <div className="glass card">
          <h3>Transcript Stream</h3>
          <div className="list" style={{ maxHeight: 240 }}>
            {[...transcripts].reverse().slice(0, 40).map((item) => (
              <div className="item" key={item.id}>
                <div className={`badge ${item.speaker}`}>{item.speaker}</div>
                <div style={{ marginTop: 6 }}>{item.textEn}</div>
              </div>
            ))}
          </div>

          <h3>Assist Output</h3>
          <div className="list">
            {latestAssist.map((item) => (
              <div className="item" key={item.id}>
                <div className="subtitle">
                  state: {item.state} | latency: {item.latencyMs} ms
                </div>
                {item.state === 'partial' && <div>{item.rawText || 'Generating...'}</div>}
                {item.state === 'final' && (
                  <>
                    <div>
                      <strong>TR:</strong> {item.translationTr}
                    </div>
                    <div>
                      <strong>Reply EN:</strong> {item.replyEn}
                    </div>
                    <div>
                      <strong>Reply TR:</strong> {item.replyTr}
                    </div>
                    <div className="subtitle">confidence: {Math.round((item.confidence || 0) * 100)}%</div>
                  </>
                )}
                {item.state === 'error' && <div className="error">{item.error}</div>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
