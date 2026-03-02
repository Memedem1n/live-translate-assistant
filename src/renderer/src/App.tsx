import { useMemo } from 'react'
import { ControlView } from './components/ControlView'
import { OverlayView } from './components/OverlayView'
import { useAppStore } from './store/useAppStore'

export function App(): React.JSX.Element {
  const { view } = useAppStore()

  const page = useMemo(() => {
    return view === 'overlay' ? <OverlayView /> : <ControlView />
  }, [view])

  return page
}
