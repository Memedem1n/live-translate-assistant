import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'
import { getActiveQuestion, getLatestAssist, helperAnswer, mainAnswer } from './control/shared'

function sessionSurfaceLabel(active: boolean, muted: boolean, phase: string): string {
  if (!active && phase === 'idle') return 'Ready'
  if (phase === 'starting') return 'Starting'
  if (phase === 'stopping') return 'Stopping'
  if (phase === 'error') return 'Needs attention'
  if (muted) return 'Muted'
  return 'Live'
}

function responseStatusLabel(
  phase: string,
  active: boolean,
  firstTokenMs: number | null | undefined
): string {
  if (typeof firstTokenMs === 'number' && Number.isFinite(firstTokenMs) && firstTokenMs > 0) {
    return `${Math.round(firstTokenMs)} ms`
  }
  if (phase === 'starting') return 'Warming'
  if (phase === 'stopping') return 'Stopping'
  if (phase === 'error') return 'Needs attention'
  if (active && (phase === 'running' || phase === 'degraded')) return 'Ready'
  return 'Standby'
}

export function OverlayView(): React.JSX.Element {
  const { transcripts, assistUpdates, session, settings } = useAppStore()
  const helperEnabled = settings?.helperTranslationEnabled !== false

  const latestQuestion = useMemo(() => getActiveQuestion(transcripts), [transcripts])
  const latestAssist = useMemo(() => getLatestAssist(assistUpdates), [assistUpdates])
  const recentQuestions = useMemo(
    () => transcripts.filter((item) => item.speaker === 'remote').slice(-2).reverse(),
    [transcripts]
  )

  return (
    <div className="overlay-root">
      <div className="overlay-surface">
        <div className="overlay-topline">
          <div>
            <div className="overlay-eyebrow">Interview Copilot</div>
            <div className="overlay-mode">
              {sessionSurfaceLabel(session.active, session.muted, session.phase)}
            </div>
          </div>
          <div className="overlay-status-stack">
            <span className="overlay-chip">{helperEnabled ? 'TR helper on' : 'TR helper off'}</span>
            <span className="overlay-chip">
              {responseStatusLabel(session.phase, session.active, latestAssist?.firstTokenMs)}
            </span>
          </div>
        </div>

        <section className="overlay-question-panel">
          <span className="overlay-section-label">Question</span>
          <p>{latestQuestion?.text || 'Waiting for interviewer audio...'}</p>
        </section>

        <section className="overlay-answer-panel">
          <span className="overlay-section-label">Speak this</span>
          <div className="overlay-answer-copy">{mainAnswer(latestAssist)}</div>
          {helperEnabled && (
            <div className="overlay-helper-copy">{helperAnswer(latestAssist)}</div>
          )}
        </section>

        {recentQuestions.length > 0 && (
          <section className="overlay-recent-panel">
            <span className="overlay-section-label">Recent questions</span>
            <div className="overlay-recent-list">
              {recentQuestions.map((item) => (
                <div className="overlay-recent-item" key={item.id}>
                  {item.text}
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
