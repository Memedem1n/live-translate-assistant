import { useMemo, useState } from 'react'
import {
  AppSettings,
  AssistEvent,
  AudioSourceItem,
  CaptureDiagnosticsEvent,
  SessionStateEvent,
  TranscriptEvent
} from '../../../../shared/contracts'
import {
  CapturePhase,
  PROFILE_PRESETS,
  STT_MODELS,
  findAssistForTranscript,
  formatTime,
  getCaptureStatusLabel,
  getSessionIssueMessage,
  helperAnswer,
  mainAnswer
} from './shared'

interface LiveTabProps {
  settings: AppSettings
  session: SessionStateEvent
  audioSources: AudioSourceItem[]
  selectedSystemSourceId: string
  activeSourceLabel: string
  capturePhase: CapturePhase
  captureDiagnostics: CaptureDiagnosticsEvent | null
  activeQuestion: TranscriptEvent | null
  activeAssist: AssistEvent | null
  timeline: TranscriptEvent[]
  assistUpdates: AssistEvent[]
  error: string | null
  infoMessage: string | null
  refreshingSources: boolean
  redetectingAudio: boolean
  sessionLabel: string
  onPatchSettings: (updates: Partial<AppSettings>) => void
  onSetSelectedSystemSourceId: (id: string) => void
  onRefreshSources: () => Promise<void>
  onRedetectAudioSource: (promptUser?: boolean) => Promise<boolean>
  onStartSession: () => Promise<void>
  onStopSession: () => Promise<void>
  onToggleMute: () => Promise<void>
  onToggleOverlay: () => Promise<void>
  onOpenAdvanced: () => void
}

export function LiveTab(props: LiveTabProps): React.JSX.Element {
  const {
    settings,
    session,
    audioSources,
    selectedSystemSourceId,
    activeSourceLabel,
    capturePhase,
    captureDiagnostics,
    activeQuestion,
    activeAssist,
    timeline,
    assistUpdates,
    error,
    infoMessage,
    refreshingSources,
    redetectingAudio,
    sessionLabel,
    onPatchSettings,
    onSetSelectedSystemSourceId,
    onRefreshSources,
    onRedetectAudioSource,
    onStartSession,
    onStopSession,
    onToggleMute,
    onToggleOverlay,
    onOpenAdvanced
  } = props

  const [showTranscript, setShowTranscript] = useState(false)
  const currentPreset = useMemo(
    () => PROFILE_PRESETS.find((item) => item.id === settings.inferenceProfileId) || PROFILE_PRESETS[0],
    [settings.inferenceProfileId]
  )
  const captureLabel = useMemo(
    () => getCaptureStatusLabel(capturePhase, captureDiagnostics),
    [captureDiagnostics, capturePhase]
  )
  const statusMessage = useMemo(
    () => getSessionIssueMessage(session, capturePhase, captureDiagnostics, error),
    [captureDiagnostics, capturePhase, error, session]
  )

  return (
    <div className="tab-grid tab-grid-live">
      <div className="stack-lg">
        <section className="panel panel-hero">
          <div className="hero-copy-block">
            <div className="eyebrow">Live Interview</div>
            <h1>Stay focused on the answer, not the interface.</h1>
            <p>
              Keep the panel simple while the assistant listens, translates, and drafts a stronger
              response in the background.
            </p>
          </div>
          <div className="hero-actions">
            <button className="primary-btn large-btn" disabled={session.active} onClick={() => void onStartSession()}>
              Start Live
            </button>
            <button className="secondary-btn" disabled={!session.active} onClick={() => void onStopSession()}>
              Stop
            </button>
            <button className="ghost-btn" onClick={() => void onToggleMute()}>
              {session.muted ? 'Unmute' : 'Mute'}
            </button>
            <button className="ghost-btn" onClick={() => void onToggleOverlay()}>
              {settings.overlayVisible ? 'Hide Overlay' : 'Show Overlay'}
            </button>
            <button className="ghost-btn" onClick={onOpenAdvanced}>
              Advanced
            </button>
          </div>
        </section>

        <section className="panel teleprompter-panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Speak This</div>
              <h2>Suggested answer</h2>
            </div>
            <div className="status-group">
              <span className="status-pill status-live">{sessionLabel}</span>
              <span className="status-pill">{captureLabel}</span>
            </div>
          </div>
          <div className="teleprompter-answer">{mainAnswer(activeAssist)}</div>
          <div className="helper-strip">
            <span className="helper-label">Helper</span>
            <p>{settings.helperTranslationEnabled ? helperAnswer(activeAssist) : 'Turkish helper is turned off.'}</p>
          </div>
          <div className="question-card">
            <span className="question-label">Latest question</span>
            <p>{activeQuestion?.text || 'Waiting for interviewer audio...'}</p>
          </div>
        </section>

        <section className="panel transcript-panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Transcript</div>
              <h2>Recent turns</h2>
            </div>
            <button className="ghost-btn tiny-btn" onClick={() => setShowTranscript((value) => !value)}>
              {showTranscript ? 'Hide details' : 'Show details'}
            </button>
          </div>
          {!showTranscript && (
            <div className="simple-transcript-preview">
              {timeline.slice(0, 3).map((item) => (
                <div className="simple-transcript-row" key={item.id}>
                  <span>{item.speaker === 'remote' ? 'Question' : 'You'}</span>
                  <strong>{item.text}</strong>
                </div>
              ))}
              {timeline.length === 0 && <div className="empty-state">Transcript will appear here during the session.</div>}
            </div>
          )}
          {showTranscript && (
            <div className="timeline-list timeline-compact">
              {timeline.length === 0 && <div className="empty-state">Transcript will appear here during the session.</div>}
              {timeline.map((item) => {
                const assist = findAssistForTranscript(assistUpdates, item.id)
                return (
                  <div className="timeline-row timeline-row-clean" key={item.id}>
                    <div className="timeline-meta">
                      <span className={`speaker-badge speaker-${item.speaker}`}>
                        {item.speaker === 'remote' ? 'Question' : 'You'}
                      </span>
                      <span>{formatTime(item.emittedMs)}</span>
                    </div>
                    <div className="timeline-question">{item.text}</div>
                    {assist && <div className="timeline-answer">{mainAnswer(assist)}</div>}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <aside className="stack-md">
        <section className="panel quick-setup-panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Session Setup</div>
              <h2>Simple controls</h2>
            </div>
          </div>

          <label className="field">
            <span>Answer profile</span>
            <select
              value={settings.inferenceProfileId}
              onChange={(event) => {
                const next = PROFILE_PRESETS.find((item) => item.id === event.target.value) || PROFILE_PRESETS[0]
                onPatchSettings({
                  inferenceProfileId: next.id,
                  providerConfig: {
                    inference: { ...settings.providerConfig.inference, model: next.model },
                    translation: { ...settings.providerConfig.translation }
                  }
                })
              }}
            >
              {PROFILE_PRESETS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Speech recognition</span>
            <select
              value={settings.sttModel}
              onChange={(event) => onPatchSettings({ sttModel: event.target.value })}
            >
              {STT_MODELS.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Audio source mode</span>
            <select
              value={settings.systemAudioStrategy}
              onChange={(event) =>
                onPatchSettings({
                  systemAudioStrategy: event.target.value === 'manual' ? 'manual' : 'picker_each_start'
                })
              }
            >
              <option value="picker_each_start">Ask me each time</option>
              <option value="manual">Use a fixed source</option>
            </select>
          </label>

          {settings.systemAudioStrategy === 'manual' && (
            <label className="field">
              <span>Fixed source</span>
              <select
                value={selectedSystemSourceId || settings.manualSystemSourceId}
                onChange={(event) => {
                  onSetSelectedSystemSourceId(event.target.value)
                  onPatchSettings({
                    manualSystemSourceId: event.target.value,
                    systemAudioMode: 'manual'
                  })
                }}
              >
                <option value="">Select source</option>
                {audioSources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="inline-toggle">
            <span>Turkish helper</span>
            <input
              type="checkbox"
              checked={settings.helperTranslationEnabled}
              onChange={(event) =>
                onPatchSettings({
                  helperTranslationEnabled: event.target.checked,
                  providerConfig: {
                    inference: { ...settings.providerConfig.inference },
                    translation: {
                      ...settings.providerConfig.translation,
                      enabled: event.target.checked
                    }
                  }
                })
              }
            />
          </label>
        </section>

        <section className="panel session-overview-panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Status</div>
              <h2>What is active now</h2>
            </div>
          </div>
          <div className="summary-list">
            <div className="summary-row">
              <span>State</span>
              <strong>{sessionLabel}</strong>
            </div>
            <div className="summary-row">
              <span>Answer profile</span>
              <strong>{currentPreset.title}</strong>
            </div>
            <div className="summary-row">
              <span>Listening source</span>
              <strong>{activeSourceLabel}</strong>
            </div>
            <div className="summary-row">
              <span>Overlay</span>
              <strong>{settings.overlayVisible ? 'Visible' : 'Hidden'}</strong>
            </div>
          </div>
          <div className="inline-actions">
            <button className="ghost-btn" disabled={refreshingSources} onClick={() => void onRefreshSources()}>
              {refreshingSources ? 'Refreshing...' : 'Refresh sources'}
            </button>
            <button className="ghost-btn" disabled={redetectingAudio || !session.active} onClick={() => void onRedetectAudioSource(true)}>
              {redetectingAudio ? 'Selecting...' : 'Change source'}
            </button>
          </div>
          {statusMessage && <div className="warning-note compact-note">{statusMessage}</div>}
          {infoMessage && <div className="info-note compact-note">{infoMessage}</div>}
        </section>
      </aside>
    </div>
  )
}
