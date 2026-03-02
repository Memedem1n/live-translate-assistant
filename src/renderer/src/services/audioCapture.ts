import {
  AudioChunkInput,
  AudioSourceItem,
  CaptureDiagnosticsEvent,
  ReconnectState,
  Speaker
} from '../../../shared/contracts'

type OnChunk = (chunk: AudioChunkInput) => void

interface ChannelStartOptions {
  onChunk: OnChunk
  onLevel?: (rms: number) => void
  onTrackEnded?: () => void
}

interface CaptureStartOptions {
  systemSourceId: string
  systemSourceName?: string
  onChunk: OnChunk
  onDiagnostics?: (event: CaptureDiagnosticsEvent) => void
  onSourceChanged?: (source: AudioSourceItem) => void
  onFatalError?: (error: Error) => void
}

class ChannelCapture {
  private readonly speaker: Speaker
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null
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
    if (this.audioTrack && options.onTrackEnded) {
      this.trackEndedListener = () => {
        this.running = false
        options.onTrackEnded?.()
      }
      this.audioTrack.addEventListener('ended', this.trackEndedListener)
    }

    this.audioContext = new AudioContext({ sampleRate: 16000 })
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

  private systemSourceId = ''
  private systemSourceName = ''
  private onChunk: OnChunk | null = null
  private onDiagnostics: ((event: CaptureDiagnosticsEvent) => void) | null = null
  private onSourceChanged: ((source: AudioSourceItem) => void) | null = null
  private onFatalError: ((error: Error) => void) | null = null
  private diagnosticsTimer: number | null = null
  private reconnecting = false
  private stopped = true

  private diagnostics: CaptureDiagnosticsEvent = {
    tsMs: Date.now(),
    remoteRms: 0,
    selfRms: 0,
    droppedRemote: 0,
    droppedSelf: 0,
    reconnectState: 'stable',
    reconnectAttempt: 0,
    activeSourceId: '',
    activeSourceName: ''
  }

  private readonly handleDeviceChange = (): void => {
    if (this.stopped || this.reconnecting) return
    if (!this.remoteChannel.isRunning()) {
      void this.handleRemoteTrackEnded()
    }
  }

  async start(options: CaptureStartOptions): Promise<void> {
    this.systemSourceId = options.systemSourceId
    this.systemSourceName = options.systemSourceName || options.systemSourceId
    this.onChunk = options.onChunk
    this.onDiagnostics = options.onDiagnostics || null
    this.onSourceChanged = options.onSourceChanged || null
    this.onFatalError = options.onFatalError || null
    this.reconnecting = false
    this.stopped = false

    this.diagnostics = {
      tsMs: Date.now(),
      remoteRms: 0,
      selfRms: 0,
      droppedRemote: 0,
      droppedSelf: 0,
      reconnectState: 'stable',
      reconnectAttempt: 0,
      activeSourceId: this.systemSourceId,
      activeSourceName: this.systemSourceName
    }

    try {
      await this.remoteChannel.startSystem(this.systemSourceId, this.buildRemoteOptions())
      await this.selfChannel.startMicrophone(this.buildSelfOptions())

      navigator.mediaDevices.addEventListener('devicechange', this.handleDeviceChange)
      this.startDiagnosticsTimer()
      this.emitDiagnostics(true)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.reconnecting = false

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
          this.setReconnectState('stable', 0)
          return
        }
      }

      this.setReconnectState('fallback', 1)
      const sources = await window.api.getAudioSources()
      const fallback = sources.find((source) => source.id !== this.systemSourceId)

      if (fallback) {
        const switched = await this.trySwitchRemoteSource(fallback.id, fallback.name)
        if (switched) {
          this.systemSourceId = fallback.id
          this.systemSourceName = fallback.name
          this.onSourceChanged?.(fallback)
          this.setReconnectState('stable', 0)
          return
        }
      }

      this.setReconnectState('failed', this.reconnectBackoffMs.length)
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
      this.emitDiagnostics(true)
      return true
    } catch {
      return false
    }
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => window.setTimeout(resolve, ms))
  }
}
