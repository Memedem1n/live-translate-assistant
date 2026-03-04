import { useMemo } from 'react'
import { AssistEvent } from '../../../shared/contracts'
import { useAppStore } from '../store/useAppStore'

const VISIBLE_TRANSCRIPT_COUNT = 3
const VISIBLE_ASSIST_COUNT = 3

function pickAssistByTranscript(assistUpdates: AssistEvent[]): Map<string, AssistEvent> {
  const map = new Map<string, AssistEvent>()

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
}

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

export function OverlayView(): React.JSX.Element {
  const { transcripts, assistUpdates, session } = useAppStore()

  const assistByTranscript = useMemo(() => {
    return pickAssistByTranscript(assistUpdates)
  }, [assistUpdates])

  const transcriptFeed = useMemo(() => {
    return transcripts
      .filter((item) => item.speaker === 'remote')
      .slice(-VISIBLE_TRANSCRIPT_COUNT)
  }, [transcripts])

  const assistFeed = useMemo(() => {
    const finalRows = assistUpdates.filter((item) => item.state === 'final')
    const latestPartial = [...assistUpdates].reverse().find((item) => item.state === 'partial')

    if (!latestPartial) {
      return finalRows.slice(-VISIBLE_ASSIST_COUNT)
    }

    const carryFinalRows = finalRows
      .filter((item) => item.id !== latestPartial.id)
      .slice(-(VISIBLE_ASSIST_COUNT - 1))
    return [...carryFinalRows, latestPartial]
  }, [assistUpdates])

  const emptyState = useMemo(() => {
    if (transcriptFeed.length === 0 && assistFeed.length === 0) {
      return 'Dinleme baslayinca canli akis burada gorunecek.'
    }
    return null
  }, [assistFeed.length, transcriptFeed.length])

  const transcriptRows = useMemo(() => {
    return transcriptFeed.map((transcript) => {
      const assist = assistByTranscript.get(transcript.id)
      return {
        transcript,
        assist
      }
    })
  }, [assistByTranscript, transcriptFeed])

  const transcriptSlots = useMemo(() => {
    const rows = transcriptRows.slice(-VISIBLE_TRANSCRIPT_COUNT)
    const placeholders = Array.from({
      length: Math.max(0, VISIBLE_TRANSCRIPT_COUNT - rows.length)
    }).map(() => null)
    return [...placeholders, ...rows]
  }, [transcriptRows])

  const assistSlots = useMemo(() => {
    const rows = assistFeed.slice(-VISIBLE_ASSIST_COUNT)
    const placeholders = Array.from({
      length: Math.max(0, VISIBLE_ASSIST_COUNT - rows.length)
    }).map(() => null)
    return [...placeholders, ...rows]
  }, [assistFeed])

  return (
    <div className="overlay-root">
      <div className="overlay-island">
        <div className="overlay-head">
          <div className="overlay-label">Live</div>
          <div className="overlay-label">
            {session.phase}
            {session.muted ? ' | muted' : ''}
          </div>
        </div>

        <div className="overlay-history-grid">
          <div className="overlay-history-column">
            <div className="overlay-column-title">
              <span className="overlay-label">Son 3 Soru</span>
              <span className="overlay-label">{transcriptFeed.length}/3</span>
            </div>
            <div className="overlay-history-list">
              {transcriptSlots.map((entry, index) => {
                if (!entry) {
                  return (
                    <div
                      className="overlay-history-item overlay-history-item-placeholder"
                      key={`transcript-placeholder-${index}`}
                    >
                      <div className="overlay-empty">Bekleniyor...</div>
                    </div>
                  )
                }

                return (
                  <div className="overlay-history-item" key={`speech-${entry.transcript.id}`}>
                    <div className="overlay-line-top">
                      <span className="badge remote">remote</span>
                      <span className="overlay-label">
                        {(entry.transcript.language || 'unknown').toUpperCase()}
                      </span>
                      <span className="overlay-label">
                        {new Date(entry.transcript.emittedMs).toLocaleTimeString()}
                      </span>
                    </div>
                    <div className="overlay-text">
                      {entry.transcript.text || entry.transcript.textEn || '-'}
                    </div>
                    {entry.assist?.translationTr && (
                      <div className="overlay-subtext">{entry.assist.translationTr}</div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div className="overlay-history-column">
            <div className="overlay-column-title">
              <span className="overlay-label">Son 3 Assist</span>
              <span className="overlay-label">
                {assistFeed.filter((item) => item.state === 'final').length}
                {assistFeed.some((item) => item.state === 'partial') ? '+canli' : ''}
                /3
              </span>
            </div>
            <div className="overlay-history-list">
              {assistSlots.map((item, index) => {
                if (!item) {
                  return (
                    <div
                      className="overlay-history-item overlay-history-item-placeholder"
                      key={`assist-placeholder-${index}`}
                    >
                      <div className="overlay-empty">Bekleniyor...</div>
                    </div>
                  )
                }

                return (
                  <div
                    className={`overlay-history-item reply-line ${item.state === 'partial' ? 'overlay-live-row' : ''}`}
                    key={item.id}
                  >
                    <div className="overlay-line-top">
                      <span className="badge remote">assistant</span>
                      <span className="overlay-label">{Math.round(item.latencyMs)} ms</span>
                      {item.state === 'partial' && <span className="overlay-live-badge">CANLI</span>}
                      {item.personalizationMode && (
                        <span className="overlay-label">{item.personalizationMode}</span>
                      )}
                    </div>
                    <div className="overlay-text">{assistPrimaryText(item)}</div>
                    <div className="overlay-subtext">{assistSecondaryText(item)}</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {emptyState && (
          <div className="overlay-empty overlay-empty-note">
            {emptyState}
          </div>
        )}
      </div>
    </div>
  )
}
