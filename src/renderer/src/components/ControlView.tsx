import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AssistEvent,
  ProfileSourceType,
  ReviewLabel,
  SessionHistoryRecord
} from '../../../shared/contracts'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'
import { AdvancedSettingsDrawer } from './control/AdvancedSettingsDrawer'
import { LiveTab } from './control/LiveTab'
import { PracticeTab } from './control/PracticeTab'
import { PrepareTab } from './control/PrepareTab'
import {
  CapturePhase,
  ControlTab,
  getActiveQuestion,
  getFriendlySessionLabel,
  getLatestAssist,
  getRecentTimeline,
  reviewLabelOf
} from './control/shared'

export function ControlView(): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    transcripts,
    assistUpdates,
    profileSnapshot,
    profileSyncStatus,
    interviewContextPreview,
    historyEncryptionAvailable,
    historySessions,
    captureDiagnostics,
    error,
    setError,
    patchSettings,
    setSettings,
    setAudioSources,
    setSelectedSystemSourceId,
    setCaptureDiagnostics,
    setProfileSnapshot,
    setInterviewContextPreview,
    setHistoryList
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
  const [activeTab, setActiveTab] = useState<ControlTab>('live')
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [infoMessage, setInfoMessage] = useState<string | null>(null)
  const [savingSettings, setSavingSettings] = useState(false)
  const [refreshingSources, setRefreshingSources] = useState(false)
  const [refreshingHistory, setRefreshingHistory] = useState(false)
  const [syncingGithub, setSyncingGithub] = useState(false)
  const [importingFile, setImportingFile] = useState(false)
  const [loadingHistoryDetail, setLoadingHistoryDetail] = useState(false)
  const [savingReviewAssistId, setSavingReviewAssistId] = useState<string | null>(null)
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState('')
  const [selectedHistoryRecord, setSelectedHistoryRecord] = useState<SessionHistoryRecord | null>(null)
  const [githubUsername, setGithubUsername] = useState('')
  const [cvInput, setCvInput] = useState('')
  const [jobDescInput, setJobDescInput] = useState('')
  const [noteInput, setNoteInput] = useState('')
  const [previewQuery, setPreviewQuery] = useState('')
  const [practicePrompt, setPracticePrompt] = useState('')
  const [fileImportType, setFileImportType] = useState<ProfileSourceType>('cv')
  const [capturePhase, setCapturePhase] = useState<CapturePhase>('idle')
  const [redetectingAudio, setRedetectingAudio] = useState(false)

  useEffect(() => {
    void refreshHistory()
    return () => {
      if (audioRef.current) {
        void audioRef.current.stop()
        audioRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    if (!session.active && session.phase === 'idle') {
      setCapturePhase('idle')
    }
  }, [session.active, session.phase])

  useEffect(() => {
    const runtimeIssue = captureDiagnostics?.lastErrorMessage || session.lastError
    const recovered =
      !runtimeIssue &&
      (capturePhase === 'running' ||
        capturePhase === 'idle' ||
        session.phase === 'running' ||
        session.phase === 'idle' ||
        session.phase === 'degraded')

    if (recovered && error) {
      setError(null)
    }
  }, [
    captureDiagnostics?.lastErrorMessage,
    capturePhase,
    error,
    session.lastError,
    session.phase,
    setError
  ])

  const activeQuestion = useMemo(() => getActiveQuestion(transcripts), [transcripts])
  const activeAssist = useMemo(() => getLatestAssist(assistUpdates), [assistUpdates])
  const timeline = useMemo(() => getRecentTimeline(transcripts), [transcripts])
  const sessionLabel = useMemo(
    () => getFriendlySessionLabel(session, capturePhase),
    [capturePhase, session]
  )
  const activeSourceLabel = useMemo(() => {
    return (
      captureDiagnostics?.activeSourceName ||
      selectedSystemSourceId ||
      (settings?.systemAudioStrategy === 'manual' ? 'Fixed source' : 'Picker on start')
    )
  }, [captureDiagnostics?.activeSourceName, selectedSystemSourceId, settings?.systemAudioStrategy])
  const selectedHistorySummary = useMemo(
    () => historySessions.find((item) => item.id === selectedHistorySessionId) || null,
    [historySessions, selectedHistorySessionId]
  )
  const reviewedAssists = useMemo(
    () => [...(selectedHistoryRecord?.assists || [])].filter((item) => item.state !== 'partial').reverse(),
    [selectedHistoryRecord]
  )

  const refreshSources = async (): Promise<void> => {
    try {
      setRefreshingSources(true)
      setAudioSources(await window.api.getAudioSources())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Audio sources could not be loaded.')
    } finally {
      setRefreshingSources(false)
    }
  }

  const refreshProfileState = async (): Promise<void> => {
    const [snapshot, preview] = await Promise.all([
      window.api.getProfileSnapshot(),
      window.api.getInterviewContextPreview(previewQuery || '')
    ])
    setProfileSnapshot(snapshot)
    setInterviewContextPreview(preview)
    setError(null)
  }

  const loadHistoryDetail = async (sessionId: string): Promise<void> => {
    if (!sessionId.trim()) {
      setSelectedHistorySessionId('')
      setSelectedHistoryRecord(null)
      return
    }
    try {
      setLoadingHistoryDetail(true)
      setSelectedHistorySessionId(sessionId)
      const result = await window.api.getHistorySessionDetail(sessionId)
      setSelectedHistoryRecord(result.record)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Session detail could not be loaded.')
    } finally {
      setLoadingHistoryDetail(false)
    }
  }

  const refreshHistory = async (): Promise<void> => {
    try {
      setRefreshingHistory(true)
      setHistoryList(await window.api.listHistorySessions())
      if (selectedHistorySessionId) {
        const result = await window.api.getHistorySessionDetail(selectedHistorySessionId)
        setSelectedHistoryRecord(result.record)
      }
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'History could not be loaded.')
    } finally {
      setRefreshingHistory(false)
    }
  }

  const stopSession = async (message?: string): Promise<void> => {
    try {
      if (audioRef.current) {
        await audioRef.current.stop()
        audioRef.current = null
      }
      await window.api.stopSession()
      setCaptureDiagnostics(null)
      setCapturePhase('idle')
      if (!message) {
        setError(null)
      }
    } finally {
      if (message) setError(message)
    }
  }

  const redetectAudioSource = async (promptUser = true): Promise<boolean> => {
    if (!audioRef.current) {
      setError('Start a live session before reselecting the audio source.')
      return false
    }

    try {
      setRedetectingAudio(true)
      setCapturePhase(promptUser ? 'waiting_for_source' : 'reconnecting_audio')
      const recovered = await audioRef.current.redetectAudioSource({ promptUser })
      if (recovered) {
        setCapturePhase('running')
        setInfoMessage('Audio source updated.')
        setError(null)
        return true
      }

      setCapturePhase('degraded_listening')
      setError('Audio source was not updated. Select a source and try again.')
      return false
    } catch (err) {
      setCapturePhase('degraded_listening')
      setError(err instanceof Error ? err.message : 'Audio source could not be updated.')
      return false
    } finally {
      setRedetectingAudio(false)
    }
  }

  const startSession = async (): Promise<void> => {
    if (!settings || session.active || session.phase === 'starting' || session.phase === 'stopping') {
      return
    }
    let capture: MeetingAudioCapture | null = null
    let sessionStarted = false
    try {
      const strategy = settings.systemAudioStrategy === 'manual' ? 'manual' : 'picker_each_start'
      const manualSourceId =
        settings.systemAudioStrategy === 'manual'
          ? selectedSystemSourceId || settings.manualSystemSourceId
          : undefined
      capture = new MeetingAudioCapture()
      audioRef.current = capture
      setCapturePhase(strategy === 'manual' ? 'reconnecting_audio' : 'waiting_for_source')
      await capture.start({
        strategy,
        systemSourceId: manualSourceId,
        captureMicrophone: settings.captureMicrophone,
        onChunk: (chunk) => window.api.sendAudioChunk(chunk),
        onDiagnostics: (event) => setCaptureDiagnostics(event),
        onSourceChanged: (source) => {
          setSelectedSystemSourceId(source.id)
          if (settings.systemAudioStrategy === 'manual' && !source.id.startsWith('display-media:')) {
            patchSettings({
              manualSystemSourceId: source.id,
              systemAudioMode: 'manual'
            })
          }
        },
        onFatalError: (fatalError) => {
          setError(fatalError.message)
          void redetectAudioSource(true)
        }
      })
      setCapturePhase('running')
      await window.api.startSession({
        mode: settings.productMode,
        sttModel: settings.sttModel,
        sttRuntimeMode: settings.sttRuntimeMode,
        vad: settings.vad
      })
      sessionStarted = true
      setError(null)
      setInfoMessage(
        strategy === 'manual'
          ? 'Listening started with the selected source.'
          : 'Listening started. Pick the browser tab, window, or screen in the source picker.'
      )
      if (settings.autoHideControlWindow) await window.api.hideControlWindow()
    } catch (err) {
      if (capture) {
        await capture.stop()
      }
      audioRef.current = null
      setCaptureDiagnostics(null)
      setCapturePhase('idle')
      if (sessionStarted) {
        await window.api.stopSession()
      }
      setError(err instanceof Error ? err.message : 'Session start failed.')
    }
  }

  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    try {
      setSavingSettings(true)
      const saved = await window.api.updateSettings(settings)
      setSettings(saved)
      setError(null)
      setInfoMessage('Preferences saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings could not be saved.')
    } finally {
      setSavingSettings(false)
    }
  }

  const importText = async (
    type: ProfileSourceType,
    content: string,
    clear: () => void
  ): Promise<void> => {
    if (!content.trim()) return
    try {
      await window.api.importProfileSource({
        type,
        name:
          type === 'cv'
            ? 'CV'
            : type === 'job_desc'
              ? 'Job Description'
              : type === 'note'
                ? 'Interview Notes'
                : 'Profile Source',
        content: content.trim()
      })
      clear()
      await refreshProfileState()
      setError(null)
      setInfoMessage('Profile source imported.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Source import failed.')
    }
  }

  const syncGithub = async (): Promise<void> => {
    if (!githubUsername.trim()) return
    try {
      setSyncingGithub(true)
      await window.api.syncGithubProfile({ username: githubUsername.trim() })
      await refreshProfileState()
      setError(null)
      setInfoMessage('GitHub synced.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub sync failed.')
    } finally {
      setSyncingGithub(false)
    }
  }

  const importFile = async (): Promise<void> => {
    try {
      setImportingFile(true)
      const result = await window.api.importProfileFile({ type: fileImportType })
      if (!result.cancelled) {
        await refreshProfileState()
        setError(null)
        setInfoMessage('File imported.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File import failed.')
    } finally {
      setImportingFile(false)
    }
  }

  const clearProfileSource = async (sourceId: string): Promise<void> => {
    try {
      await window.api.clearProfileSource({ sourceId })
      await refreshProfileState()
      setError(null)
      setInfoMessage('Source removed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Source could not be removed.')
    }
  }

  const runPractice = async (): Promise<void> => {
    if (!practicePrompt.trim()) return
    try {
      await window.api.generatePracticeAnswer({
        text: practicePrompt.trim(),
        language: 'en',
        speaker: 'remote'
      })
      setError(null)
      setInfoMessage('Practice answer generated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Practice answer failed.')
    }
  }

  const exportHistory = async (format: 'json' | 'markdown', sessionId?: string): Promise<void> => {
    try {
      const result = await window.api.exportSessionHistory({ format, sessionId })
      setError(null)
      setInfoMessage(`Exported to ${result.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    }
  }

  const updateAssistReview = async (
    assistId: string,
    reviewLabel: ReviewLabel,
    reviewTags?: string[]
  ): Promise<void> => {
    if (!selectedHistorySessionId || !selectedHistoryRecord) return
    const assist = selectedHistoryRecord.assists.find((item) => item.id === assistId)
    if (!assist) return

    try {
      setSavingReviewAssistId(assistId)
      await window.api.updateAssistReview({
        sessionId: selectedHistorySessionId,
        assistId,
        reviewLabel,
        reviewTags,
        reviewComment: assist.reviewComment,
        reviewSource: 'ui'
      })
      await refreshHistory()
      await loadHistoryDetail(selectedHistorySessionId)
      setError(null)
      setInfoMessage('Review saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review update failed.')
    } finally {
      setSavingReviewAssistId(null)
    }
  }

  const toggleReviewTag = async (assist: AssistEvent, tag: string): Promise<void> => {
    const label = reviewLabelOf(assist)
    if (label !== 'chosen' && label !== 'rejected') return
    const current = new Set((assist.reviewTags || []).map((item) => item.trim()).filter(Boolean))
    if (current.has(tag)) {
      current.delete(tag)
    } else {
      current.add(tag)
    }
    await updateAssistReview(assist.id, label, Array.from(current))
  }

  const toggleMute = async (): Promise<void> => {
    await window.api.toggleAssistantMute()
  }

  const toggleOverlay = async (): Promise<void> => {
    if (!settings) return
    await window.api.setOverlay({ visible: !settings.overlayVisible })
  }

  if (!settings) {
    return (
      <div className="control-shell">
        <div className="panel panel-hero">Loading interview workspace...</div>
      </div>
    )
  }

  return (
    <div className="control-shell redesigned-shell">
      <header className="app-topbar">
        <div className="brand-block">
          <div className="eyebrow">Interview Copilot</div>
          <h1>Calm, focused, and easier to use.</h1>
          <p>Keep the surface simple while the assistant handles the heavy lifting.</p>
        </div>
        <div className="topbar-actions">
          <div className="topbar-chip">
            <span>Status</span>
            <strong>{sessionLabel}</strong>
          </div>
          <button className="secondary-btn" disabled={savingSettings} onClick={() => void saveSettings()}>
            {savingSettings ? 'Saving...' : 'Save setup'}
          </button>
          <button className="ghost-btn" onClick={() => setAdvancedOpen(true)}>
            Advanced settings
          </button>
        </div>
      </header>

      <nav className="tab-nav" aria-label="Main sections">
        <button
          className={`tab-btn ${activeTab === 'live' ? 'tab-btn-active' : ''}`}
          onClick={() => setActiveTab('live')}
        >
          Live
        </button>
        <button
          className={`tab-btn ${activeTab === 'practice' ? 'tab-btn-active' : ''}`}
          onClick={() => setActiveTab('practice')}
        >
          Practice
        </button>
        <button
          className={`tab-btn ${activeTab === 'prepare' ? 'tab-btn-active' : ''}`}
          onClick={() => setActiveTab('prepare')}
        >
          Prepare
        </button>
      </nav>

      <main className="app-content">
        {activeTab === 'live' && (
          <LiveTab
            settings={settings}
            session={session}
            audioSources={audioSources}
            selectedSystemSourceId={selectedSystemSourceId}
            activeSourceLabel={activeSourceLabel}
            capturePhase={capturePhase}
            captureDiagnostics={captureDiagnostics}
            activeQuestion={activeQuestion}
            activeAssist={activeAssist}
            timeline={timeline}
            assistUpdates={assistUpdates}
            error={error}
            infoMessage={infoMessage}
            refreshingSources={refreshingSources}
            redetectingAudio={redetectingAudio}
            sessionLabel={sessionLabel}
            onPatchSettings={patchSettings}
            onSetSelectedSystemSourceId={setSelectedSystemSourceId}
            onRefreshSources={refreshSources}
            onRedetectAudioSource={redetectAudioSource}
            onStartSession={startSession}
            onStopSession={() => stopSession()}
            onToggleMute={toggleMute}
            onToggleOverlay={toggleOverlay}
            onOpenAdvanced={() => setAdvancedOpen(true)}
          />
        )}

        {activeTab === 'practice' && (
          <PracticeTab
            session={session}
            practicePrompt={practicePrompt}
            activeQuestion={activeQuestion}
            activeAssist={activeAssist}
            infoMessage={infoMessage}
            error={error}
            onSetPracticePrompt={setPracticePrompt}
            onRunPractice={runPractice}
          />
        )}

        {activeTab === 'prepare' && (
          <PrepareTab
            settings={settings}
            profileSnapshot={profileSnapshot}
            profileSyncStatus={profileSyncStatus}
            interviewContextPreview={interviewContextPreview}
            historyEncryptionAvailable={historyEncryptionAvailable}
            historySessions={historySessions}
            selectedHistorySessionId={selectedHistorySessionId}
            selectedHistorySummary={selectedHistorySummary}
            selectedHistoryRecord={selectedHistoryRecord}
            reviewedAssists={reviewedAssists}
            githubUsername={githubUsername}
            cvInput={cvInput}
            jobDescInput={jobDescInput}
            noteInput={noteInput}
            previewQuery={previewQuery}
            fileImportType={fileImportType}
            syncingGithub={syncingGithub}
            importingFile={importingFile}
            refreshingHistory={refreshingHistory}
            loadingHistoryDetail={loadingHistoryDetail}
            savingReviewAssistId={savingReviewAssistId}
            infoMessage={infoMessage}
            error={error}
            onPatchSettings={patchSettings}
            onSetGithubUsername={setGithubUsername}
            onSetCvInput={setCvInput}
            onSetJobDescInput={setJobDescInput}
            onSetNoteInput={setNoteInput}
            onSetPreviewQuery={setPreviewQuery}
            onSetFileImportType={setFileImportType}
            onRefreshProfileState={refreshProfileState}
            onSyncGithub={syncGithub}
            onImportText={importText}
            onImportFile={importFile}
            onClearSource={clearProfileSource}
            onRefreshHistory={refreshHistory}
            onLoadHistoryDetail={loadHistoryDetail}
            onExportHistory={exportHistory}
            onUpdateAssistReview={updateAssistReview}
            onToggleReviewTag={toggleReviewTag}
          />
        )}
      </main>

      <AdvancedSettingsDrawer
        open={advancedOpen}
        settings={settings}
        savingSettings={savingSettings}
        onPatchSettings={patchSettings}
        onSaveSettings={saveSettings}
        onClose={() => setAdvancedOpen(false)}
      />
    </div>
  )
}
