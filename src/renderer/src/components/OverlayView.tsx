import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'

function mainAnswer(value?: string): string {
  return value || '-'
}

export function OverlayView(): React.JSX.Element {
  const { transcripts, assistUpdates, session } = useAppStore()

  const latestQuestion = useMemo(() => {
    return [...transcripts].reverse().find((item) => item.speaker === 'remote') || null
  }, [transcripts])

  const latestAssist = useMemo(() => {
    return [...assistUpdates].reverse().find((item) => item.state !== 'error') || null
  }, [assistUpdates])

  const previousQuestions = useMemo(() => {
    return transcripts.filter((item) => item.speaker === 'remote').slice(-3).reverse()
  }, [transcripts])

  return (
    <div className="overlay-root">
      <div className="overlay-island interview-island">
        <div className="overlay-head">
          <div className="overlay-label">Interview Live</div>
          <div className="overlay-chip-row">
            <span className="overlay-label">{session.phase}</span>
            <span className="overlay-label">{session.muted ? 'muted' : 'active'}</span>
            <span className="overlay-label">{latestAssist?.firstTokenMs ? `${Math.round(latestAssist.firstTokenMs)} ms` : 'warming'}</span>
          </div>
        </div>

        <div className="overlay-question-card">
          <span className="overlay-section-label">Latest Question</span>
          <div className="overlay-text emphasis">{latestQuestion?.text || 'Waiting for interviewer audio...'}</div>
          {latestAssist?.questionTr && <div className="overlay-subtext">{latestAssist.questionTr}</div>}
        </div>

        <div className="overlay-answer-card">
          <span className="overlay-section-label">Speak This</span>
          <div className="overlay-text answer-main">{mainAnswer(latestAssist?.answerEn)}</div>
          {latestAssist?.helperAnswerTr && <div className="overlay-subtext answer-helper">{latestAssist.helperAnswerTr}</div>}
        </div>

        <div className="overlay-footer-grid">
          <div className="overlay-mini-card">
            <span className="overlay-section-label">Risk</span>
            <div className="overlay-text small">{(latestAssist?.supportSignals?.riskFlags || []).join(', ') || 'clear'}</div>
          </div>
          <div className="overlay-mini-card">
            <span className="overlay-section-label">Context</span>
            <div className="overlay-text small">{latestAssist?.supportSignals?.contextHitCount ?? 0} hits</div>
          </div>
          <div className="overlay-mini-card">
            <span className="overlay-section-label">Confidence</span>
            <div className="overlay-text small">{latestAssist?.supportSignals?.confidenceBand || 'medium'}</div>
          </div>
        </div>

        <div className="overlay-history-strip">
          {previousQuestions.map((item) => (
            <div className="overlay-history-pill" key={item.id}>{item.text}</div>
          ))}
        </div>
      </div>
    </div>
  )
}
