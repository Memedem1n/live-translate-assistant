import {
  AppSettings,
  AssistEvent,
  HistorySessionSummary,
  InterviewContextPreview,
  ProfileSnapshot,
  ProfileSourceType,
  ProfileSyncStatus,
  ReviewLabel,
  SessionHistoryRecord
} from '../../../../shared/contracts'
import {
  IMPORTABLE_SOURCE_TYPES,
  SOURCE_LABEL,
  formatTime,
  reviewLabelOf,
  reviewTagsFor
} from './shared'

interface PrepareTabProps {
  settings: AppSettings
  profileSnapshot: ProfileSnapshot | null
  profileSyncStatus: ProfileSyncStatus | null
  interviewContextPreview: InterviewContextPreview | null
  historyEncryptionAvailable: boolean
  historySessions: HistorySessionSummary[]
  selectedHistorySessionId: string
  selectedHistorySummary: HistorySessionSummary | null
  selectedHistoryRecord: SessionHistoryRecord | null
  reviewedAssists: AssistEvent[]
  githubUsername: string
  cvInput: string
  jobDescInput: string
  noteInput: string
  previewQuery: string
  fileImportType: ProfileSourceType
  syncingGithub: boolean
  importingFile: boolean
  refreshingHistory: boolean
  loadingHistoryDetail: boolean
  savingReviewAssistId: string | null
  infoMessage: string | null
  error: string | null
  onPatchSettings: (updates: Partial<AppSettings>) => void
  onSetGithubUsername: (value: string) => void
  onSetCvInput: (value: string) => void
  onSetJobDescInput: (value: string) => void
  onSetNoteInput: (value: string) => void
  onSetPreviewQuery: (value: string) => void
  onSetFileImportType: (value: ProfileSourceType) => void
  onRefreshProfileState: () => Promise<void>
  onSyncGithub: () => Promise<void>
  onImportText: (type: ProfileSourceType, content: string, clear: () => void) => Promise<void>
  onImportFile: () => Promise<void>
  onClearSource: (sourceId: string) => Promise<void>
  onRefreshHistory: () => Promise<void>
  onLoadHistoryDetail: (sessionId: string) => Promise<void>
  onExportHistory: (format: 'json' | 'markdown', sessionId?: string) => Promise<void>
  onUpdateAssistReview: (
    assistId: string,
    reviewLabel: ReviewLabel,
    reviewTags?: string[]
  ) => Promise<void>
  onToggleReviewTag: (assist: AssistEvent, tag: string) => Promise<void>
}

export function PrepareTab(props: PrepareTabProps): React.JSX.Element {
  const {
    settings,
    profileSnapshot,
    profileSyncStatus,
    interviewContextPreview,
    historyEncryptionAvailable,
    historySessions,
    selectedHistorySessionId,
    selectedHistorySummary,
    selectedHistoryRecord,
    reviewedAssists,
    githubUsername,
    cvInput,
    jobDescInput,
    noteInput,
    previewQuery,
    fileImportType,
    syncingGithub,
    importingFile,
    refreshingHistory,
    loadingHistoryDetail,
    savingReviewAssistId,
    infoMessage,
    error,
    onPatchSettings,
    onSetGithubUsername,
    onSetCvInput,
    onSetJobDescInput,
    onSetNoteInput,
    onSetPreviewQuery,
    onSetFileImportType,
    onRefreshProfileState,
    onSyncGithub,
    onImportText,
    onImportFile,
    onClearSource,
    onRefreshHistory,
    onLoadHistoryDetail,
    onExportHistory,
    onUpdateAssistReview,
    onToggleReviewTag
  } = props

  return (
    <div className="tab-grid tab-grid-prepare">
      <div className="stack-lg">
        <section className="panel panel-hero compact-hero">
          <div className="hero-copy-block">
            <div className="eyebrow">Prepare</div>
            <h1>Load your background before the interview starts.</h1>
            <p>
              Keep your profile, job description, and notes ready so answers stay grounded and
              personal.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Assistant Memory</div>
              <h2>Readiness</h2>
            </div>
            <button className="ghost-btn tiny-btn" onClick={() => void onRefreshProfileState()}>
              Refresh
            </button>
          </div>

          <div className="settings-card-grid">
            <label className="inline-toggle card-toggle">
              <span>
                <strong>Use imported profile</strong>
                <small>Answers should use your CV, notes, and synced context.</small>
              </span>
              <input
                type="checkbox"
                checked={settings.personalizationEnabled}
                onChange={(event) => onPatchSettings({ personalizationEnabled: event.target.checked })}
              />
            </label>
            <label className="inline-toggle card-toggle">
              <span>
                <strong>Save interview history</strong>
                <small>{historyEncryptionAvailable ? 'Saved locally with encryption support.' : 'Saved locally in app storage.'}</small>
              </span>
              <input
                type="checkbox"
                checked={settings.historyOptIn}
                onChange={(event) => onPatchSettings({ historyOptIn: event.target.checked })}
              />
            </label>
          </div>

          {profileSyncStatus?.message && <div className="info-note compact-note">{profileSyncStatus.message}</div>}
          {infoMessage && <div className="info-note compact-note">{infoMessage}</div>}
          {error && <div className="warning-note compact-note">{error}</div>}
        </section>

        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Imports</div>
              <h2>Profile sources</h2>
            </div>
          </div>

          <div className="prepare-form-grid">
            <label className="field">
              <span>GitHub username</span>
              <div className="inline-row">
                <input
                  value={githubUsername}
                  onChange={(event) => onSetGithubUsername(event.target.value)}
                  placeholder="your-username"
                />
                <button className="ghost-btn" disabled={syncingGithub} onClick={() => void onSyncGithub()}>
                  {syncingGithub ? 'Syncing...' : 'Sync'}
                </button>
              </div>
            </label>

            <label className="field">
              <span>CV highlights</span>
              <textarea value={cvInput} onChange={(event) => onSetCvInput(event.target.value)} />
              <button className="secondary-btn" onClick={() => void onImportText('cv', cvInput, () => onSetCvInput(''))}>
                Import CV
              </button>
            </label>

            <label className="field">
              <span>Job description</span>
              <textarea value={jobDescInput} onChange={(event) => onSetJobDescInput(event.target.value)} />
              <button
                className="secondary-btn"
                onClick={() => void onImportText('job_desc', jobDescInput, () => onSetJobDescInput(''))}
              >
                Import job description
              </button>
            </label>

            <label className="field">
              <span>Interview notes</span>
              <textarea value={noteInput} onChange={(event) => onSetNoteInput(event.target.value)} />
              <button className="secondary-btn" onClick={() => void onImportText('note', noteInput, () => onSetNoteInput(''))}>
                Import notes
              </button>
            </label>

            <div className="field file-import-card">
              <span>Import from file</span>
              <div className="inline-row">
                <select value={fileImportType} onChange={(event) => onSetFileImportType(event.target.value as ProfileSourceType)}>
                  {IMPORTABLE_SOURCE_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SOURCE_LABEL[type]}
                    </option>
                  ))}
                </select>
                <button className="ghost-btn" disabled={importingFile} onClick={() => void onImportFile()}>
                  {importingFile ? 'Importing...' : 'Choose file'}
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Assistant Context</div>
              <h2>What the assistant knows</h2>
            </div>
          </div>

          <label className="field">
            <span>Preview query</span>
            <div className="inline-row">
              <input
                value={previewQuery}
                onChange={(event) => onSetPreviewQuery(event.target.value)}
                placeholder="kafka, failover, payments, latency..."
              />
              <button className="ghost-btn" onClick={() => void onRefreshProfileState()}>
                Preview
              </button>
            </div>
          </label>

          <div className="preview-list">
            {interviewContextPreview?.items.slice(0, 5).map((item) => (
              <div className="preview-item" key={`${item.sourceId}-${item.score}`}>
                <div className="preview-meta">
                  <span>{SOURCE_LABEL[item.sourceType]}</span>
                  <span>{item.score.toFixed(2)}</span>
                </div>
                <div>{item.text}</div>
              </div>
            ))}
            {!interviewContextPreview?.items.length && (
              <div className="empty-state">Import profile sources to preview grounded context.</div>
            )}
          </div>

          <div className="source-list source-list-compact">
            {profileSnapshot?.sources.slice(0, 10).map((source) => (
              <div className="source-row source-row-clean" key={source.id}>
                <div>
                  <strong>{source.name}</strong>
                  <div className="muted-line">
                    {SOURCE_LABEL[source.type]} • {source.contentChars} chars
                  </div>
                </div>
                <button className="ghost-btn tiny-btn" onClick={() => void onClearSource(source.id)}>
                  Remove
                </button>
              </div>
            ))}
            {!profileSnapshot?.sources.length && (
              <div className="empty-state">No imported sources yet.</div>
            )}
          </div>
        </section>
      </div>

      <aside className="stack-md">
        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">History</div>
              <h2>Past sessions</h2>
            </div>
            <div className="inline-actions">
              <button className="ghost-btn tiny-btn" disabled={refreshingHistory} onClick={() => void onRefreshHistory()}>
                {refreshingHistory ? 'Refreshing...' : 'Refresh'}
              </button>
              <button className="ghost-btn tiny-btn" onClick={() => void onExportHistory('json')}>
                Export JSON
              </button>
              <button className="ghost-btn tiny-btn" onClick={() => void onExportHistory('markdown')}>
                Export MD
              </button>
            </div>
          </div>

          <div className="history-list history-list-clean">
            {historySessions.slice(0, 8).map((item) => (
              <button
                key={item.id}
                className={`history-card ${selectedHistorySessionId === item.id ? 'history-card-active' : ''}`}
                onClick={() => void onLoadHistoryDetail(item.id)}
              >
                <div className="history-card-head">
                  <strong>{new Date(item.startedAtMs).toLocaleString()}</strong>
                  <span>{selectedHistorySessionId === item.id ? 'Open' : 'View'}</span>
                </div>
                <div className="history-card-meta">
                  <span>{item.transcriptCount} turns</span>
                  <span>{item.assistCount} answers</span>
                  <span>{item.reviewedCount} reviewed</span>
                </div>
              </button>
            ))}
            {historySessions.length === 0 && <div className="empty-state">No saved sessions yet.</div>}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Selected Session</div>
              <h2>{selectedHistorySummary ? new Date(selectedHistorySummary.startedAtMs).toLocaleString() : 'Choose a session'}</h2>
            </div>
            {selectedHistorySessionId && (
              <div className="inline-actions">
                <button className="ghost-btn tiny-btn" onClick={() => void onExportHistory('json', selectedHistorySessionId)}>
                  JSON
                </button>
                <button className="ghost-btn tiny-btn" onClick={() => void onExportHistory('markdown', selectedHistorySessionId)}>
                  MD
                </button>
              </div>
            )}
          </div>

          {loadingHistoryDetail && <div className="empty-state">Loading session detail...</div>}
          {!loadingHistoryDetail && !selectedHistoryRecord && (
            <div className="empty-state">Pick a session to inspect and label answers.</div>
          )}
          {!loadingHistoryDetail && selectedHistoryRecord && (
            <div className="stack-md">
              <div className="summary-list">
                <div className="summary-row">
                  <span>Started</span>
                  <strong>{formatTime(selectedHistoryRecord.startedAtMs)}</strong>
                </div>
                <div className="summary-row">
                  <span>Answers</span>
                  <strong>{selectedHistoryRecord.assists.length}</strong>
                </div>
                <div className="summary-row">
                  <span>Turns</span>
                  <strong>{selectedHistoryRecord.transcripts.length}</strong>
                </div>
              </div>

              <div className="timeline-list timeline-compact">
                {reviewedAssists.map((assist) => {
                  const label = reviewLabelOf(assist)
                  const availableTags = reviewTagsFor(label)
                  return (
                    <div className="timeline-row timeline-row-clean" key={assist.id}>
                      <div className="timeline-meta">
                        <span className="soft-chip">{label}</span>
                        <span>{assist.firstTokenMs ? `${Math.round(assist.firstTokenMs)} ms` : 'n/a'}</span>
                      </div>
                      <div className="timeline-question">{assist.sourceText || 'Question unavailable.'}</div>
                      <div className="timeline-answer">{assist.answerEn || assist.rawText || '-'}</div>
                      <div className="chip-row">
                        <button
                          className="ghost-btn tiny-btn"
                          disabled={savingReviewAssistId === assist.id}
                          onClick={() => void onUpdateAssistReview(assist.id, 'chosen', assist.reviewTags || [])}
                        >
                          Chosen
                        </button>
                        <button
                          className="ghost-btn tiny-btn"
                          disabled={savingReviewAssistId === assist.id}
                          onClick={() => void onUpdateAssistReview(assist.id, 'rejected', assist.reviewTags || [])}
                        >
                          Rejected
                        </button>
                        <button
                          className="ghost-btn tiny-btn"
                          disabled={savingReviewAssistId === assist.id}
                          onClick={() => void onUpdateAssistReview(assist.id, 'skipped', [])}
                        >
                          Skip
                        </button>
                      </div>
                      {availableTags.length > 0 && (
                        <div className="chip-row">
                          {availableTags.map((tag) => (
                            <button
                              key={`${assist.id}-${tag}`}
                              className={(assist.reviewTags || []).includes(tag) ? 'secondary-btn tiny-btn' : 'ghost-btn tiny-btn'}
                              disabled={savingReviewAssistId === assist.id}
                              onClick={() => void onToggleReviewTag(assist, tag)}
                            >
                              {tag}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
                {reviewedAssists.length === 0 && (
                  <div className="empty-state">No finalized answers in this session yet.</div>
                )}
              </div>
            </div>
          )}
        </section>
      </aside>
    </div>
  )
}
