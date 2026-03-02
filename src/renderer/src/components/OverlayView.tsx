import { useMemo } from 'react'
import { useAppStore } from '../store/useAppStore'

export function OverlayView(): React.JSX.Element {
  const { transcripts, assistUpdates, session } = useAppStore()

  const latestRemote = useMemo(() => {
    return [...transcripts].reverse().find((item) => item.speaker === 'remote')
  }, [transcripts])

  const latestAssist = useMemo(() => {
    if (!latestRemote) return [...assistUpdates].reverse()[0]

    const byTranscript = [...assistUpdates]
      .reverse()
      .find((item) => item.transcriptId === latestRemote.id && item.state !== 'error')

    return byTranscript || [...assistUpdates].reverse()[0]
  }, [assistUpdates, latestRemote])

  return (
    <div className="overlay-root">
      <div className="overlay-card">
        <div className="overlay-label">
          Live Overlay {session.muted ? '(muted)' : ''} | {session.phase}
        </div>

        <div>
          <div className="overlay-label">Remote (EN)</div>
          <div className="overlay-text">{latestRemote?.textEn || 'Waiting for remote speech...'}</div>
        </div>

        <div>
          <div className="overlay-label">Translation (TR)</div>
          <div className="overlay-text">{latestAssist?.translationTr || 'Translation will appear here.'}</div>
        </div>

        <div>
          <div className="overlay-label">Suggested Reply (EN / TR)</div>
          <div className="overlay-text">{latestAssist?.replyEn || 'EN reply pending...'}</div>
          <div className="overlay-text">{latestAssist?.replyTr || 'TR reply pending...'}</div>
        </div>
      </div>
    </div>
  )
}
