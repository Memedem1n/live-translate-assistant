import { useEffect, useMemo, useRef } from 'react'
import { AssistEvent } from '../../../shared/contracts'
import { useAppStore } from '../store/useAppStore'

interface OverlayLine {
  key: string
  type: 'speech' | 'reply'
  speaker: 'remote' | 'self' | 'assistant'
  textEn: string
  textTr: string
}

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

export function OverlayView(): React.JSX.Element {
  const { transcripts, assistUpdates, session } = useAppStore()
  const streamRef = useRef<HTMLDivElement | null>(null)

  const lines = useMemo(() => {
    const assistByTranscript = pickAssistByTranscript(assistUpdates)
    const recentTranscripts = transcripts.slice(-14)
    const rendered: OverlayLine[] = []

    for (const transcript of recentTranscripts) {
      const assist = assistByTranscript.get(transcript.id)

      rendered.push({
        key: `speech-${transcript.id}`,
        type: 'speech',
        speaker: transcript.speaker,
        textEn: transcript.textEn,
        textTr: assist?.translationTr || ''
      })

      if (assist && (assist.replyEn || assist.replyTr || assist.rawText)) {
        rendered.push({
          key: `reply-${assist.id}`,
          type: 'reply',
          speaker: 'assistant',
          textEn: assist.replyEn || assist.rawText || '',
          textTr: assist.replyTr || ''
        })
      }
    }

    return rendered
  }, [assistUpdates, transcripts])

  useEffect(() => {
    if (!streamRef.current) return
    streamRef.current.scrollTop = streamRef.current.scrollHeight
  }, [lines])

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

        <div className="overlay-stream" ref={streamRef}>
          {lines.length === 0 && (
            <div className="overlay-empty">Dinleme baslayinca EN/TR akis burada gorunecek.</div>
          )}

          {lines.map((line) => (
            <div
              className={`overlay-line ${line.type === 'reply' ? 'reply-line' : ''}`}
              key={line.key}
            >
              <div className="overlay-line-top">
                <span className={`badge ${line.speaker === 'assistant' ? 'remote' : line.speaker}`}>
                  {line.speaker}
                </span>
                <span className="overlay-label">{line.type === 'reply' ? 'reply' : 'speech'}</span>
              </div>

              <div className="overlay-columns">
                <div className="overlay-col">
                  <div className="overlay-label">EN</div>
                  <div className="overlay-text">{line.textEn || '-'}</div>
                </div>
                <div className="overlay-col">
                  <div className="overlay-label">TR</div>
                  <div className="overlay-text">{line.textTr || '-'}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
