import { useEffect, useMemo, useRef, useState } from 'react'
import { MeetingAudioCapture } from '../services/audioCapture'
import { useAppStore } from '../store/useAppStore'
import {
  AssistEvent,
  ProfileSourceType,
  ProviderKind,
  ReviewLabel,
  SessionHistoryRecord,
  SystemAudioStrategy
} from '../../../shared/contracts'

const PROFILE_PRESETS = [
  { id: 'llama3_1_8b_primary', title: 'Llama 3.1 8B', model: 'llama3.1:8b-instruct-q4_K_M' },
  { id: 'qwen2_5_7b_latency', title: 'Qwen 2.5 7B', model: 'qwen2.5:7b-instruct-q4_K_M' },
  { id: 'mistral_7b_natural', title: 'Mistral 7B', model: 'mistral:7b-instruct-v0.3-q4_K_M' }
] as const
const STT_MODELS = ['medium.en', 'large-v3-turbo', 'large-v3']
const SOURCE_LABEL: Record<ProfileSourceType, string> = {
  cv: 'CV', github: 'GitHub', linkedin: 'LinkedIn', job_desc: 'Job Description', note: 'Interview Notes', knowledge_base: 'Knowledge Base', web_corpus: 'Web Corpus', glossary: 'Glossary'
}
const CHOSEN_TAGS = ['grounded', 'concise', 'star_ready', 'technical_tradeoff', 'calming', 'accurate']
const REJECTED_TAGS = ['too_long', 'generic', 'hallucinated', 'role_confusion', 'asks_question_back', 'not_first_person', 'too_vague', 'overconfident']

function mainAnswer(item?: AssistEvent | null): string {
  return item?.answerEn || item?.rawText || '-'
}

function helperAnswer(item?: AssistEvent | null): string {
  return item?.helperAnswerTr || item?.questionTr || '-'
}

function reviewLabelOf(item?: AssistEvent | null): ReviewLabel {
  return item?.reviewLabel || 'unreviewed'
}

function reviewTagsFor(label: ReviewLabel): string[] {
  if (label === 'chosen') return CHOSEN_TAGS
  if (label === 'rejected') return REJECTED_TAGS
  return []
}

export function ControlView(): React.JSX.Element {
  const {
    settings, session, audioSources, selectedSystemSourceId, transcripts, assistUpdates, sttRuntimeStatus,
    captureDiagnostics, latencyMetrics, profileSnapshot, interviewContextPreview, historySessions, error,
    setError, patchSettings, setSettings, setAudioSources, setSelectedSystemSourceId, setCaptureDiagnostics,
    setProfileSnapshot, setInterviewContextPreview, setHistoryList
  } = useAppStore()

  const audioRef = useRef<MeetingAudioCapture | null>(null)
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

  useEffect(() => {
    void refreshHistory()
    return () => {
      if (audioRef.current) {
        void audioRef.current.stop()
        audioRef.current = null
      }
    }
  }, [])

  const activeQuestion = useMemo(() => [...transcripts].reverse().find((item) => item.speaker === 'remote') || null, [transcripts])
  const activeAssist = useMemo(() => [...assistUpdates].reverse().find((item) => item.state !== 'error') || null, [assistUpdates])
  const timeline = useMemo(() => transcripts.slice(-6).reverse(), [transcripts])
  const runtimeSummary = useMemo(() => {
    if (!sttRuntimeStatus) return 'warming'
    return `${sttRuntimeStatus.phase} | ${sttRuntimeStatus.activeDevice || 'unknown'} | warmup ${sttRuntimeStatus.warmupMs === null ? 'n/a' : `${Math.round(sttRuntimeStatus.warmupMs)} ms`}`
  }, [sttRuntimeStatus])
  const latencySummary = useMemo(() => {
    if (!latencyMetrics) return 'No latency data yet'
    const ttft = latencyMetrics.assistFirstTokenMs.p50 === null ? 'n/a' : `${Math.round(latencyMetrics.assistFirstTokenMs.p50)} ms`
    const final = latencyMetrics.assistFinalMs.p50 === null ? 'n/a' : `${Math.round(latencyMetrics.assistFinalMs.p50)} ms`
    return `TTFT ${ttft} | Final ${final}`
  }, [latencyMetrics])
  const selectedHistorySummary = useMemo(() => historySessions.find((item) => item.id === selectedHistorySessionId) || null, [historySessions, selectedHistorySessionId])
  const reviewedAssists = useMemo(() => [...(selectedHistoryRecord?.assists || [])].filter((item) => item.state !== 'partial').reverse(), [selectedHistoryRecord])

  const refreshSources = async (): Promise<void> => {
    try {
      setRefreshingSources(true)
      setAudioSources(await window.api.getAudioSources())
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
    } finally {
      if (message) setError(message)
    }
  }

  const startSession = async (): Promise<void> => {
    if (!settings || session.active || session.phase === 'starting' || session.phase === 'stopping') return
    try {
      const strategy: SystemAudioStrategy =
        settings.systemAudioStrategy === 'manual' ? 'manual' : settings.systemAudioStrategy === 'picker_each_start' ? 'picker_each_start' : 'auto_live'
      const manualSourceId = settings.systemAudioStrategy === 'manual' ? selectedSystemSourceId || settings.manualSystemSourceId : undefined
      await window.api.startSession({ mode: settings.productMode, sttModel: settings.sttModel, sttRuntimeMode: settings.sttRuntimeMode, vad: settings.vad })
      const capture = new MeetingAudioCapture()
      audioRef.current = capture
      await capture.start({
        strategy,
        systemSourceId: manualSourceId,
        captureMicrophone: settings.captureMicrophone,
        onChunk: (chunk) => window.api.sendAudioChunk(chunk),
        onDiagnostics: (event) => setCaptureDiagnostics(event),
        onSourceChanged: (source) => setSelectedSystemSourceId(source.id),
        onFatalError: (fatalError) => { void stopSession(fatalError.message) }
      })
      if (settings.autoHideControlWindow) await window.api.hideControlWindow()
    } catch (err) {
      await stopSession(err instanceof Error ? err.message : 'Session start failed.')
    }
  }

  const saveSettings = async (): Promise<void> => {
    if (!settings) return
    try {
      setSavingSettings(true)
      const saved = await window.api.updateSettings(settings)
      setSettings(saved)
      setInfoMessage('Settings saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Settings could not be saved.')
    } finally {
      setSavingSettings(false)
    }
  }

  const importText = async (type: ProfileSourceType, content: string, clear: () => void): Promise<void> => {
    if (!content.trim()) return
    try {
      await window.api.importProfileSource({ type, name: SOURCE_LABEL[type], content: content.trim() })
      clear()
      await refreshProfileState()
      setInfoMessage(`${SOURCE_LABEL[type]} imported.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : `${SOURCE_LABEL[type]} import failed.`)
    }
  }

  const syncGithub = async (): Promise<void> => {
    if (!githubUsername.trim()) return
    try {
      setSyncingGithub(true)
      await window.api.syncGithubProfile({ username: githubUsername.trim() })
      await refreshProfileState()
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
        setInfoMessage(`${SOURCE_LABEL[fileImportType]} file imported.`)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'File import failed.')
    } finally {
      setImportingFile(false)
    }
  }

  const runPractice = async (): Promise<void> => {
    if (!practicePrompt.trim()) return
    try {
      await window.api.generatePracticeAnswer({ text: practicePrompt.trim(), language: 'en', speaker: 'remote' })
      setPracticePrompt('')
      setInfoMessage('Practice answer generated.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Practice answer failed.')
    }
  }

  const exportHistory = async (format: 'json' | 'markdown', sessionId?: string): Promise<void> => {
    try {
      const result = await window.api.exportSessionHistory({ format, sessionId })
      setInfoMessage(`Exported to ${result.path}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed.')
    }
  }

  const updateAssistReview = async (assistId: string, reviewLabel: ReviewLabel, reviewTags?: string[]): Promise<void> => {
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

  if (!settings) {
    return <div className="control-shell"><div className="control-card hero-card">Loading interview workspace...</div></div>
  }

  const activePreset = PROFILE_PRESETS.find((item) => item.id === settings.inferenceProfileId) || PROFILE_PRESETS[0]

  return (
    <div className="control-shell">
      <section className="control-card hero-card">
        <div>
          <div className="eyebrow">Interview Copilot</div>
          <h1>English-first, persona-grounded, low-latency live assist.</h1>
          <p className="hero-copy">The core answer path is English only. Turkish is a hidden helper layer, never the primary output.</p>
        </div>
        <div className="hero-meta">
          <div className="metric-pill"><span>Profile</span><strong>{activePreset.title}</strong></div>
          <div className="metric-pill"><span>STT</span><strong>{settings.sttModel}</strong></div>
          <div className="metric-pill"><span>Mode</span><strong>{settings.productMode}</strong></div>
        </div>
      </section>

      <section className="control-grid compact-grid">
        <div className="column-stack">
          <article className="control-card session-card">
            <div className="section-head">
              <div><div className="section-kicker">Session</div><h2>Live Interview</h2></div>
              <div className={`state-badge state-${session.phase}`}>{session.phase}</div>
            </div>
            <div className="chip-row">
              <button className="primary-btn" disabled={session.active} onClick={() => void startSession()}>Start Live</button>
              <button className="ghost-btn" disabled={!session.active} onClick={() => void stopSession()}>Stop</button>
              <button className="ghost-btn" onClick={() => void window.api.toggleAssistantMute()}>{session.muted ? 'Unmute' : 'Mute'}</button>
              <button className="ghost-btn" onClick={() => void window.api.setOverlay({ visible: !settings.overlayVisible })}>{settings.overlayVisible ? 'Hide Overlay' : 'Show Overlay'}</button>
            </div>
            <div className="status-list">
              <div className="status-item"><span>Runtime</span><strong>{runtimeSummary}</strong></div>
              <div className="status-item"><span>Latency</span><strong>{latencySummary}</strong></div>
              <div className="status-item"><span>Source</span><strong>{selectedSystemSourceId || 'auto'}</strong></div>
              <div className="status-item"><span>Capture</span><strong>{captureDiagnostics?.sourceHealth || 'healthy'}</strong></div>
            </div>
            {error && <div className="warning-note">{error}</div>}
            {infoMessage && <div className="info-note">{infoMessage}</div>}
          </article>

          <article className="control-card answer-card">
            <div className="section-head">
              <div><div className="section-kicker">Live Answer</div><h2>Current Output</h2></div>
              <div className={`confidence-chip confidence-${activeAssist?.supportSignals?.confidenceBand || 'medium'}`}>{activeAssist?.supportSignals?.confidenceBand || 'medium'}</div>
            </div>
            <div className="prompt-block"><span>Latest Question</span><p>{activeQuestion?.text || 'Waiting for interviewer audio...'}</p></div>
            <div className="answer-block primary-answer"><span>Main English Answer</span><p>{mainAnswer(activeAssist)}</p></div>
            <div className="answer-block secondary-answer"><span>Helper Layer</span><p>{helperAnswer(activeAssist)}</p></div>
            <div className="chip-row">
              <span className="soft-chip">context {activeAssist?.supportSignals?.contextHitCount ?? 0}</span>
              <span className="soft-chip">risk {(activeAssist?.supportSignals?.riskFlags || []).join(', ') || 'clear'}</span>
              <span className="soft-chip">ttft {activeAssist?.firstTokenMs ? `${Math.round(activeAssist.firstTokenMs)} ms` : 'n/a'}</span>
            </div>
          </article>

          <article className="control-card timeline-card">
            <div className="section-head">
              <div><div className="section-kicker">Timeline</div><h2>Recent Turns</h2></div>
              <button className="ghost-btn" disabled={refreshingHistory} onClick={() => void refreshHistory()}>{refreshingHistory ? 'Refreshing...' : 'Refresh History'}</button>
            </div>
            <div className="timeline-list">
              {timeline.length === 0 && <div className="empty-state">Transcript and answer flow will appear here.</div>}
              {timeline.map((item) => {
                const assist = assistUpdates.find((entry) => entry.transcriptId === item.id && entry.state !== 'error')
                return (
                  <div className="timeline-row" key={item.id}>
                    <div className="timeline-meta"><span className={`speaker-badge speaker-${item.speaker}`}>{item.speaker}</span><span>{(item.language || 'unknown').toUpperCase()}</span><span>{new Date(item.emittedMs).toLocaleTimeString()}</span></div>
                    <div className="timeline-question">{item.text}</div>
                    {assist && <div className="timeline-answer">{mainAnswer(assist)}</div>}
                    {assist?.helperAnswerTr && <div className="timeline-helper">{assist.helperAnswerTr}</div>}
                  </div>
                )
              })}
            </div>
          </article>
        </div>
        <div className="column-stack side-column">
          <article className="control-card runtime-card">
            <div className="section-head"><div><div className="section-kicker">Runtime</div><h2>Models and Providers</h2></div><button className="primary-btn" disabled={savingSettings} onClick={() => void saveSettings()}>{savingSettings ? 'Saving...' : 'Save Settings'}</button></div>
            <label className="field"><span>Inference Profile</span><select value={settings.inferenceProfileId} onChange={(e) => {
              const next = PROFILE_PRESETS.find((item) => item.id === e.target.value) || PROFILE_PRESETS[0]
              patchSettings({
                inferenceProfileId: next.id,
                providerConfig: {
                  inference: { ...settings.providerConfig.inference, model: next.model },
                  translation: { ...settings.providerConfig.translation }
                }
              })
            }}>{PROFILE_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
            <div className="field-grid two-up">
              <label className="field"><span>Inference Provider</span><select value={settings.providerConfig.inference.kind} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference, kind: e.target.value as ProviderKind }, translation: { ...settings.providerConfig.translation } } })}><option value="ollama">ollama</option><option value="openai_compatible">openai compatible</option></select></label>
              <label className="field"><span>Inference Model</span><input value={settings.providerConfig.inference.model} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference, model: e.target.value }, translation: { ...settings.providerConfig.translation } } })} /></label>
            </div>
            <label className="field"><span>Inference Base URL</span><input value={settings.providerConfig.inference.baseUrl} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference, baseUrl: e.target.value }, translation: { ...settings.providerConfig.translation } } })} /></label>
            <label className="field"><span>Inference API Key</span><input type="password" value={settings.providerConfig.inference.apiKey || ''} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference, apiKey: e.target.value }, translation: { ...settings.providerConfig.translation } } })} placeholder="optional" /></label>
            <label className="field inline-field"><span>Enable TR Helper</span><input type="checkbox" checked={settings.helperTranslationEnabled} onChange={(e) => patchSettings({ helperTranslationEnabled: e.target.checked, providerConfig: { inference: { ...settings.providerConfig.inference }, translation: { ...settings.providerConfig.translation, enabled: e.target.checked } } })} /></label>
            <div className="field-grid two-up">
              <label className="field"><span>Translation Provider</span><select disabled={!settings.helperTranslationEnabled} value={settings.providerConfig.translation.kind} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference }, translation: { ...settings.providerConfig.translation, kind: e.target.value as ProviderKind } } })}><option value="ollama">ollama</option><option value="openai_compatible">openai compatible</option></select></label>
              <label className="field"><span>Translation Model</span><input disabled={!settings.helperTranslationEnabled} value={settings.providerConfig.translation.model} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference }, translation: { ...settings.providerConfig.translation, model: e.target.value } } })} /></label>
            </div>
            <label className="field"><span>Translation Base URL</span><input disabled={!settings.helperTranslationEnabled} value={settings.providerConfig.translation.baseUrl} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference }, translation: { ...settings.providerConfig.translation, baseUrl: e.target.value } } })} /></label>
            <label className="field"><span>Translation API Key</span><input type="password" disabled={!settings.helperTranslationEnabled} value={settings.providerConfig.translation.apiKey || ''} onChange={(e) => patchSettings({ providerConfig: { inference: { ...settings.providerConfig.inference }, translation: { ...settings.providerConfig.translation, apiKey: e.target.value } } })} placeholder="optional" /></label>
            <label className="field"><span>STT Model</span><select value={settings.sttModel} onChange={(e) => patchSettings({ sttModel: e.target.value })}>{STT_MODELS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
            <div className="field-grid two-up">
              <label className="field"><span>Runtime Mode</span><select value={settings.sttRuntimeMode} onChange={(e) => patchSettings({ sttRuntimeMode: e.target.value === 'cpu' ? 'cpu' : e.target.value === 'cuda' ? 'cuda' : 'auto' })}><option value="cuda">cuda</option><option value="auto">auto</option><option value="cpu">cpu</option></select></label>
              <label className="field"><span>Audio Strategy</span><select value={settings.systemAudioStrategy} onChange={(e) => patchSettings({ systemAudioStrategy: e.target.value === 'manual' ? 'manual' : e.target.value === 'picker_each_start' ? 'picker_each_start' : 'auto_live' })}><option value="auto_live">auto live</option><option value="picker_each_start">picker each start</option><option value="manual">manual</option></select></label>
            </div>
            <div className="field-grid two-up">
              <label className="field inline-field"><span>Capture Mic</span><input type="checkbox" checked={settings.captureMicrophone} onChange={(e) => patchSettings({ captureMicrophone: e.target.checked })} /></label>
              <label className="field inline-field"><span>Auto-hide Control</span><input type="checkbox" checked={settings.autoHideControlWindow} onChange={(e) => patchSettings({ autoHideControlWindow: e.target.checked })} /></label>
            </div>
            <div className="chip-row"><button className="ghost-btn" disabled={refreshingSources} onClick={() => void refreshSources()}>{refreshingSources ? 'Refreshing...' : 'Refresh Sources'}</button><button className="ghost-btn" onClick={() => void window.api.redetectAudioSource()}>Redetect</button></div>
            {settings.systemAudioStrategy === 'manual' && <label className="field"><span>Manual Source</span><select value={selectedSystemSourceId || settings.manualSystemSourceId} onChange={(e) => { setSelectedSystemSourceId(e.target.value); patchSettings({ manualSystemSourceId: e.target.value, systemAudioMode: 'manual' }) }}><option value="">Select source</option>{audioSources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}</select></label>}
          </article>

          <article className="control-card persona-card">
            <div className="section-head"><div><div className="section-kicker">Persona</div><h2>Candidate Memory</h2></div><button className="ghost-btn" onClick={() => void refreshProfileState()}>Refresh</button></div>
            <label className="field"><span>GitHub Username</span><div className="inline-row"><input value={githubUsername} onChange={(e) => setGithubUsername(e.target.value)} placeholder="username" /><button className="ghost-btn" disabled={syncingGithub} onClick={() => void syncGithub()}>{syncingGithub ? 'Syncing...' : 'Sync'}</button></div></label>
            <label className="field"><span>CV Highlights</span><textarea value={cvInput} onChange={(e) => setCvInput(e.target.value)} /><button className="ghost-btn" onClick={() => void importText('cv', cvInput, () => setCvInput(''))}>Import CV</button></label>
            <label className="field"><span>Job Description</span><textarea value={jobDescInput} onChange={(e) => setJobDescInput(e.target.value)} /><button className="ghost-btn" onClick={() => void importText('job_desc', jobDescInput, () => setJobDescInput(''))}>Import JD</button></label>
            <label className="field"><span>Interview Notes</span><textarea value={noteInput} onChange={(e) => setNoteInput(e.target.value)} /><button className="ghost-btn" onClick={() => void importText('note', noteInput, () => setNoteInput(''))}>Import Notes</button></label>
            <div className="field-grid two-up compact-top"><label className="field"><span>File Type</span><select value={fileImportType} onChange={(e) => setFileImportType(e.target.value as ProfileSourceType)}>{Object.entries(SOURCE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="field action-field"><span>File Import</span><button className="ghost-btn" disabled={importingFile} onClick={() => void importFile()}>{importingFile ? 'Importing...' : 'Import File'}</button></div></div>
            <label className="field"><span>Context Preview Query</span><div className="inline-row"><input value={previewQuery} onChange={(e) => setPreviewQuery(e.target.value)} placeholder="kafka, failover, microservices..." /><button className="ghost-btn" onClick={() => void refreshProfileState()}>Preview</button></div></label>
            <div className="preview-list">{interviewContextPreview?.items.slice(0, 5).map((item) => <div className="preview-item" key={`${item.sourceId}-${item.score}`}><div className="preview-meta"><span>{SOURCE_LABEL[item.sourceType]}</span><span>{item.score.toFixed(2)}</span></div><div>{item.text}</div></div>)}</div>
            <div className="source-list">{profileSnapshot?.sources.slice(0, 8).map((source) => <div className="source-row" key={source.id}><div><strong>{source.name}</strong><div className="muted-line">{SOURCE_LABEL[source.type]} | {source.contentChars} chars</div></div><button className="ghost-btn tiny-btn" onClick={() => void window.api.clearProfileSource({ sourceId: source.id }).then(() => refreshProfileState())}>Remove</button></div>)}</div>
          </article>

          <article className="control-card practice-card">
            <div className="section-head"><div><div className="section-kicker">Practice</div><h2>Dry Run Answer</h2></div><div className="chip-row"><button className="ghost-btn" onClick={() => void exportHistory('json')}>Export JSON</button><button className="ghost-btn" onClick={() => void exportHistory('markdown')}>Export MD</button></div></div>
            <label className="field"><span>Mock Question</span><textarea value={practicePrompt} onChange={(e) => setPracticePrompt(e.target.value)} placeholder="Tell me about a time you stabilized a failing system..." /></label>
            <button className="primary-btn" onClick={() => void runPractice()}>Generate Practice Answer</button>
            <div className="section-head compact-top"><div><div className="section-kicker">Review Queue</div><h2>Saved Sessions</h2></div><button className="ghost-btn" disabled={refreshingHistory} onClick={() => void refreshHistory()}>{refreshingHistory ? 'Refreshing...' : 'Refresh'}</button></div>
            <div className="history-list">
              {historySessions.slice(0, 8).map((item) => (
                <div className="history-row" key={item.id}>
                  <div>
                    <strong>{new Date(item.startedAtMs).toLocaleString()}</strong>
                    <div className="muted-line">transcripts {item.transcriptCount} | assists {item.assistCount} | reviewed {item.reviewedCount}</div>
                    <div className="muted-line">chosen {item.chosenCount} | rejected {item.rejectedCount}</div>
                  </div>
                  <div className="chip-row">
                    <button className="ghost-btn tiny-btn" onClick={() => void loadHistoryDetail(item.id)}>{selectedHistorySessionId === item.id ? 'Opened' : 'Open'}</button>
                    <button className="ghost-btn tiny-btn" onClick={() => void exportHistory('json', item.id)}>JSON</button>
                    <button className="ghost-btn tiny-btn" onClick={() => void exportHistory('markdown', item.id)}>MD</button>
                  </div>
                </div>
              ))}
              {historySessions.length === 0 && <div className="empty-state">No saved sessions yet.</div>}
            </div>
            <div className="section-head compact-top">
              <div>
                <div className="section-kicker">Session Detail</div>
                <h2>{selectedHistorySummary ? new Date(selectedHistorySummary.startedAtMs).toLocaleString() : 'Choose a session'}</h2>
              </div>
              {selectedHistorySessionId && <div className="chip-row"><button className="ghost-btn tiny-btn" onClick={() => void exportHistory('json', selectedHistorySessionId)}>Export JSON</button><button className="ghost-btn tiny-btn" onClick={() => void exportHistory('markdown', selectedHistorySessionId)}>Export MD</button></div>}
            </div>
            {loadingHistoryDetail && <div className="empty-state">Loading session detail...</div>}
            {!loadingHistoryDetail && !selectedHistoryRecord && <div className="empty-state">Open a saved session to label chosen and rejected answers.</div>}
            {!loadingHistoryDetail && selectedHistoryRecord && (
              <div className="timeline-list">
                <div className="chip-row">
                  <span className="soft-chip">schema {selectedHistoryRecord.schemaVersion || 'session.v1'}</span>
                  <span className="soft-chip">assists {selectedHistoryRecord.assists.length}</span>
                  <span className="soft-chip">transcripts {selectedHistoryRecord.transcripts.length}</span>
                </div>
                {reviewedAssists.map((assist) => {
                  const label = reviewLabelOf(assist)
                  const availableTags = reviewTagsFor(label)
                  return (
                    <div className="timeline-row" key={assist.id}>
                      <div className="timeline-meta"><span className="soft-chip">{label}</span><span>{assist.state}</span><span>{assist.firstTokenMs ? `ttft ${Math.round(assist.firstTokenMs)} ms` : 'ttft n/a'}</span></div>
                      <div className="timeline-question">{assist.sourceText || 'Question unavailable.'}</div>
                      <div className="timeline-answer">{assist.answerEn || assist.rawText || '-'}</div>
                      {assist.contextLinesUsed && assist.contextLinesUsed.length > 0 && <div className="timeline-helper">{assist.contextLinesUsed.join(' | ')}</div>}
                      <div className="chip-row">
                        <button className="ghost-btn tiny-btn" disabled={savingReviewAssistId === assist.id} onClick={() => void updateAssistReview(assist.id, 'chosen', assist.reviewTags || [])}>Chosen</button>
                        <button className="ghost-btn tiny-btn" disabled={savingReviewAssistId === assist.id} onClick={() => void updateAssistReview(assist.id, 'rejected', assist.reviewTags || [])}>Rejected</button>
                        <button className="ghost-btn tiny-btn" disabled={savingReviewAssistId === assist.id} onClick={() => void updateAssistReview(assist.id, 'skipped', [])}>Skip</button>
                      </div>
                      {availableTags.length > 0 && <div className="chip-row">{availableTags.map((tag) => <button key={`${assist.id}-${tag}`} className={(assist.reviewTags || []).includes(tag) ? 'primary-btn tiny-btn' : 'ghost-btn tiny-btn'} disabled={savingReviewAssistId === assist.id} onClick={() => void toggleReviewTag(assist, tag)}>{tag}</button>)}</div>}
                    </div>
                  )
                })}
                {reviewedAssists.length === 0 && <div className="empty-state">No finalized assists in this session yet.</div>}
              </div>
            )}
          </article>
        </div>
      </section>
    </div>
  )
}

