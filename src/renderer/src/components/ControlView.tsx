import { useEffect, useMemo, useRef, useState } from 'react'
import { HistoryExportFormat, VadChannelConfig } from '../../../shared/contracts'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'

type VadField = keyof VadChannelConfig

export function ControlView(): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    transcripts,
    assistUpdates,
    workerDiagnostics,
    captureDiagnostics,
    latencyMetrics,
    historyEncryptionAvailable,
    historySessions,
    error,
    setError,
    patchSettings,
    setSettings,
    setAudioSources,
    setSelectedSystemSourceId,
    setCaptureDiagnostics,
    setHistoryList
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
  const vadApplyTimerRef = useRef<number | null>(null)
  const wasSessionActiveRef = useRef(false)

  const [remoteInject, setRemoteInject] = useState('')
  const [selfInject, setSelfInject] = useState('')
  const [savingSettings, setSavingSettings] = useState(false)
  const [streamQuery, setStreamQuery] = useState('')
  const [speakerFilter, setSpeakerFilter] = useState<'all' | 'remote' | 'self'>('all')
  const [assistFilter, setAssistFilter] = useState<'all' | 'partial' | 'final' | 'error'>('all')
  const [historyBusy, setHistoryBusy] = useState(false)
  const [exportBusy, setExportBusy] = useState<HistoryExportFormat | null>(null)
  const [historyMessage, setHistoryMessage] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (vadApplyTimerRef.current !== null) {
        window.clearTimeout(vadApplyTimerRef.current)
        vadApplyTimerRef.current = null
      }

      if (audioRef.current) {
        void audioRef.current.stop()
        audioRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!settings || !session.active || settings.vadApplyMode !== 'live') {
      return
    }

    if (vadApplyTimerRef.current !== null) {
      window.clearTimeout(vadApplyTimerRef.current)
    }

    vadApplyTimerRef.current = window.setTimeout(() => {
      void window.api
        .updateSessionVad({
          vad: settings.vad,
          applyMode: 'live'
        })
        .then((result) => {
          if (!result.applied && session.active) {
            setError('Live VAD update could not be applied to the active session.')
          }
        })
        .catch((applyError) => {
          setError(
            applyError instanceof Error ? applyError.message : 'Failed to apply VAD settings.'
          )
        })
    }, 300)

    return () => {
      if (vadApplyTimerRef.current !== null) {
        window.clearTimeout(vadApplyTimerRef.current)
        vadApplyTimerRef.current = null
      }
    }
  }, [settings?.vad, settings?.vadApplyMode, session.active, setError])

  useEffect(() => {
    if (!session.active) {
      setCaptureDiagnostics(null)
    }
  }, [session.active, setCaptureDiagnostics])

  useEffect(() => {
    if (wasSessionActiveRef.current && !session.active) {
      void refreshHistory()
    }
    wasSessionActiveRef.current = session.active
  }, [session.active])

  const latestAssist = useMemo(() => assistUpdates.slice(-80).reverse(), [assistUpdates])
  const latestTranscripts = useMemo(() => transcripts.slice(-200).reverse(), [transcripts])
  const sessionBusy = session.phase === 'starting' || session.phase === 'stopping'
  const normalizedQuery = streamQuery.trim().toLowerCase()

  const filteredTranscripts = useMemo(() => {
    return latestTranscripts.filter((item) => {
      if (speakerFilter !== 'all' && item.speaker !== speakerFilter) {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      return item.textEn.toLowerCase().includes(normalizedQuery)
    })
  }, [latestTranscripts, speakerFilter, normalizedQuery])

  const filteredAssist = useMemo(() => {
    return latestAssist.filter((item) => {
      if (assistFilter !== 'all' && item.state !== assistFilter) {
        return false
      }

      if (!normalizedQuery) {
        return true
      }

      const combined = [
        item.translationTr || '',
        item.replyEn || '',
        item.replyTr || '',
        item.rawText || '',
        item.error || ''
      ]
        .join(' ')
        .toLowerCase()

      return combined.includes(normalizedQuery)
    })
  }, [latestAssist, assistFilter, normalizedQuery])

  const sourceLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const source of audioSources) {
      map.set(source.id, source.name)
    }
    return map
  }, [audioSources])

  const effectiveRemoteRms = captureDiagnostics?.remoteRms ?? workerDiagnostics?.remoteRms ?? 0
  const effectiveSelfRms = captureDiagnostics?.selfRms ?? workerDiagnostics?.selfRms ?? 0
  const effectiveDroppedRemote =
    workerDiagnostics?.droppedRemote ?? captureDiagnostics?.droppedRemote ?? 0
  const effectiveDroppedSelf =
    workerDiagnostics?.droppedSelf ?? captureDiagnostics?.droppedSelf ?? 0

  const formatMetric = (value: number | null): string => {
    if (value === null || Number.isNaN(value)) return 'n/a'
    return `${Math.round(value)} ms`
  }

  const formatDateTime = (ms: number): string => {
    return new Date(ms).toLocaleString()
  }

  const formatDuration = (startMs: number, endMs: number): string => {
    const seconds = Math.max(0, Math.round((endMs - startMs) / 1000))
    return `${seconds}s`
  }

  const refreshHistory = async (): Promise<void> => {
    try {
      setHistoryBusy(true)
      const result = await window.api.listHistorySessions()
      setHistoryList(result)
    } catch (historyError) {
      setError(
        historyError instanceof Error ? historyError.message : 'Failed to load history sessions.'
      )
    } finally {
      setHistoryBusy(false)
    }
  }

  const exportSessionHistory = async (
    format: HistoryExportFormat,
    sessionId?: string
  ): Promise<void> => {
    try {
      setExportBusy(format)
      const result = await window.api.exportSessionHistory({
        format,
        sessionId
      })
      setHistoryMessage(`Export ready: ${result.path}`)
      await refreshHistory()
    } catch (exportError) {
      setHistoryMessage(null)
      setError(
        exportError instanceof Error ? exportError.message : 'Failed to export session history.'
      )
    } finally {
      setExportBusy(null)
    }
  }

  const refreshSources = async (): Promise<void> => {
    try {
      const sources = await window.api.getAudioSources()
      setAudioSources(sources)
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : 'Failed to list audio sources')
    }
  }

  const stopSessionInternal = async (errorMessage?: string): Promise<void> => {
    try {
      if (audioRef.current) {
        await audioRef.current.stop()
        audioRef.current = null
      }
      await window.api.stopSession()
      setCaptureDiagnostics(null)
    } finally {
      if (errorMessage) {
        setError(errorMessage)
      }
    }
  }

  const startSession = async (): Promise<void> => {
    if (!settings || sessionBusy || session.active) return

    try {
      setError(null)

      if (!selectedSystemSourceId) {
        throw new Error('Select a system audio source before starting the session.')
      }

      await window.api.startSession({
        mode: 'meeting',
        sttModel: settings.sttModel,
        vad: settings.vad
      })

      const selectedSource = audioSources.find((item) => item.id === selectedSystemSourceId)

      const capture = new MeetingAudioCapture()
      await capture.start({
        systemSourceId: selectedSystemSourceId,
        systemSourceName: selectedSource?.name,
        onChunk: (chunk) => {
          window.api.sendAudioChunk(chunk)
        },
        onDiagnostics: (diagnostics) => {
          useAppStore.getState().setCaptureDiagnostics(diagnostics)
        },
        onSourceChanged: (source) => {
          setSelectedSystemSourceId(source.id)
          setError(`System audio source switched to: ${source.name}`)
        },
        onFatalError: (fatalError) => {
          void stopSessionInternal(fatalError.message)
        }
      })

      audioRef.current = capture
    } catch (startError) {
      await stopSessionInternal(
        startError instanceof Error ? startError.message : 'Failed to start session.'
      )
    }
  }

  const stopSession = async (): Promise<void> => {
    if (sessionBusy) return

    try {
      await stopSessionInternal()
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
    try {
      patchSettings({ overlayOpacity: value })
      await window.api.setOverlay({ opacity: value })
    } catch (overlayError) {
      setError(
        overlayError instanceof Error ? overlayError.message : 'Failed to update overlay opacity.'
      )
    }
  }

  const setOverlayVisibility = async (visible: boolean): Promise<void> => {
    try {
      patchSettings({ overlayVisible: visible })
      await window.api.setOverlay({ visible })
    } catch (overlayError) {
      setError(
        overlayError instanceof Error
          ? overlayError.message
          : 'Failed to toggle overlay visibility.'
      )
    }
  }

  const setOverlayClickThrough = async (clickThrough: boolean): Promise<void> => {
    try {
      patchSettings({ overlayClickThrough: clickThrough })
      await window.api.setOverlay({ clickThrough })
    } catch (overlayError) {
      setError(
        overlayError instanceof Error
          ? overlayError.message
          : 'Failed to toggle overlay click-through.'
      )
    }
  }

  const updateVadField = (speaker: 'remote' | 'self', field: VadField, value: string): void => {
    if (!settings) return

    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      return
    }

    const nextVad = {
      ...settings.vad,
      [speaker]: {
        ...settings.vad[speaker],
        [field]: numeric
      }
    }

    patchSettings({ vad: nextVad })
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
            session: {session.phase} | active: {session.active ? 'yes' : 'no'} | muted:{' '}
            {session.muted ? 'yes' : 'no'} | worker: {session.workerReady ? 'ready' : 'not-ready'}
          </div>
          {session.reason && <div className="subtitle">reason: {session.reason}</div>}
          {session.lastError && <div className="subtitle">last error: {session.lastError}</div>}
        </div>

        <div className="row">
          {session.active ? (
            <button className="danger" onClick={stopSession} disabled={sessionBusy}>
              Stop Session
            </button>
          ) : (
            <button className="primary" onClick={startSession} disabled={sessionBusy}>
              Start Session
            </button>
          )}

          <button onClick={refreshSources} disabled={sessionBusy}>
            Refresh Sources
          </button>
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
              disabled={sessionBusy}
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

          <h3>VAD Tuning</h3>

          <div className="row">
            <label style={{ width: 120 }}>Apply Mode</label>
            <select
              value={settings.vadApplyMode}
              onChange={(e) =>
                patchSettings({ vadApplyMode: e.target.value === 'restart' ? 'restart' : 'live' })
              }
            >
              <option value="live">Live apply</option>
              <option value="restart">Apply on restart</option>
            </select>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Remote minAudio</label>
            <input
              type="number"
              min={120}
              max={3000}
              value={settings.vad.remote.minAudioMs}
              onChange={(e) => updateVadField('remote', 'minAudioMs', e.target.value)}
            />
            <label>silence</label>
            <input
              type="number"
              min={80}
              max={2500}
              value={settings.vad.remote.silenceMs}
              onChange={(e) => updateVadField('remote', 'silenceMs', e.target.value)}
            />
            <label>rms</label>
            <input
              type="number"
              min={50}
              max={3000}
              value={settings.vad.remote.voiceRmsThreshold}
              onChange={(e) => updateVadField('remote', 'voiceRmsThreshold', e.target.value)}
            />
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Self minAudio</label>
            <input
              type="number"
              min={120}
              max={3000}
              value={settings.vad.self.minAudioMs}
              onChange={(e) => updateVadField('self', 'minAudioMs', e.target.value)}
            />
            <label>silence</label>
            <input
              type="number"
              min={80}
              max={2500}
              value={settings.vad.self.silenceMs}
              onChange={(e) => updateVadField('self', 'silenceMs', e.target.value)}
            />
            <label>rms</label>
            <input
              type="number"
              min={50}
              max={3000}
              value={settings.vad.self.voiceRmsThreshold}
              onChange={(e) => updateVadField('self', 'voiceRmsThreshold', e.target.value)}
            />
          </div>

          {session.active && settings.vadApplyMode === 'restart' && (
            <div className="subtitle">VAD changes will apply on the next session start.</div>
          )}

          <h3>Source Diagnostics</h3>

          <div className="row">
            <label style={{ width: 120 }}>Active Source</label>
            <div className="subtitle" style={{ flex: 1 }}>
              {captureDiagnostics?.activeSourceName ||
                sourceLabelById.get(selectedSystemSourceId) ||
                'N/A'}
            </div>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Remote RMS</label>
            <meter min={0} max={2000} value={effectiveRemoteRms} style={{ flex: 1 }} />
            <span>{Math.round(effectiveRemoteRms)}</span>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Self RMS</label>
            <meter min={0} max={2000} value={effectiveSelfRms} style={{ flex: 1 }} />
            <span>{Math.round(effectiveSelfRms)}</span>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Dropped</label>
            <div className="subtitle" style={{ flex: 1 }}>
              remote: {effectiveDroppedRemote} | self: {effectiveDroppedSelf}
            </div>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Reconnect</label>
            <div className="subtitle" style={{ flex: 1 }}>
              {captureDiagnostics?.reconnectState || 'stable'}
              {captureDiagnostics?.reconnectAttempt
                ? ` (attempt ${captureDiagnostics.reconnectAttempt})`
                : ''}
            </div>
          </div>

          <h3>Latency Dashboard</h3>

          <div className="row">
            <label style={{ width: 120 }}>STT First</label>
            <div className="subtitle" style={{ flex: 1 }}>
              latest {formatMetric(latencyMetrics?.sttFirstChunkMs.latest ?? null)} | p50{' '}
              {formatMetric(latencyMetrics?.sttFirstChunkMs.p50 ?? null)} | p95{' '}
              {formatMetric(latencyMetrics?.sttFirstChunkMs.p95 ?? null)}
            </div>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Assist 1st</label>
            <div className="subtitle" style={{ flex: 1 }}>
              latest {formatMetric(latencyMetrics?.assistFirstTokenMs.latest ?? null)} | p50{' '}
              {formatMetric(latencyMetrics?.assistFirstTokenMs.p50 ?? null)} | p95{' '}
              {formatMetric(latencyMetrics?.assistFirstTokenMs.p95 ?? null)}
            </div>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Assist Final</label>
            <div className="subtitle" style={{ flex: 1 }}>
              latest {formatMetric(latencyMetrics?.assistFinalMs.latest ?? null)} | p50{' '}
              {formatMetric(latencyMetrics?.assistFinalMs.p50 ?? null)} | p95{' '}
              {formatMetric(latencyMetrics?.assistFinalMs.p95 ?? null)}
            </div>
          </div>

          <div className="row">
            <label style={{ width: 120 }}>Worker Err</label>
            <div className="subtitle" style={{ flex: 1 }}>
              {latencyMetrics ? `${Math.round(latencyMetrics.workerErrorRate * 100)}%` : 'n/a'}
            </div>
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
            <label style={{ width: 120 }}>
              <input
                type="checkbox"
                checked={settings.historyOptIn}
                onChange={(e) => patchSettings({ historyOptIn: e.target.checked })}
              />{' '}
              History Opt-In
            </label>
            <div className="subtitle" style={{ flex: 1 }}>
              {historyEncryptionAvailable
                ? 'Encrypted local history is available on this device.'
                : 'Encrypted history unavailable (OS secure storage is not ready).'}
            </div>
          </div>

          <div className="row">
            <button onClick={persistSettings} disabled={savingSettings}>
              {savingSettings ? 'Saving...' : 'Save Settings'}
            </button>
          </div>

          <h3>History & Export</h3>

          <div className="row">
            <button onClick={refreshHistory} disabled={historyBusy}>
              {historyBusy ? 'Refreshing...' : 'Refresh History'}
            </button>
            <button onClick={() => exportSessionHistory('json')} disabled={exportBusy !== null}>
              {exportBusy === 'json' ? 'Exporting JSON...' : 'Export Current JSON'}
            </button>
            <button onClick={() => exportSessionHistory('markdown')} disabled={exportBusy !== null}>
              {exportBusy === 'markdown' ? 'Exporting MD...' : 'Export Current Markdown'}
            </button>
          </div>

          {historyMessage && <div className="subtitle">{historyMessage}</div>}

          <div className="list" style={{ maxHeight: 170 }}>
            {historySessions.length === 0 && (
              <div className="subtitle">No persisted sessions found.</div>
            )}
            {historySessions.slice(0, 12).map((item) => (
              <div className="item" key={item.id}>
                <div className="subtitle">
                  {formatDateTime(item.startedAtMs)} | duration:{' '}
                  {formatDuration(item.startedAtMs, item.endedAtMs)} | transcripts:{' '}
                  {item.transcriptCount} | assists: {item.assistCount}
                </div>
                <div className="row" style={{ marginTop: 8 }}>
                  <button
                    onClick={() => exportSessionHistory('json', item.id)}
                    disabled={exportBusy !== null}
                  >
                    JSON
                  </button>
                  <button
                    onClick={() => exportSessionHistory('markdown', item.id)}
                    disabled={exportBusy !== null}
                  >
                    Markdown
                  </button>
                </div>
              </div>
            ))}
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
          <h3>Search & Filters</h3>
          <div className="row">
            <input
              style={{ flex: 1 }}
              placeholder="Search transcript / assist text"
              value={streamQuery}
              onChange={(e) => setStreamQuery(e.target.value)}
            />
          </div>
          <div className="row">
            <label style={{ width: 120 }}>Speaker</label>
            <select
              value={speakerFilter}
              onChange={(e) => setSpeakerFilter(e.target.value as 'all' | 'remote' | 'self')}
            >
              <option value="all">All</option>
              <option value="remote">Remote</option>
              <option value="self">Self</option>
            </select>
            <label style={{ width: 120 }}>Assist State</label>
            <select
              value={assistFilter}
              onChange={(e) =>
                setAssistFilter(e.target.value as 'all' | 'partial' | 'final' | 'error')
              }
            >
              <option value="all">All</option>
              <option value="partial">Partial</option>
              <option value="final">Final</option>
              <option value="error">Error</option>
            </select>
          </div>

          <h3>Transcript Stream</h3>
          <div className="subtitle">
            Showing {filteredTranscripts.length} / {latestTranscripts.length}
          </div>
          <div className="list" style={{ maxHeight: 240 }}>
            {filteredTranscripts.map((item) => (
              <div className="item" key={item.id}>
                <div className={`badge ${item.speaker}`}>{item.speaker}</div>
                <div style={{ marginTop: 6 }}>{item.textEn}</div>
              </div>
            ))}
          </div>

          <h3>Assist Output</h3>
          <div className="subtitle">
            Showing {filteredAssist.length} / {latestAssist.length}
          </div>
          <div className="list">
            {filteredAssist.map((item) => (
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
                    <div className="subtitle">
                      confidence: {Math.round((item.confidence || 0) * 100)}%
                    </div>
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
