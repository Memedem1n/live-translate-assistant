import { useEffect, useMemo, useRef, useState } from 'react'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'

export function ControlView(): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    error,
    setError,
    patchSettings,
    setSettings,
    setAudioSources,
    setSelectedSystemSourceId,
    setCaptureDiagnostics
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [refreshingSources, setRefreshingSources] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        void audioRef.current.stop()
        audioRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!session.active) {
      setCaptureDiagnostics(null)
    }
  }, [session.active, setCaptureDiagnostics])

  const sessionBusy = session.phase === 'starting' || session.phase === 'stopping'

  const sourceLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const source of audioSources) {
      map.set(source.id, source.name)
    }
    return map
  }, [audioSources])

  const activeSourceLabel = useMemo(() => {
    if (!settings) return 'Hazirlaniyor...'

    if (settings.systemAudioMode === 'auto') {
      if (!selectedSystemSourceId) return 'Otomatik secim bekleniyor'
      return sourceLabelById.get(selectedSystemSourceId) || selectedSystemSourceId
    }

    const manualId = selectedSystemSourceId || settings.manualSystemSourceId
    if (!manualId) return 'Manuel kaynak secilmedi'
    return sourceLabelById.get(manualId) || manualId
  }, [settings, selectedSystemSourceId, sourceLabelById])

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

  const refreshSources = async (): Promise<void> => {
    try {
      setRefreshingSources(true)
      const sources = await window.api.getAudioSources()
      setAudioSources(sources)
      setError(null)
    } catch (sourceError) {
      setError(sourceError instanceof Error ? sourceError.message : 'Kaynak listesi alinamadi.')
    } finally {
      setRefreshingSources(false)
    }
  }

  const startSession = async (): Promise<void> => {
    if (!settings || sessionBusy || session.active) return

    try {
      setError(null)
      setInfoMessage(null)

      const manualSourceId =
        settings.systemAudioMode === 'manual'
          ? selectedSystemSourceId || settings.manualSystemSourceId
          : undefined

      if (settings.systemAudioMode === 'manual' && !manualSourceId) {
        throw new Error('Manuel mod icin bir sistem ses kaynagi secin.')
      }

      await window.api.startSession({
        mode: 'meeting',
        sttModel: settings.sttModel,
        vad: settings.vad
      })

      const capture = new MeetingAudioCapture()
      await capture.start({
        systemSourceId: manualSourceId,
        onChunk: (chunk) => {
          window.api.sendAudioChunk(chunk)
        },
        onDiagnostics: (diagnostics) => {
          useAppStore.getState().setCaptureDiagnostics(diagnostics)
        },
        onSourceChanged: (source) => {
          setSelectedSystemSourceId(source.id)
          patchSettings({ manualSystemSourceId: source.id })
          setInfoMessage(`Sistem sesi kaynagi: ${source.name}`)
        },
        onFatalError: (fatalError) => {
          void stopSessionInternal(fatalError.message)
        }
      })

      audioRef.current = capture

      if (settings.autoHideControlWindow) {
        await window.api.hideControlWindow()
      }
    } catch (startError) {
      await stopSessionInternal(
        startError instanceof Error ? startError.message : 'Oturum baslatilamadi.'
      )
    }
  }

  const stopSession = async (): Promise<void> => {
    if (sessionBusy) return

    try {
      await stopSessionInternal()
      setInfoMessage(null)
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : 'Oturum durdurulamadi.')
    }
  }

  const persistSettings = async (): Promise<void> => {
    if (!settings) return

    try {
      setSavingSettings(true)
      const saved = await window.api.updateSettings(settings)
      setSettings(saved)
      setError(null)
      setInfoMessage('Ayarlar kaydedildi.')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Ayarlar kaydedilemedi.')
    } finally {
      setSavingSettings(false)
    }
  }

  const hidePanel = async (): Promise<void> => {
    try {
      await window.api.hideControlWindow()
    } catch (hideError) {
      setError(hideError instanceof Error ? hideError.message : 'Panel gizlenemedi.')
    }
  }

  const toggleOverlayVisibility = async (): Promise<void> => {
    if (!settings) return

    try {
      const nextVisible = !settings.overlayVisible
      patchSettings({ overlayVisible: nextVisible })
      await window.api.setOverlay({ visible: nextVisible })
    } catch (overlayError) {
      setError(overlayError instanceof Error ? overlayError.message : 'Overlay guncellenemedi.')
    }
  }

  const setOverlayOpacity = async (value: number): Promise<void> => {
    try {
      patchSettings({ overlayOpacity: value })
      await window.api.setOverlay({ opacity: value })
    } catch (overlayError) {
      setError(overlayError instanceof Error ? overlayError.message : 'Overlay opakligi guncellenemedi.')
    }
  }

  const setOverlayClickThrough = async (clickThrough: boolean): Promise<void> => {
    try {
      patchSettings({ overlayClickThrough: clickThrough })
      await window.api.setOverlay({ clickThrough })
    } catch (overlayError) {
      setError(
        overlayError instanceof Error ? overlayError.message : 'Overlay tiklama modu guncellenemedi.'
      )
    }
  }

  if (!settings) {
    return (
      <div className="app-shell">
        <div className="glass card">Ayarlar yukleniyor...</div>
      </div>
    )
  }

  return (
    <div className="app-shell minimal-shell">
      <div className="glass header-card minimal-header">
        <div>
          <div className="title">LiveTranslate Control</div>
          <div className="subtitle">
            Durum: {session.phase} | Aktif: {session.active ? 'evet' : 'hayir'} | Worker:{' '}
            {session.workerReady ? 'hazir' : 'hazir degil'}
          </div>
          {session.lastError && <div className="subtitle">Son hata: {session.lastError}</div>}
        </div>

        <div className="row">
          {session.active ? (
            <button className="danger" onClick={stopSession} disabled={sessionBusy}>
              Durdur
            </button>
          ) : (
            <button className="primary" onClick={startSession} disabled={sessionBusy}>
              Baslat
            </button>
          )}

          <button onClick={toggleOverlayVisibility}>
            Overlay {settings.overlayVisible ? 'Gizle' : 'Goster'}
          </button>
          <button onClick={hidePanel}>Paneli Gizle</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {infoMessage && <div className="subtitle">{infoMessage}</div>}

      <div className="grid minimal-grid">
        <div className="glass card">
          <div className="explain-block">
            <div className="explain-title">Bu Alanlar Ne Ise Yarar?</div>
            <div className="subtitle">
              System Audio: Karsi tarafin hoparlore gelen sesini alir.
            </div>
            <div className="subtitle">
              STT Model: Sesi metne cevirir (Speech-to-Text).
            </div>
            <div className="subtitle">
              Answer Model: Ceviri ve cevap onerisi uretir.
            </div>
          </div>

          <h3>System Audio</h3>
          <div className="subtitle">
            Varsayilan davranis otomatiktir. Uygulama uygun ekran kaynagini kendi secer ve oturum
            sirasinda koparsa baska uygun kaynaga gecebilir.
          </div>
          <div className="subtitle">
            Manual moda sadece otomatik secim sizin senaryonuzda dogru kaynagi bulamazsa gecin.
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label style={{ width: 150 }}>Aktif Kaynak</label>
            <div className="subtitle" style={{ flex: 1 }}>
              {activeSourceLabel}
            </div>
          </div>

          <h3 style={{ marginTop: 12 }}>Model Ayarlari</h3>
          <div className="subtitle">
            STT Model gelen sesi yaziya cevirir. Kucuk modeller daha hizli, buyuk modeller genelde
            daha dogru ama daha agir calisir.
          </div>
          <div className="subtitle">Answer Model, metne gore ceviri ve yanit onerisi uretir.</div>

          <div className="row" style={{ marginTop: 8 }}>
            <label style={{ width: 150 }}>STT Model</label>
            <input
              style={{ flex: 1 }}
              value={settings.sttModel}
              onChange={(e) => patchSettings({ sttModel: e.target.value })}
            />
          </div>

          <div className="row">
            <label style={{ width: 150 }}>Answer Model</label>
            <input
              style={{ flex: 1 }}
              value={settings.answerModel}
              onChange={(e) => patchSettings({ answerModel: e.target.value })}
            />
          </div>
          <div className="subtitle">
            Pratik: Konusma kaciriyorsa STT modelini buyutun. Yanit kalitesi dusukse Answer modelini
            guclu bir modelle degistirin.
          </div>

          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={persistSettings} disabled={savingSettings}>
              {savingSettings ? 'Kaydediliyor...' : 'Ayarlari Kaydet'}
            </button>
          </div>

          <div className="subtitle">
            Panel gizlendikten sonra sistem tepsisinden tekrar acabilirsiniz.
          </div>
        </div>

        <details className="glass card advanced-card">
          <summary>Gelismis</summary>

          <div className="row" style={{ marginTop: 10 }}>
            <label style={{ width: 150 }}>System Audio Mode</label>
            <select
              value={settings.systemAudioMode}
              onChange={(e) =>
                patchSettings({
                  systemAudioMode: e.target.value === 'manual' ? 'manual' : 'auto'
                })
              }
              disabled={sessionBusy}
            >
              <option value="auto">Auto</option>
              <option value="manual">Manual Override</option>
            </select>
            <button onClick={refreshSources} disabled={refreshingSources || sessionBusy}>
              {refreshingSources ? 'Yenileniyor...' : 'Kaynaklari Yenile'}
            </button>
          </div>

          {settings.systemAudioMode === 'manual' && (
            <div className="row">
              <label style={{ width: 150 }}>Manual Source</label>
              <select
                value={selectedSystemSourceId || settings.manualSystemSourceId}
                onChange={(e) => {
                  setSelectedSystemSourceId(e.target.value)
                  patchSettings({ manualSystemSourceId: e.target.value })
                }}
                style={{ flex: 1 }}
                disabled={sessionBusy}
              >
                {audioSources.length === 0 && <option value="">Kaynak bulunamadi</option>}
                {audioSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="row">
            <label style={{ width: 150 }}>
              <input
                type="checkbox"
                checked={settings.autoHideControlWindow}
                onChange={(e) => patchSettings({ autoHideControlWindow: e.target.checked })}
              />{' '}
              Baslatinca paneli gizle
            </label>
          </div>

          <div className="row">
            <label style={{ width: 150 }}>
              <input
                type="checkbox"
                checked={settings.overlayClickThrough}
                onChange={(e) => setOverlayClickThrough(e.target.checked)}
              />{' '}
              Overlay click-through
            </label>
          </div>

          <div className="row">
            <label style={{ width: 150 }}>Overlay Opacity</label>
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
            <label style={{ width: 150 }}>Ollama URL</label>
            <input
              style={{ flex: 1 }}
              value={settings.ollamaBaseUrl}
              onChange={(e) => patchSettings({ ollamaBaseUrl: e.target.value })}
            />
          </div>
        </details>
      </div>
    </div>
  )
}
