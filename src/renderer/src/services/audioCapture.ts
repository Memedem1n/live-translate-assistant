import {
  AudioChunkInput,
  AudioSourceItem,
  CaptureDiagnosticsEvent,
  ReconnectState,
  Speaker,
  SystemAudioStrategy
} from '../../../shared/contracts'

type OnChunk = (chunk: AudioChunkInput) => void

interface ChannelStartOptions {
  onChunk: OnChunk
  onLevel?: (rms: number) => void
  onTrackEnded?: () => void
}

interface CaptureStartOptions {
  systemSourceId?: string
  systemSourceName?: string
  strategy?: SystemAudioStrategy
  captureMicrophone?: boolean
  onChunk: OnChunk
  onDiagnostics?: (event: CaptureDiagnosticsEvent) => void
  onSourceChanged?: (source: AudioSourceItem) => void
  onFatalError?: (error: Error) => void
}

const AUTO_SOURCE_PROBE_MS = 900
const AUTO_SOURCE_ACTIVE_RMS_THRESHOLD = 70
const REMOTE_HEALTH_WINDOW_MS = 3500
const REMOTE_SILENCE_SUSPECT_MS = 4000
const LIVE_SWITCH_COOLDOWN_MS = 8000
const LIVE_SWITCH_MIN_SCORE = 110
const LIVE_SWITCH_RATIO = 1.35

type CaptureErrorCode =
  | 'permission_denied'
  | 'device_not_found'
  | 'microphone_unavailable'
  | 'device_busy'
  | 'stream_aborted'
  | 'audio_capture_error'

interface SourceScore {
  id: string
  peakRms: number
  score: number
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  const total = values.reduce((acc, value) => acc + value, 0)
  return total / values.length
}

function scoreAudioSource(source: AudioSourceItem): number {
  const id = source.id.toLowerCase()
  const name = source.name.toLowerCase()

  let score = 0
  if (id.startsWith('screen:')) score += 40
  if (name.includes('entire screen')) score += 30
  if (name.includes('screen')) score += 20
  if (name.includes('display')) score += 12
  if (name.includes('window')) score -= 10
  return score
}

function rankAudioSources(
  sources: AudioSourceItem[],
  preferredId?: string,
  excludeId?: string
): AudioSourceItem[] {
  if (sources.length === 0) return []

  const filtered = excludeId ? sources.filter((item) => item.id !== excludeId) : sources
  if (filtered.length === 0) return []

  const sorted = [...filtered].sort((a, b) => scoreAudioSource(b) - scoreAudioSource(a))
  if (!preferredId) return sorted

  const preferred = sorted.find((item) => item.id === preferredId)
  if (!preferred) return sorted

  return [preferred, ...sorted.filter((item) => item.id !== preferredId)]
}

function classifyCaptureError(
  error: unknown,
  channel: 'system' | 'microphone' = 'system'
): { code: CaptureErrorCode; message: string } {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') {
      return {
        code: 'permission_denied',
        message: 'Mikrofon/ekran yakalama izni gerekli. Sistem izinlerini kontrol edin.'
      }
    }

    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') {
      if (channel === 'microphone') {
        return {
          code: 'microphone_unavailable',
          message: 'Mikrofon cihazi bulunamadi veya devre disi.'
        }
      }

      return {
        code: 'device_not_found',
        message: 'Istenen ses kaynagi bulunamadi. Kaynak degismis olabilir.'
      }
    }

    if (error.name === 'NotReadableError') {
      return {
        code: 'device_busy',
        message: 'Ses kaynagi su an kullanilamiyor. Baska uygulama kaynagi kilitliyor olabilir.'
      }
    }

    if (error.name === 'AbortError') {
      return {
        code: 'stream_aborted',
        message: 'Ses akisi beklenmedik sekilde kesildi.'
      }
    }
  }

  return {
    code: 'audio_capture_error',
    message: error instanceof Error ? error.message : 'Bilinmeyen ses yakalama hatasi.'
  }
}

class ChannelCapture {
  private readonly speaker: Speaker
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
  private silentSinkNode: GainNode | null = null
  private workletBlobUrl: string | null = null
  private trackEndedListener: (() => void) | null = null
  private audioTrack: MediaStreamTrack | null = null
  private running = false

  constructor(speaker: Speaker) {
    this.speaker = speaker
  }

  isRunning(): boolean {
    return this.running
  }

  async startMicrophone(options: ChannelStartOptions): Promise<void> {
    await this.stop()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    await this.startWithStream(stream, options)
  }

  async startSystem(sourceId: string, options: ChannelStartOptions): Promise<void> {
    await this.stop()

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      } as MediaTrackConstraints,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId
        }
      } as MediaTrackConstraints
    })

    stream.getVideoTracks().forEach((track) => track.stop())
    await this.startWithStream(stream, options)
  }

  async startSystemViaDisplayPicker(options: ChannelStartOptions): Promise<void> {
    await this.stop()

    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true
    })

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((track) => track.stop())
      throw new DOMException(
        'Display picker seciminden sistem ses izi gelmedi.',
        'NotFoundError'
      )
    }

    stream.getVideoTracks().forEach((track) => track.stop())
    await this.startWithStream(stream, options)
  }

  async stop(): Promise<void> {
    this.running = false

    if (this.audioTrack && this.trackEndedListener) {
      this.audioTrack.removeEventListener('ended', this.trackEndedListener)
    }
    this.trackEndedListener = null
    this.audioTrack = null

    if (this.workletNode) {
      this.workletNode.disconnect()
      this.workletNode = null
    }

    if (this.silentSinkNode) {
      this.silentSinkNode.disconnect()
      this.silentSinkNode = null
    }

    if (this.sourceNode) {
      this.sourceNode.disconnect()
      this.sourceNode = null
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop())
      this.mediaStream = null
    }

    if (this.audioContext) {
      await this.audioContext.close()
      this.audioContext = null
    }

    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl)
      this.workletBlobUrl = null
    }
  }

  private async startWithStream(stream: MediaStream, options: ChannelStartOptions): Promise<void> {
    this.mediaStream = stream
    this.running = true

    this.audioTrack = stream.getAudioTracks()[0] || null
    if (!this.audioTrack) {
      throw new DOMException('Audio track bulunamadi.', 'NotFoundError')
    }

    if (this.audioTrack && options.onTrackEnded) {
      this.trackEndedListener = () => {
        this.running = false
        options.onTrackEnded?.()
      }
      this.audioTrack.addEventListener('ended', this.trackEndedListener)
    }

    this.audioContext = new AudioContext({ sampleRate: 16000 })
    if (this.audioContext.state !== 'running') {
      try {
        await this.audioContext.resume()
      } catch {
        // resume may fail without user gesture; audio pipeline can still continue if already running.
      }
    }
    this.sourceNode = this.audioContext.createMediaStreamSource(stream)

    this.workletBlobUrl = this.createWorkletBlob()
    await this.audioContext.audioWorklet.addModule(this.workletBlobUrl)

    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm16-streamer')
    this.workletNode.port.onmessage = (event) => {
      const audioData = event.data?.audioData as ArrayBuffer | undefined
      const rms = Number(event.data?.rms || 0)

      options.onLevel?.(rms)

      if (!audioData) return
      options.onChunk({
        speaker: this.speaker,
        sampleRate: 16000,
        pcmBase64: this.arrayBufferToBase64(audioData)
      })
    }

    this.sourceNode.connect(this.workletNode)
    this.silentSinkNode = this.audioContext.createGain()
    this.silentSinkNode.gain.value = 0
    this.workletNode.connect(this.silentSinkNode)
    this.silentSinkNode.connect(this.audioContext.destination)
  }

  private createWorkletBlob(): string {
    const code = `
      class Pcm16Streamer extends AudioWorkletProcessor {
        constructor() {
          super()
          this.bufferSize = 1024
          this.buffer = new Float32Array(this.bufferSize)
          this.bufferIndex = 0
        }

        process(inputs) {
          const input = inputs[0]
          if (input && input[0]) {
            const channel = input[0]
            for (let i = 0; i < channel.length; i++) {
              this.buffer[this.bufferIndex++] = channel[i]
              if (this.bufferIndex >= this.bufferSize) {
                const pcm = new Int16Array(this.bufferSize)
                let total = 0
                for (let j = 0; j < this.bufferSize; j++) {
                  const s = Math.max(-1, Math.min(1, this.buffer[j]))
                  const v = s < 0 ? s * 0x8000 : s * 0x7fff
                  pcm[j] = v
                  total += v * v
                }
                const rms = Math.sqrt(total / this.bufferSize)
                this.port.postMessage({ audioData: pcm.buffer, rms }, [pcm.buffer])
                this.buffer = new Float32Array(this.bufferSize)
                this.bufferIndex = 0
              }
            }
          }
          return true
        }
      }

      registerProcessor('pcm16-streamer', Pcm16Streamer)
    `

    const blob = new Blob([code], { type: 'application/javascript' })
    return URL.createObjectURL(blob)
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    const chunkSize = 0x8000
    let binary = ''

    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.subarray(i, i + chunkSize)
      binary += String.fromCharCode(...slice)
    }

    return btoa(binary)
  }
}

export class MeetingAudioCapture {
  private readonly remoteChannel = new ChannelCapture('remote')
  private readonly selfChannel = new ChannelCapture('self')
  private readonly reconnectBackoffMs = [1000, 2000, 4000]

  private strategy: SystemAudioStrategy = 'auto_live'
  private captureMicrophone = true
  private liveSwitchEnabled = true
  private systemSourceId = ''
  private systemSourceName = ''
  private onChunk: OnChunk | null = null
  private onDiagnostics: ((event: CaptureDiagnosticsEvent) => void) | null = null
  private onSourceChanged: ((source: AudioSourceItem) => void) | null = null
  private onFatalError: ((error: Error) => void) | null = null
  private diagnosticsTimer: number | null = null
  private reconnecting = false
  private stopped = true
  private healthSwitchInFlight = false
  private lastSourceSwitchMs = 0
  private lastRemoteActiveMs = 0
  private remoteLevelHistory: Array<{ tsMs: number; rms: number }> = []
  private sourceScores = new Map<string, number>()

  private diagnostics: CaptureDiagnosticsEvent = {
    tsMs: Date.now(),
    remoteRms: 0,
    selfRms: 0,
    droppedRemote: 0,
    droppedSelf: 0,
    reconnectState: 'stable',
    reconnectAttempt: 0,
    activeSourceId: '',
    activeSourceName: '',
    sourceSwitchCount: 0,
    remoteSilenceMs: 0,
    sourceHealth: 'healthy'
  }

  private readonly handleDeviceChange = (): void => {
    if (this.stopped || this.reconnecting) return
    if (!this.remoteChannel.isRunning()) {
      void this.handleRemoteTrackEnded()
    }
  }

  async start(options: CaptureStartOptions): Promise<void> {
    this.onChunk = options.onChunk
    this.onDiagnostics = options.onDiagnostics || null
    this.onSourceChanged = options.onSourceChanged || null
    this.onFatalError = options.onFatalError || null
    this.captureMicrophone = options.captureMicrophone !== false
    this.strategy = options.strategy || (options.systemSourceId ? 'manual' : 'auto_live')
    this.liveSwitchEnabled = this.strategy === 'auto_live' && !options.systemSourceId
    this.reconnecting = false
    this.stopped = false
    this.healthSwitchInFlight = false
    this.remoteLevelHistory = []
    this.sourceScores.clear()
    this.lastRemoteActiveMs = Date.now()
    this.lastSourceSwitchMs = 0

    const sources = await window.api.getAudioSources()
    const candidates = rankAudioSources(sources, options.systemSourceId)
    if (candidates.length === 0) {
      this.setCaptureError('device_not_found', 'System audio source bulunamadi. Ekran yakalama iznini kontrol edin.')
      throw new Error('System audio source bulunamadi. Ekran yakalama iznini kontrol edin.')
    }

    let selectedSource: AudioSourceItem | null = null
    let selectedScore = 0
    let lastOpenError: { code: CaptureErrorCode; message: string } | null = null
    let preferPickerFallback = false

    if (this.strategy === 'picker_each_start' && !options.systemSourceId) {
      try {
        await this.remoteChannel.startSystemViaDisplayPicker(this.buildRemoteOptions())
        selectedSource = {
          id: 'display-media:auto',
          name: 'Display Media Picker'
        }
        selectedScore = LIVE_SWITCH_MIN_SCORE
        this.clearCaptureError()
      } catch (pickerError) {
        const pickerClassified = classifyCaptureError(pickerError, 'system')
        this.setCaptureError(pickerClassified.code, pickerClassified.message)
        throw new Error(`[${pickerClassified.code}] ${pickerClassified.message}`)
      }
    }

    // Auto mode: probe candidate screens and prefer the source with strongest audio RMS.
    if (!options.systemSourceId && this.strategy === 'auto_live' && !selectedSource) {
      const probeResults: Array<{ source: AudioSourceItem; peakRms: number; score: number }> = []
      for (const candidate of candidates) {
        const probed = await this.probeSystemSource(candidate)
        if (probed.error) {
          lastOpenError = probed.error
          this.setCaptureError(probed.error.code, probed.error.message)
        }
        if (probed.opened) {
          const score = probed.peakRms
          probeResults.push({ source: candidate, peakRms: probed.peakRms, score })
          this.sourceScores.set(candidate.id, score)
        }
      }
      this.diagnostics.candidateScores = probeResults.map((item) => ({
        id: item.source.id,
        peakRms: Number(item.peakRms.toFixed(2)),
        score: Number(item.score.toFixed(2))
      }))

      const bestByRms = probeResults.sort((a, b) => b.peakRms - a.peakRms)[0]
      if (bestByRms && bestByRms.peakRms >= AUTO_SOURCE_ACTIVE_RMS_THRESHOLD) {
        try {
          await this.remoteChannel.startSystem(bestByRms.source.id, this.buildRemoteOptions())
          this.clearCaptureError()
          selectedSource = bestByRms.source
          selectedScore = bestByRms.score
        } catch (error) {
          lastOpenError = classifyCaptureError(error, 'system')
          this.setCaptureError(lastOpenError.code, lastOpenError.message)
        }
      } else if (probeResults.length > 0) {
        // All candidates opened but had near-zero audio; force picker fallback for explicit selection.
        preferPickerFallback = true
      }
    }

    for (const candidate of candidates) {
      if (preferPickerFallback) break
      if (selectedSource) break
      try {
        await this.remoteChannel.startSystem(candidate.id, this.buildRemoteOptions())
        this.clearCaptureError()
        selectedSource = candidate
        selectedScore = this.sourceScores.get(candidate.id) || 0
        break
      } catch (error) {
        lastOpenError = classifyCaptureError(error, 'system')
        this.setCaptureError(lastOpenError.code, lastOpenError.message)
        // Try next source candidate until one becomes capturable.
      }
    }

    if (!selectedSource) {
      try {
        // Fallback: Let the user pick a capturable display source directly.
        await this.remoteChannel.startSystemViaDisplayPicker(this.buildRemoteOptions())
        selectedSource = {
          id: 'display-media:auto',
          name: 'Display Media Picker'
        }
        selectedScore = LIVE_SWITCH_MIN_SCORE
        this.clearCaptureError()
      } catch (pickerError) {
        const pickerClassified = classifyCaptureError(pickerError, 'system')
        this.setCaptureError(pickerClassified.code, pickerClassified.message)
        const detail = lastOpenError ? ` (${lastOpenError.code}) ${lastOpenError.message}` : ''
        throw new Error(
          `Sistem ses kaynagi acilamadi.${detail} Picker fallback da basarisiz: [${pickerClassified.code}] ${pickerClassified.message}`
        )
      }
    }

    this.systemSourceId = selectedSource.id
    this.systemSourceName = selectedSource.name || options.systemSourceName || selectedSource.id
    this.sourceScores.set(this.systemSourceId, selectedScore)
    this.lastSourceSwitchMs = Date.now()
    if (options.systemSourceId !== selectedSource.id) {
      this.onSourceChanged?.(selectedSource)
    }

    this.diagnostics = {
      tsMs: Date.now(),
      remoteRms: 0,
      selfRms: 0,
      droppedRemote: 0,
      droppedSelf: 0,
      reconnectState: 'stable',
      reconnectAttempt: 0,
      activeSourceId: this.systemSourceId,
      activeSourceName: this.systemSourceName,
      sourceSwitchCount: 0,
      remoteSilenceMs: 0,
      sourceHealth: 'healthy',
      lastSwitchReason: options.systemSourceId ? 'manual_override' : undefined,
      candidateScores: this.diagnostics.candidateScores,
      lastErrorCode: undefined,
      lastErrorMessage: undefined
    }

    try {
      if (this.captureMicrophone) {
        try {
          await this.selfChannel.startMicrophone(this.buildSelfOptions())
        } catch (micError) {
          // Do not fail the whole session for microphone problems when remote/system audio is active.
          const micClassified = classifyCaptureError(micError, 'microphone')
          this.setCaptureError(
            micClassified.code,
            `Mikrofon acilamadi, remote-only devam: ${micClassified.message}`
          )
        }
      } else {
        this.diagnostics.selfRms = 0
      }

      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange)
      this.startDiagnosticsTimer()
      this.emitDiagnostics(true)
    } catch (error) {
      const classified = classifyCaptureError(error, 'system')
      this.setCaptureError(classified.code, classified.message)
      await this.stop()
      throw new Error(`[${classified.code}] ${classified.message}`)
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.reconnecting = false
    this.healthSwitchInFlight = false
    this.remoteLevelHistory = []
    this.sourceScores.clear()
    this.lastRemoteActiveMs = 0
    this.lastSourceSwitchMs = 0

    if (this.diagnosticsTimer !== null) {
      window.clearInterval(this.diagnosticsTimer)
      this.diagnosticsTimer = null
    }

    try {
      navigator.mediaDevices.removeEventListener('devicechange', this.handleDeviceChange)
    } catch {
      // no-op
    }

    await Promise.all([this.remoteChannel.stop(), this.selfChannel.stop()])
  }

  private buildRemoteOptions(): ChannelStartOptions {
    return {
      onChunk: (chunk) => this.forwardChunk(chunk),
      onLevel: (rms) => {
        this.diagnostics.remoteRms = rms
        this.recordRemoteLevel(rms)
      },
      onTrackEnded: () => {
        void this.handleRemoteTrackEnded()
      }
    }
  }

  private buildSelfOptions(): ChannelStartOptions {
    return {
      onChunk: (chunk) => this.forwardChunk(chunk),
      onLevel: (rms) => {
        this.diagnostics.selfRms = rms
      }
    }
  }

  private forwardChunk(chunk: AudioChunkInput): void {
    try {
      this.onChunk?.(chunk)
    } catch {
      if (chunk.speaker === 'remote') {
        this.diagnostics.droppedRemote += 1
      } else {
        this.diagnostics.droppedSelf += 1
      }
      this.emitDiagnostics(true)
    }
  }

  private startDiagnosticsTimer(): void {
    if (this.diagnosticsTimer !== null) {
      window.clearInterval(this.diagnosticsTimer)
    }

    this.diagnosticsTimer = window.setInterval(() => {
      this.evaluateRemoteHealth()
      this.emitDiagnostics(false)
    }, 250)
  }

  private emitDiagnostics(force: boolean): void {
    if (!this.onDiagnostics) return
    if (!force && this.stopped) return

    this.onDiagnostics({
      ...this.diagnostics,
      tsMs: Date.now()
    })
  }

  private setReconnectState(state: ReconnectState, attempt: number): void {
    this.diagnostics.reconnectState = state
    this.diagnostics.reconnectAttempt = attempt
    this.emitDiagnostics(true)
  }

  private setCaptureError(code: CaptureErrorCode, message: string): void {
    this.diagnostics.lastErrorCode = code
    this.diagnostics.lastErrorMessage = message
    if (code !== 'microphone_unavailable') {
      this.diagnostics.sourceHealth = 'suspect'
    }
    this.emitDiagnostics(true)
  }

  private clearCaptureError(): void {
    this.diagnostics.lastErrorCode = undefined
    this.diagnostics.lastErrorMessage = undefined
    if (!this.healthSwitchInFlight) {
      this.diagnostics.sourceHealth = 'healthy'
    }
  }

  private async handleRemoteTrackEnded(): Promise<void> {
    if (this.stopped || this.reconnecting) return

    this.reconnecting = true

    try {
      for (let i = 0; i < this.reconnectBackoffMs.length; i++) {
        if (this.stopped) return

        this.setReconnectState('retrying', i + 1)
        await this.wait(this.reconnectBackoffMs[i])

        const recovered = await this.trySwitchRemoteSource(
          this.systemSourceId,
          this.systemSourceName
        )
        if (recovered) {
          this.diagnostics.lastSwitchReason = 'devicechange'
          this.diagnostics.sourceHealth = 'healthy'
          this.clearCaptureError()
          this.setReconnectState('stable', 0)
          return
        }
      }

      this.setReconnectState('fallback', 1)
      const sources = await window.api.getAudioSources()
      const fallbackCandidates = rankAudioSources(sources, undefined, this.systemSourceId)

      for (const fallback of fallbackCandidates) {
        const switched = await this.trySwitchRemoteSource(fallback.id, fallback.name)
        if (switched) {
          this.systemSourceId = fallback.id
          this.systemSourceName = fallback.name
          this.diagnostics.sourceSwitchCount = (this.diagnostics.sourceSwitchCount || 0) + 1
          this.lastSourceSwitchMs = Date.now()
          this.diagnostics.lastSwitchReason = 'devicechange'
          this.diagnostics.sourceHealth = 'healthy'
          this.clearCaptureError()
          this.onSourceChanged?.(fallback)
          this.setReconnectState('stable', 0)
          return
        }
      }

      this.setReconnectState('failed', this.reconnectBackoffMs.length)
      this.diagnostics.sourceHealth = 'suspect'
      this.setCaptureError(
        'device_not_found',
        'System audio source reconnect failed. Select another source and restart the session.'
      )
      this.onFatalError?.(
        new Error(
          'System audio source reconnect failed. Select another source and restart the session.'
        )
      )
    } finally {
      this.reconnecting = false
    }
  }

  private async trySwitchRemoteSource(sourceId: string, sourceName: string): Promise<boolean> {
    try {
      await this.remoteChannel.startSystem(sourceId, this.buildRemoteOptions())
      this.diagnostics.activeSourceId = sourceId
      this.diagnostics.activeSourceName = sourceName
      this.remoteLevelHistory = []
      this.lastRemoteActiveMs = Date.now()
      this.sourceScores.set(sourceId, Math.max(this.sourceScores.get(sourceId) || 0, LIVE_SWITCH_MIN_SCORE))
      this.clearCaptureError()
      this.emitDiagnostics(true)
      return true
    } catch (error) {
      const classified = classifyCaptureError(error, 'system')
      this.setCaptureError(classified.code, classified.message)
      return false
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms))
  }

  async redetectAudioSource(): Promise<boolean> {
    return this.maybeSwitchSourceByHealth('manual_override', true)
  }

  private recordRemoteLevel(rms: number): void {
    const now = Date.now()
    this.remoteLevelHistory.push({ tsMs: now, rms })
    const minTs = now - REMOTE_HEALTH_WINDOW_MS
    this.remoteLevelHistory = this.remoteLevelHistory.filter((item) => item.tsMs >= minTs)
    if (rms >= AUTO_SOURCE_ACTIVE_RMS_THRESHOLD) {
      this.lastRemoteActiveMs = now
    }
  }

  private currentRemoteScore(nowMs = Date.now()): number {
    const minTs = nowMs - REMOTE_HEALTH_WINDOW_MS
    const recent = this.remoteLevelHistory
      .filter((item) => item.tsMs >= minTs)
      .map((item) => item.rms)
    return average(recent)
  }

  private evaluateRemoteHealth(): void {
    if (this.stopped) return

    const now = Date.now()
    const silenceMs = Math.max(0, now - this.lastRemoteActiveMs)
    this.diagnostics.remoteSilenceMs = silenceMs

    if (this.healthSwitchInFlight) {
      this.diagnostics.sourceHealth = 'switching'
      return
    }

    this.diagnostics.sourceHealth = silenceMs >= REMOTE_SILENCE_SUSPECT_MS ? 'suspect' : 'healthy'

    const cooldownReady = now - this.lastSourceSwitchMs >= LIVE_SWITCH_COOLDOWN_MS
    const shouldSwitch =
      this.liveSwitchEnabled &&
      !this.reconnecting &&
      !this.healthSwitchInFlight &&
      cooldownReady &&
      silenceMs >= REMOTE_SILENCE_SUSPECT_MS

    if (shouldSwitch) {
      void this.maybeSwitchSourceByHealth('low_rms')
    }
  }

  private async maybeSwitchSourceByHealth(
    reason: NonNullable<CaptureDiagnosticsEvent['lastSwitchReason']>,
    force = false
  ): Promise<boolean> {
    if (this.healthSwitchInFlight || this.stopped) return false
    if (!force && !this.liveSwitchEnabled) return false

    this.healthSwitchInFlight = true
    this.diagnostics.sourceHealth = 'switching'
    this.diagnostics.lastSwitchReason = reason
    this.emitDiagnostics(true)

    try {
      const sources = await window.api.getAudioSources()
      const candidates = rankAudioSources(sources)
      if (candidates.length === 0) {
        return false
      }

      const scores: SourceScore[] = []
      for (const candidate of candidates) {
        const probed = await this.probeSystemSource(candidate)
        if (probed.opened) {
          const score = probed.peakRms
          scores.push({ id: candidate.id, peakRms: probed.peakRms, score })
          this.sourceScores.set(candidate.id, score)
        }
      }

      this.diagnostics.candidateScores = scores.map((item) => ({
        id: item.id,
        peakRms: Number(item.peakRms.toFixed(2)),
        score: Number(item.score.toFixed(2))
      }))
      if (scores.length === 0) {
        return false
      }

      scores.sort((a, b) => b.score - a.score)
      const best = scores[0]
      const currentScore = Math.max(this.sourceScores.get(this.systemSourceId) || 0, this.currentRemoteScore())
      const minimumTarget = Math.max(LIVE_SWITCH_MIN_SCORE, currentScore * LIVE_SWITCH_RATIO)
      const passScore = force ? best.score >= AUTO_SOURCE_ACTIVE_RMS_THRESHOLD : best.score >= minimumTarget

      if (!passScore || best.id === this.systemSourceId) {
        return false
      }

      const nextSource = sources.find((item) => item.id === best.id)
      if (!nextSource) return false

      const switched = await this.trySwitchRemoteSource(nextSource.id, nextSource.name)
      if (!switched) return false

      this.systemSourceId = nextSource.id
      this.systemSourceName = nextSource.name
      this.diagnostics.activeSourceId = nextSource.id
      this.diagnostics.activeSourceName = nextSource.name
      this.diagnostics.sourceSwitchCount = (this.diagnostics.sourceSwitchCount || 0) + 1
      this.diagnostics.lastSwitchReason = reason
      this.diagnostics.sourceHealth = 'healthy'
      this.lastSourceSwitchMs = Date.now()
      this.onSourceChanged?.(nextSource)
      return true
    } finally {
      this.healthSwitchInFlight = false
      if (!this.stopped && this.diagnostics.sourceHealth !== 'healthy') {
        this.diagnostics.sourceHealth = 'suspect'
      }
      this.emitDiagnostics(true)
    }
  }

  private async probeSystemSource(candidate: AudioSourceItem): Promise<{
    opened: boolean
    peakRms: number
    error?: { code: CaptureErrorCode; message: string }
  }> {
    const probeChannel = new ChannelCapture('remote')
    let peakRms = 0
    try {
      await probeChannel.startSystem(candidate.id, {
        onChunk: () => {
          // Probe mode: don't forward chunks until source selection is finalized.
        },
        onLevel: (rms) => {
          if (rms > peakRms) {
            peakRms = rms
          }
        }
      })

      await this.wait(AUTO_SOURCE_PROBE_MS)
      return { opened: true, peakRms }
    } catch (error) {
      return {
        opened: false,
        peakRms,
        error: classifyCaptureError(error, 'system')
      }
    } finally {
      await probeChannel.stop()
    }
  }
}
