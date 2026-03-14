import { AssistEvent, SessionStateEvent, TranscriptEvent } from '../../../../shared/contracts'
import { helperAnswer, mainAnswer } from './shared'

interface PracticeTabProps {
  session: SessionStateEvent
  practicePrompt: string
  activeQuestion: TranscriptEvent | null
  activeAssist: AssistEvent | null
  infoMessage: string | null
  error: string | null
  onSetPracticePrompt: (value: string) => void
  onRunPractice: () => Promise<void>
}

const SAMPLE_PROMPTS = [
  'How would you explain eventual consistency in a system design interview?',
  'Tell me about a time you stabilized a production incident.',
  'How would you improve API latency for a read-heavy service?'
]

export function PracticeTab(props: PracticeTabProps): React.JSX.Element {
  const {
    session,
    practicePrompt,
    activeQuestion,
    activeAssist,
    infoMessage,
    error,
    onSetPracticePrompt,
    onRunPractice
  } = props

  return (
    <div className="tab-grid tab-grid-practice">
      <div className="stack-lg">
        <section className="panel panel-hero compact-hero">
          <div className="hero-copy-block">
            <div className="eyebrow">Practice</div>
            <h1>Try questions before the real interview starts.</h1>
            <p>
              Write a mock question, generate a suggested answer, and tune your speaking rhythm
              without opening a live session.
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Prompt</div>
              <h2>Ask a mock question</h2>
            </div>
          </div>
          <label className="field">
            <span>Mock question</span>
            <textarea
              className="practice-textarea"
              value={practicePrompt}
              onChange={(event) => onSetPracticePrompt(event.target.value)}
              placeholder="How would you explain the tradeoff between throughput and latency in a distributed service?"
            />
          </label>
          <div className="chip-row">
            {SAMPLE_PROMPTS.map((item) => (
              <button key={item} className="ghost-btn tiny-btn" onClick={() => onSetPracticePrompt(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="inline-actions">
            <button className="primary-btn" disabled={session.active || !practicePrompt.trim()} onClick={() => void onRunPractice()}>
              Generate Practice Answer
            </button>
            {session.active && <span className="inline-note">Stop the live session before using practice mode.</span>}
          </div>
          {error && <div className="warning-note compact-note">{error}</div>}
          {infoMessage && <div className="info-note compact-note">{infoMessage}</div>}
        </section>
      </div>

      <aside className="stack-md">
        <section className="panel teleprompter-panel practice-answer-panel">
          <div className="panel-head compact-panel-head">
            <div>
              <div className="section-kicker">Answer Preview</div>
              <h2>Practice output</h2>
            </div>
          </div>
          <div className="question-card practice-question-card">
            <span className="question-label">Latest practice question</span>
            <p>{activeQuestion?.text || 'Generate a practice answer to see it here.'}</p>
          </div>
          <div className="teleprompter-answer practice-answer-copy">{mainAnswer(activeAssist)}</div>
          <div className="helper-strip">
            <span className="helper-label">Helper</span>
            <p>{helperAnswer(activeAssist)}</p>
          </div>
        </section>
      </aside>
    </div>
  )
}
