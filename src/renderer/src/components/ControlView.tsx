import { useEffect, useMemo, useRef, useState } from 'react'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'
import {
  AssistCompositionPolicy,
  AssistEvent,
  AssistLanguagePolicy,
  AssistPersonalizationPolicy,
  ProfileSourceType,
  SystemAudioStrategy
} from '../../../shared/contracts'

function assistPrimaryText(item: AssistEvent): string {
  const sourceLanguage = String(item.sourceLanguage || '').toLowerCase()
  if (sourceLanguage === 'tr') {
    return item.replyTr || item.replyEn || item.rawText || '-'
  }
  return item.replyEn || item.replyTr || item.rawText || '-'
}

function assistSecondaryText(item: AssistEvent): string {
  const sourceLanguage = String(item.sourceLanguage || '').toLowerCase()
  if (sourceLanguage === 'tr') {
    return item.replyEn || item.translationTr || '-'
  }
  return item.replyTr || item.translationTr || '-'
}

function profileSyncMark(state: string | undefined): string {
  if (state === 'done') return 'OK'
  if (state === 'error') return '!'
  if (state === 'running') return '...'
  return '-'
}

export function ControlView(): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    transcripts,
    assistUpdates,
    sttRuntimeStatus,
    captureDiagnostics,
    profileSnapshot,
    profileSyncStatus,
    interviewContextPreview,
    error,
    setError,
    patchSettings,
    setSettings,
    setAudioSources,
    setSelectedSystemSourceId,
    setCaptureDiagnostics,
    setProfileSnapshot,
    setInterviewContextPreview
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [refreshingSources, setRefreshingSources] = useState(false)
  const [redetectingSource, setRedetectingSource] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [githubUsername, setGithubUsername] = useState('')
  const [jobDescInput, setJobDescInput] = useState('')
  const [cvInput, setCvInput] = useState('')
  const [linkedinInput, setLinkedinInput] = useState('')
  const [noteInput, setNoteInput] = useState('')
  const [knowledgeBaseInput, setKnowledgeBaseInput] = useState('')
  const [previewQuery, setPreviewQuery] = useState('')
  const [syncingGithub, setSyncingGithub] = useState(false)
  const [syncingWebCorpus, setSyncingWebCorpus] = useState(false)
  const [ingestingGlossary, setIngestingGlossary] = useState(false)
  const [importingProfile, setImportingProfile] = useState(false)
  const [importingProfileFile, setImportingProfileFile] = useState(false)
  const [reindexingProfile, setReindexingProfile] = useState(false)
  const [fileImportType, setFileImportType] = useState<ProfileSourceType>('cv')
  const [fileImportName, setFileImportName] = useState('')
  const [manualPrompt, setManualPrompt] = useState('')
  const [manualPromptLanguage, setManualPromptLanguage] = useState<'auto' | 'tr' | 'en'>('auto')
  const [manualRunning, setManualRunning] = useState(false)

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

  const runtimeSummary = useMemo(() => {
    if (!sttRuntimeStatus) {
      return 'Runtime hazirlaniyor...'
    }

    const device = sttRuntimeStatus.activeDevice || 'unknown'
    const compute = sttRuntimeStatus.computeType || 'n/a'
    const warmup = sttRuntimeStatus.warmupMs === null ? 'n/a' : `${Math.round(sttRuntimeStatus.warmupMs)} ms`
    return `${sttRuntimeStatus.phase} | ${device}/${compute} | warmup: ${warmup}`
  }, [sttRuntimeStatus])

  const runtimeWarning = useMemo(() => {
    if (!session.active && session.phase !== 'starting') return null
    if (!settings || !sttRuntimeStatus) return null

    if (
      sttRuntimeStatus.activeDevice === 'cpu' &&
      settings.sttRuntimeMode !== 'cpu' &&
      sttRuntimeStatus.fallbackToCpuCount > 0
    ) {
      return 'CUDA hatasi nedeniyle STT CPU fallback modunda calisiyor.'
    }

    if (sttRuntimeStatus.phase === 'degraded' && sttRuntimeStatus.lastError) {
      return sttRuntimeStatus.lastError
    }

    return null
  }, [session.active, session.phase, settings, sttRuntimeStatus])

  const captureWarning = useMemo(() => {
    if (!session.active && session.phase !== 'starting') return null
    if (!captureDiagnostics?.lastErrorMessage) return null
    if (captureDiagnostics.lastErrorCode === 'microphone_unavailable') return null
    const code = captureDiagnostics.lastErrorCode ? `[${captureDiagnostics.lastErrorCode}] ` : ''
    return `${code}${captureDiagnostics.lastErrorMessage}`
  }, [captureDiagnostics, session.active, session.phase])

  const captureInfo = useMemo(() => {
    if (!session.active && session.phase !== 'starting') return null
    if (!captureDiagnostics?.lastErrorMessage) return null
    if (captureDiagnostics.lastErrorCode !== 'microphone_unavailable') return null
    return captureDiagnostics.lastErrorMessage
  }, [captureDiagnostics, session.active, session.phase])

  const sessionDegradedHint = useMemo(() => {
    if (!session.active && session.phase !== 'starting' && session.phase !== 'degraded') return null
    if (!session.degradedCode) return null
    if (session.degradedCode === 'cuda_fallback') {
      return 'Oturum CPU fallback modunda calisiyor (CUDA kullanilamadi).'
    }
    if (session.degradedCode === 'assist_quality_retry') {
      return 'Asistan kaliteyi korumak icin ek duzeltme denemesi yapiyor.'
    }
    if (session.degradedCode === 'audio_source_fallback') {
      return 'Sistem ses kaynagi fallback ile degistirildi.'
    }
    return null
  }, [session.active, session.phase, session.degradedCode])

  const assistByTranscript = useMemo(() => {
    const map = new Map<string, (typeof assistUpdates)[number]>()
    for (const item of assistUpdates) {
      if (item.state === 'error') continue
      const prev = map.get(item.transcriptId)
      if (!prev) {
        map.set(item.transcriptId, item)
        continue
      }
      if (prev.state === 'partial' && item.state === 'final') {
        map.set(item.transcriptId, item)
        continue
      }
      if (item.state === prev.state) {
        map.set(item.transcriptId, item)
      }
    }
    return map
  }, [assistUpdates])

  const transcriptFeed = useMemo(() => transcripts.slice(-240).reverse(), [transcripts])
  const assistFeed = useMemo(
    () => assistUpdates.filter((item) => item.state !== 'partial').slice(-240).reverse(),
    [assistUpdates]
  )

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
      const strategy: SystemAudioStrategy =
        settings.systemAudioMode === 'manual'
          ? 'manual'
          : settings.systemAudioStrategy === 'picker_each_start'
            ? 'picker_each_start'
            : 'auto_live'

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
        sttRuntimeMode: settings.sttRuntimeMode,
        sttLanguageMode: settings.sttLanguageMode,
        manualSttLanguage: settings.manualSttLanguage,
        vad: settings.vad
      })

      const capture = new MeetingAudioCapture()
      await capture.start({
        systemSourceId: manualSourceId,
        strategy,
        captureMicrophone: settings.captureMicrophone,
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

  const redetectSystemSource = async (): Promise<void> => {
    if (!session.active || sessionBusy || !audioRef.current) return

    try {
      setRedetectingSource(true)
      setError(null)
      const switched = await audioRef.current.redetectAudioSource()
      if (switched) {
        setInfoMessage('Sistem ses kaynagi yeniden algilandi ve guncellendi.')
      } else {
        setInfoMessage('Daha iyi bir kaynak bulunamadi, mevcut kaynak korunuyor.')
      }
    } catch (redetectError) {
      setError(
        redetectError instanceof Error
          ? redetectError.message
          : 'Sistem ses kaynagi yeniden algilanamadi.'
      )
    } finally {
      setRedetectingSource(false)
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

  const toggleAssistantMute = async (): Promise<void> => {
    try {
      const result = await window.api.toggleAssistantMute()
      setInfoMessage(result.muted ? 'Asistan sessize alindi.' : 'Asistan tekrar aktif.')
    } catch (muteError) {
      setError(muteError instanceof Error ? muteError.message : 'Asistan sessiz modu degistirilemedi.')
    }
  }

  const refreshProfileSnapshot = async (): Promise<void> => {
    const snapshot = await window.api.getProfileSnapshot()
    setProfileSnapshot(snapshot)
  }

  const refreshContextPreview = async (query = previewQuery): Promise<void> => {
    const preview = await window.api.getInterviewContextPreview(query || '')
    setInterviewContextPreview(preview)
  }

  const importProfileText = async (type: ProfileSourceType, content: string, name: string): Promise<void> => {
    if (!content.trim()) {
      setError('Icerik bos olamaz.')
      return
    }

    try {
      setImportingProfile(true)
      setError(null)
      await window.api.importProfileSource({
        type,
        name,
        content
      })
      await refreshProfileSnapshot()
      await refreshContextPreview()
      setInfoMessage(`${name} kaynagi eklendi.`)
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Kaynak eklenemedi.')
    } finally {
      setImportingProfile(false)
    }
  }

  const importProfileFile = async (): Promise<void> => {
    try {
      setImportingProfileFile(true)
      setError(null)
      const result = await window.api.importProfileFile({
        type: fileImportType,
        name: fileImportName.trim() || undefined,
        ocrMode: 'auto'
      })

      if (result.cancelled) {
        setInfoMessage('Dosya secimi iptal edildi.')
        return
      }

      if (!result.success) {
        setError('Dosya import basarisiz.')
        return
      }

      await refreshProfileSnapshot()
      await refreshContextPreview()
      const parserLabel = result.parser || 'text'
      const ocrLabel = result.ocrUsed ? 'OCR acik' : 'OCR gerekmiyor'
      const warningText =
        result.warnings && result.warnings.length > 0 ? ` | ${result.warnings.join(' | ')}` : ''
      setInfoMessage(`Dosya eklendi (${parserLabel}, ${ocrLabel}).${warningText}`)
      if (fileImportName.trim()) {
        setFileImportName('')
      }
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Dosya import basarisiz.')
    } finally {
      setImportingProfileFile(false)
    }
  }

  const runManualAssist = async (): Promise<void> => {
    const text = manualPrompt.trim()
    if (!text) {
      setError('Manuel test sorusu bos olamaz.')
      return
    }

    try {
      setManualRunning(true)
      setError(null)
      await window.api.generateManualAssist({
        text,
        language: manualPromptLanguage === 'auto' ? undefined : manualPromptLanguage,
        speaker: 'remote'
      })
      setInfoMessage('Manuel test sorusu islendi, assist cevabi akis ekranina eklendi.')
    } catch (manualError) {
      setError(manualError instanceof Error ? manualError.message : 'Manuel assist testi basarisiz.')
    } finally {
      setManualRunning(false)
    }
  }

  const syncGithub = async (): Promise<void> => {
    if (!githubUsername.trim()) {
      setError('GitHub kullanici adi girin.')
      return
    }

    try {
      setSyncingGithub(true)
      setError(null)
      await window.api.syncGithubProfile({ username: githubUsername.trim() })
      await refreshProfileSnapshot()
      await refreshContextPreview()
      setInfoMessage('GitHub senkron tamamlandi.')
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'GitHub senkronu basarisiz.')
    } finally {
      setSyncingGithub(false)
    }
  }

  const syncWebCorpus = async (): Promise<void> => {
    try {
      setSyncingWebCorpus(true)
      setError(null)
      const result = await window.api.syncWebCorpus({
        includeSearch: true,
        importLimit: 140,
        maxDocs: 220,
        maxPerCategory: 40,
        buildGlossary: true
      })
      await refreshProfileSnapshot()
      await refreshContextPreview()
      const glossaryNote =
        result.glossaryTerms && result.glossaryTerms > 0
          ? ` | glossary: ${result.glossaryTerms}`
          : ''
      setInfoMessage(
        `Web corpus senkron tamamlandi | docs: ${result.documentCount} | import: ${result.importedSources}${glossaryNote}`
      )
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Web corpus senkronu basarisiz.')
    } finally {
      setSyncingWebCorpus(false)
    }
  }

  const ingestGlossary = async (): Promise<void> => {
    try {
      setIngestingGlossary(true)
      setError(null)
      const result = await window.api.ingestGlossary({
        maxTerms: 600
      })
      await refreshProfileSnapshot()
      await refreshContextPreview()
      setInfoMessage(`Glossary import tamamlandi | terms: ${result.importedTerms}`)
    } catch (ingestError) {
      setError(ingestError instanceof Error ? ingestError.message : 'Glossary import basarisiz.')
    } finally {
      setIngestingGlossary(false)
    }
  }

  const reindexProfile = async (): Promise<void> => {
    try {
      setReindexingProfile(true)
      setError(null)
      await window.api.reindexProfileMemory()
      await refreshProfileSnapshot()
      await refreshContextPreview()
      setInfoMessage('Profil bellek reindex tamamlandi.')
    } catch (reindexError) {
      setError(reindexError instanceof Error ? reindexError.message : 'Reindex basarisiz.')
    } finally {
      setReindexingProfile(false)
    }
  }

  const removeProfileSource = async (sourceId: string): Promise<void> => {
    try {
      setError(null)
      await window.api.clearProfileSource({ sourceId })
      await refreshProfileSnapshot()
      await refreshContextPreview()
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : 'Kaynak silinemedi.')
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
        <div className="header-meta">
          <div className="title">LiveTranslate Control</div>
          <div className="subtitle">
            Durum: {session.phase} | Aktif: {session.active ? 'evet' : 'hayir'} | Worker:{' '}
            {session.workerReady ? 'hazir' : 'hazir degil'} | Asistan:{' '}
            {session.muted ? 'sessizde' : 'aktif'}
          </div>
          {session.lastError && <div className="subtitle">Son hata: {session.lastError}</div>}
        </div>

        <div className="row header-actions">
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
          <button onClick={toggleAssistantMute}>
            {session.muted ? 'Asistani Ac' : 'Asistani Sessize Al'}
          </button>
          <button onClick={hidePanel}>Paneli Gizle</button>
        </div>
      </div>

      <div className="status-stack">
        {error && <div className="error">{error}</div>}
        {session.muted && (
          <div className="error">Asistan sessizde. TR ceviri/yanit uretilmesi icin Asistani Ac yapin.</div>
        )}
        {runtimeWarning && <div className="error">{runtimeWarning}</div>}
        {sessionDegradedHint && <div className="subtitle status-note">{sessionDegradedHint}</div>}
        {captureWarning && <div className="error">{captureWarning}</div>}
        {captureInfo && <div className="subtitle status-note">{captureInfo}</div>}
        {!settings.captureMicrophone && (
          <div className="subtitle status-note">
            Mikrofon yakalama kapali (remote-only). Hoparlor sizintisinin self olarak algilanmasi
            engellenir.
          </div>
        )}
        {infoMessage && <div className="subtitle status-note">{infoMessage}</div>}
      </div>

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
          <div className="row form-row" style={{ marginTop: 8 }}>
            <label className="control-label">Aktif Kaynak</label>
            <div className="subtitle value-text">
              {activeSourceLabel}
            </div>
          </div>

          <h3 style={{ marginTop: 12 }}>Model Ayarlari</h3>
          <div className="subtitle">
            STT Model gelen sesi yaziya cevirir. Kucuk modeller daha hizli, buyuk modeller genelde
            daha dogru ama daha agir calisir.
          </div>
          <div className="subtitle">Answer Model, metne gore ceviri ve yanit onerisi uretir.</div>

          <div className="row form-row" style={{ marginTop: 8 }}>
            <label className="control-label">STT Model</label>
            <input value={settings.sttModel} onChange={(e) => patchSettings({ sttModel: e.target.value })} />
          </div>

          <div className="row form-row">
            <label className="control-label">Answer Model</label>
            <input
              value={settings.answerModel}
              onChange={(e) => patchSettings({ answerModel: e.target.value })}
            />
          </div>
          <div className="row form-row">
            <label className="control-label">Assistant Mode</label>
            <select
              value={settings.assistantMode}
              onChange={(e) =>
                patchSettings({
                  assistantMode: e.target.value === 'interview' ? 'interview' : 'meeting'
                })
              }
              disabled={sessionBusy}
            >
              <option value="meeting">Meeting</option>
              <option value="interview">Interview</option>
            </select>
          </div>
          <div className="row inline-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.personalizationEnabled}
                onChange={(e) => patchSettings({ personalizationEnabled: e.target.checked })}
              />{' '}
              Kisisellestirme acik
            </label>
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.githubSyncEnabled}
                onChange={(e) => patchSettings({ githubSyncEnabled: e.target.checked })}
              />{' '}
              GitHub senkron acik
            </label>
          </div>
          <div className="row form-row">
            <label className="control-label">Kisisellestirme Politikasi</label>
            <select
              value={settings.assistPersonalizationPolicy}
              onChange={(e) =>
                patchSettings({
                  assistPersonalizationPolicy:
                    (e.target.value === 'always' ? 'always' : 'intent_aware') as AssistPersonalizationPolicy
                })
              }
              disabled={sessionBusy}
            >
              <option value="intent_aware">Intent Aware (onerilen)</option>
              <option value="always">Her zaman profil kullan</option>
            </select>
          </div>
          <div className="row form-row">
            <label className="control-label">Cevap Kompozisyonu</label>
            <select
              value={settings.assistCompositionPolicy}
              onChange={(e) =>
                patchSettings({
                  assistCompositionPolicy:
                    (e.target.value === 'general_then_profile'
                      ? 'general_then_profile'
                      : e.target.value === 'profile_only'
                        ? 'profile_only'
                        : 'auto') as AssistCompositionPolicy
                })
              }
              disabled={sessionBusy}
            >
              <option value="auto">Auto</option>
              <option value="general_then_profile">Genel sonra profil</option>
              <option value="profile_only">Sadece profil</option>
            </select>
          </div>
          <div className="row form-row">
            <label className="control-label">Yanit Dil Politikasi</label>
            <select
              value={settings.assistLanguagePolicy}
              onChange={(e) =>
                patchSettings({
                  assistLanguagePolicy:
                    (e.target.value === 'tr'
                      ? 'tr'
                      : e.target.value === 'bilingual'
                        ? 'bilingual'
                        : 'auto') as AssistLanguagePolicy
                })
              }
              disabled={sessionBusy}
            >
              <option value="auto">Auto</option>
              <option value="tr">TR agirlikli</option>
              <option value="bilingual">TR + EN</option>
            </select>
          </div>
          <div className="row form-row">
            <label className="control-label">Interview Style</label>
            <select
              value={settings.interviewAnswerStyle}
              onChange={() => patchSettings({ interviewAnswerStyle: 'star_short_30s' })}
              disabled
            >
              <option value="star_short_30s">Duz Orta-Uzun (90-140 kelime)</option>
            </select>
          </div>
          <div className="row form-row">
            <label className="control-label">STT Runtime</label>
            <div className="subtitle value-text">
              {runtimeSummary}
            </div>
          </div>
          {sttRuntimeStatus && (
            <div className="subtitle">
              CUDA detected: {sttRuntimeStatus.cudaDetected ? 'evet' : 'hayir'} | GPU count:{' '}
              {sttRuntimeStatus.cudaDeviceCount} | CUDA retry: {sttRuntimeStatus.cudaRetryCount} |
              CPU fallback: {sttRuntimeStatus.fallbackToCpuCount}
            </div>
          )}
          {captureDiagnostics && (
            <div className="subtitle">
              Capture: {captureDiagnostics.reconnectState} | switch count:{' '}
              {captureDiagnostics.sourceSwitchCount || 0} | health:{' '}
              {captureDiagnostics.sourceHealth || 'n/a'} | silence:{' '}
              {Math.round((captureDiagnostics.remoteSilenceMs || 0) / 1000)}s | reason:{' '}
              {captureDiagnostics.lastSwitchReason || '-'} | remote rms:{' '}
              {Math.round(captureDiagnostics.remoteRms)} | self rms:{' '}
              {Math.round(captureDiagnostics.selfRms)}
            </div>
          )}
          {captureDiagnostics?.candidateScores && captureDiagnostics.candidateScores.length > 0 && (
            <div className="subtitle">
              Aday skorlar:{' '}
              {captureDiagnostics.candidateScores
                .map((item) => `${item.id}=${Math.round(item.score)}`)
                .join(' | ')}
            </div>
          )}
          <div className="subtitle">
            Pratik: Konusma kaciriyorsa STT modelini buyutun. Yanit kalitesi dusukse Answer modelini
            guclu bir modelle degistirin.
          </div>

          <div className="row" style={{ marginTop: 8 }}>
            <button onClick={persistSettings} disabled={savingSettings}>
              {savingSettings ? 'Kaydediliyor...' : 'Ayarlari Kaydet'}
            </button>
          </div>

          <h3 style={{ marginTop: 8 }}>Interview Profile</h3>
          <div className="subtitle">
            CV/GitHub/LinkedIn/ilan verileri lokal bellekte tutulur ve Interview mode cevabina baglam olarak eklenir.
          </div>
          <div className="subtitle">
            Manuel test: Soruyu buraya yazip assist cevabini ses acmadan olcebilirsiniz.
          </div>
          <div className="row form-row">
            <label className="control-label">Manuel Test Dili</label>
            <select
              value={manualPromptLanguage}
              onChange={(e) =>
                setManualPromptLanguage(
                  e.target.value === 'tr' ? 'tr' : e.target.value === 'en' ? 'en' : 'auto'
                )
              }
              disabled={manualRunning || session.active}
            >
              <option value="auto">Auto</option>
              <option value="tr">Turkce</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="Ornek: Can you describe a time you improved system reliability?"
              value={manualPrompt}
              onChange={(e) => setManualPrompt(e.target.value)}
              disabled={manualRunning || session.active}
            />
            <button onClick={runManualAssist} disabled={manualRunning || session.active}>
              {manualRunning ? 'Isleniyor...' : 'Manuel Assist Testi Calistir'}
            </button>
          </div>
          {profileSyncStatus && (
            <div className={`subtitle sync-status sync-status-${profileSyncStatus.state}`}>
              <span className="sync-mark">{profileSyncMark(profileSyncStatus.state)}</span>
              <span>
                Profil senkron: {profileSyncStatus.state}
                {profileSyncStatus.message ? ` | ${profileSyncStatus.message}` : ''}
              </span>
            </div>
          )}
          {profileSnapshot && (
            <div className="subtitle">
              Kaynak: {profileSnapshot.sourceCount} | Chunk: {profileSnapshot.chunkCount} | Guncel:{' '}
              {new Date(profileSnapshot.updatedAtMs).toLocaleTimeString()}
            </div>
          )}

          <div className="row input-action-row">
            <select
              value={fileImportType}
              onChange={(e) => setFileImportType(e.target.value as ProfileSourceType)}
              disabled={session.active || importingProfileFile}
            >
              <option value="cv">CV</option>
              <option value="job_desc">Job Description</option>
              <option value="linkedin">LinkedIn</option>
              <option value="note">Note</option>
              <option value="knowledge_base">Knowledge Base</option>
              <option value="web_corpus">Web Corpus</option>
              <option value="glossary">Glossary</option>
            </select>
            <input
              placeholder="Kaynak adi (opsiyonel)"
              value={fileImportName}
              onChange={(e) => setFileImportName(e.target.value)}
              disabled={session.active || importingProfileFile}
            />
            <button onClick={importProfileFile} disabled={session.active || importingProfileFile}>
              {importingProfileFile ? 'Dosya okunuyor...' : 'Dosya Yukle (OCR)'}
            </button>
          </div>
          <div className="subtitle">
            Desteklenen formatlar: PDF, DOCX, TXT, MD, JSON, YAML, CSV, PNG, JPG, WEBP, BMP.
          </div>

          <div className="row input-action-row">
            <input
              placeholder="GitHub username"
              value={githubUsername}
              onChange={(e) => setGithubUsername(e.target.value)}
              disabled={session.active || !settings.githubSyncEnabled}
            />
            <button
              onClick={syncGithub}
              disabled={session.active || !settings.githubSyncEnabled || syncingGithub}
            >
              {syncingGithub ? 'Senkron...' : 'GitHub Senkron'}
            </button>
          </div>
          <div className="row input-action-row">
            <button onClick={syncWebCorpus} disabled={session.active || syncingWebCorpus}>
              {syncingWebCorpus ? 'Web Corpus Senkron...' : 'Web Corpus + Glossary Senkron'}
            </button>
            <button onClick={ingestGlossary} disabled={session.active || ingestingGlossary}>
              {ingestingGlossary ? 'Glossary Import...' : 'Sadece Glossary Import'}
            </button>
          </div>
          <div className="subtitle">
            Web corpus senkronu internet kaynaklarini toplayip filtreler, sonra teknik sozlugu otomatik olusturur.
          </div>

          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="Ilan metni (job description)"
              value={jobDescInput}
              onChange={(e) => setJobDescInput(e.target.value)}
              disabled={session.active}
            />
            <button
              onClick={() => {
                void importProfileText('job_desc', jobDescInput, 'Job Description')
                setJobDescInput('')
              }}
              disabled={session.active || importingProfile}
            >
              Ekle
            </button>
          </div>

          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="CV ozeti veya deneyim notlari"
              value={cvInput}
              onChange={(e) => setCvInput(e.target.value)}
              disabled={session.active}
            />
            <button
              onClick={() => {
                void importProfileText('cv', cvInput, 'CV')
                setCvInput('')
              }}
              disabled={session.active || importingProfile}
            >
              CV Ekle
            </button>
          </div>

          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="LinkedIn export/ozet metni"
              value={linkedinInput}
              onChange={(e) => setLinkedinInput(e.target.value)}
              disabled={session.active}
            />
            <button
              onClick={() => {
                void importProfileText('linkedin', linkedinInput, 'LinkedIn')
                setLinkedinInput('')
              }}
              disabled={session.active || importingProfile}
            >
              LinkedIn Ekle
            </button>
          </div>

          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="Ek kisisel not"
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              disabled={session.active}
            />
            <button
              onClick={() => {
                void importProfileText('note', noteInput, 'Note')
                setNoteInput('')
              }}
              disabled={session.active || importingProfile}
            >
              Not Ekle
            </button>
          </div>

          <div className="row input-action-row">
            <textarea
              className="compact-textarea"
              placeholder="Terminoloji / teknik notlar (NLP, sistem tasarimi, kavramlar)"
              value={knowledgeBaseInput}
              onChange={(e) => setKnowledgeBaseInput(e.target.value)}
              disabled={session.active}
            />
            <button
              onClick={() => {
                void importProfileText('knowledge_base', knowledgeBaseInput, 'Knowledge Base')
                setKnowledgeBaseInput('')
              }}
              disabled={session.active || importingProfile}
            >
              Bilgi Ekle
            </button>
          </div>

          <div className="row input-action-row">
            <input
              placeholder="Context preview query (ornek: system design, kubernetes)"
              value={previewQuery}
              onChange={(e) => setPreviewQuery(e.target.value)}
            />
            <button onClick={() => void refreshContextPreview()} disabled={sessionBusy}>
              Preview
            </button>
            <button onClick={reindexProfile} disabled={session.active || reindexingProfile}>
              {reindexingProfile ? 'Reindex...' : 'Reindex'}
            </button>
          </div>

          {interviewContextPreview && interviewContextPreview.items.length > 0 && (
            <div className="history-list compact-list">
              {interviewContextPreview.items.map((item) => (
                <div key={`${item.sourceId}-${item.score}`} className="history-item">
                  <div className="row meta-row">
                    <span className="badge remote">{item.sourceType}</span>
                    <span className="subtitle">{item.sourceName}</span>
                    <span className="subtitle">score {item.score.toFixed(2)}</span>
                  </div>
                  <div className="history-main">{item.text}</div>
                </div>
              ))}
            </div>
          )}

          {profileSnapshot && profileSnapshot.sources.length > 0 && (
            <div className="history-list compact-list">
              {profileSnapshot.sources.slice(0, 20).map((source) => (
                <div key={source.id} className="history-item">
                  <div className="row meta-row">
                    <span className="badge self">{source.type}</span>
                    <span className="subtitle">{source.name}</span>
                    <span className="sync-chip">✓ hazir</span>
                    <button
                      onClick={() => void removeProfileSource(source.id)}
                      disabled={session.active}
                      className="tiny-btn"
                    >
                      Sil
                    </button>
                  </div>
                  <div className="history-sub">{source.contentChars} chars</div>
                </div>
              ))}
            </div>
          )}

          <div className="subtitle">
            Panel gizlendikten sonra sistem tepsisinden tekrar acabilirsiniz.
          </div>
        </div>

        <details className="glass card advanced-card">
          <summary>Gelismis</summary>

          <div className="row form-row" style={{ marginTop: 10 }}>
            <label className="control-label">System Audio Mode</label>
            <select
              value={settings.systemAudioMode}
              onChange={(e) =>
                patchSettings(
                  e.target.value === 'manual'
                    ? {
                        systemAudioMode: 'manual',
                        systemAudioStrategy: 'manual'
                      }
                    : {
                        systemAudioMode: 'auto',
                        systemAudioStrategy:
                          settings.systemAudioStrategy === 'picker_each_start'
                            ? 'picker_each_start'
                            : 'auto_live'
                      }
                )
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

          {settings.systemAudioMode === 'auto' && (
            <div className="row form-row">
              <label className="control-label">Auto Strategy</label>
              <select
                value={
                  settings.systemAudioStrategy === 'picker_each_start'
                    ? 'picker_each_start'
                    : 'auto_live'
                }
                onChange={(e) =>
                  patchSettings({
                    systemAudioStrategy:
                      e.target.value === 'picker_each_start'
                        ? 'picker_each_start'
                        : 'auto_live'
                  })
                }
                disabled={sessionBusy}
              >
                <option value="auto_live">Auto Live (onerilen)</option>
                <option value="picker_each_start">Picker Every Start</option>
              </select>
              <button
                onClick={redetectSystemSource}
                disabled={!session.active || sessionBusy || redetectingSource}
              >
                {redetectingSource ? 'Algilaniyor...' : 'Sesi Yeniden Algila'}
              </button>
            </div>
          )}

          <div className="row form-row">
            <label className="control-label">STT Runtime Mode</label>
            <select
              value={settings.sttRuntimeMode}
              onChange={(e) =>
                patchSettings({
                  sttRuntimeMode:
                    e.target.value === 'cuda'
                      ? 'cuda'
                      : e.target.value === 'cpu'
                        ? 'cpu'
                        : 'auto'
                })
              }
              disabled={sessionBusy}
            >
              <option value="auto">Auto (en hizli)</option>
              <option value="cuda">CUDA</option>
              <option value="cpu">CPU</option>
            </select>
          </div>

          <div className="row form-row">
            <label className="control-label">STT Dil Modu</label>
            <select
              value={settings.sttLanguageMode}
              onChange={(e) =>
                patchSettings({
                  sttLanguageMode:
                    e.target.value === 'manual'
                      ? 'manual'
                      : e.target.value === 'session_lock'
                        ? 'session_lock'
                        : 'segment_auto'
                })
              }
              disabled={sessionBusy}
            >
              <option value="segment_auto">Parca Bazli Auto</option>
              <option value="session_lock">Oturum Boyu Kilit</option>
              <option value="manual">Manuel</option>
            </select>
          </div>

          {settings.sttLanguageMode === 'manual' && (
            <div className="row form-row">
              <label className="control-label">Manuel Dil</label>
              <select
                value={settings.manualSttLanguage}
                onChange={(e) =>
                  patchSettings({
                    manualSttLanguage: e.target.value === 'en' ? 'en' : 'tr'
                  })
                }
                disabled={sessionBusy}
              >
                <option value="tr">Turkce</option>
                <option value="en">English</option>
              </select>
            </div>
          )}

          {settings.systemAudioMode === 'manual' && (
            <div className="row form-row">
              <label className="control-label">Manual Source</label>
              <select
                value={selectedSystemSourceId || settings.manualSystemSourceId}
                onChange={(e) => {
                  setSelectedSystemSourceId(e.target.value)
                  patchSettings({ manualSystemSourceId: e.target.value })
                }}
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

          <div className="row inline-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.captureMicrophone}
                onChange={(e) => patchSettings({ captureMicrophone: e.target.checked })}
              />{' '}
              Mikrofonu da yakala
            </label>
          </div>

          <div className="row inline-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.autoHideControlWindow}
                onChange={(e) => patchSettings({ autoHideControlWindow: e.target.checked })}
              />{' '}
              Baslatinca paneli gizle
            </label>
          </div>

          <div className="row inline-checks">
            <label className="check-label">
              <input
                type="checkbox"
                checked={settings.overlayClickThrough}
                onChange={(e) => setOverlayClickThrough(e.target.checked)}
              />{' '}
              Overlay click-through
            </label>
          </div>

          <div className="row form-row">
            <label className="control-label">Overlay Opacity</label>
            <input
              type="range"
              min="0.25"
              max="1"
              step="0.01"
              value={settings.overlayOpacity}
              onChange={(e) => setOverlayOpacity(Number(e.target.value))}
            />
            <span className="subtitle">{Math.round(settings.overlayOpacity * 100)}%</span>
          </div>

          <div className="row form-row">
            <label className="control-label">Ollama URL</label>
            <input
              value={settings.ollamaBaseUrl}
              onChange={(e) => patchSettings({ ollamaBaseUrl: e.target.value })}
            />
          </div>
        </details>
      </div>

      <div className="glass card history-card">
        <div className="row meta-row">
          <h3>Canli Gecmis</h3>
          <div className="subtitle">
            Transcript: {transcriptFeed.length} | Assist: {assistFeed.length}
          </div>
        </div>

        <div className="history-grid">
          <div className="history-column">
            <div className="subtitle">Transcript Akisi</div>
            <div className="history-list">
              {transcriptFeed.length === 0 && <div className="subtitle">Henuz transcript yok.</div>}
              {transcriptFeed.map((item) => {
                const assist = assistByTranscript.get(item.id)
                return (
                  <div className="history-item" key={item.id}>
                    <div className="row meta-row">
                      <span className={`badge ${item.speaker}`}>{item.speaker}</span>
                      <span className="subtitle">{(item.language || 'unknown').toUpperCase()}</span>
                      <span className="subtitle">{new Date(item.emittedMs).toLocaleTimeString()}</span>
                    </div>
                    <div className="history-main">{item.text || item.textEn}</div>
                    {assist?.translationTr && <div className="history-sub">{assist.translationTr}</div>}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="history-column">
            <div className="subtitle">Assist Akisi</div>
            <div className="history-list">
              {assistFeed.length === 0 && <div className="subtitle">Henuz assist yok.</div>}
              {assistFeed.map((item) => (
                <div className="history-item" key={item.id}>
                  <div className="row meta-row">
                    <span className="badge remote">assistant</span>
                    <span className="subtitle">{Math.round(item.latencyMs)} ms</span>
                  </div>
                  <div className="history-main">{assistPrimaryText(item)}</div>
                  <div className="history-sub">{assistSecondaryText(item)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}


