import { EventEmitter } from 'events'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  AudioChunkInput,
  Speaker,
  TranscriptEvent,
  VadConfig,
  WorkerDiagnosticsEvent
} from '../../shared/contracts'

interface WorkerCommand {
  type: string
  [key: string]: unknown
}

interface WorkerTranscriptEvent {
  type: 'transcript'
  speaker: Speaker
  text: string
  confidence?: number
  t_start_ms?: number
  t_end_ms?: number
  emitted_ms?: number
}

interface WorkerErrorEvent {
  type: 'error'
  message: string
}

interface WorkerReadyEvent {
  type: 'ready'
  model: string
}

interface WorkerDiagnosticsPayload {
  type: 'diagnostics'
  ts_ms?: number
  remote_rms?: number
  self_rms?: number
  dropped_remote?: number
  dropped_self?: number
}

type WorkerEvent =
  | WorkerTranscriptEvent
  | WorkerErrorEvent
  | WorkerReadyEvent
  | WorkerDiagnosticsPayload

export interface SttBridgeOptions {
  workerPath: string
  pythonBin?: string
}

interface StartOptions {
  vad?: VadConfig
  timeoutMs?: number
}

export class SttBridge extends EventEmitter {
  private readonly workerPath: string
  private readonly pythonBin: string
  private process: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private ready = false
  private startPromise: Promise<void> | null = null
  private startResolve: (() => void) | null = null
  private startReject: ((error: Error) => void) | null = null
  private startTimer: NodeJS.Timeout | null = null

  constructor(options: SttBridgeOptions) {
    super()
    this.workerPath = options.workerPath
    this.pythonBin = options.pythonBin || 'python'
  }

  async start(model: string, options?: StartOptions): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 15000

    if (this.process && this.ready) {
      return
    }

    if (!this.process) {
      this.spawnProcess()
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.ready = false
    this.startPromise = new Promise<void>((resolve, reject) => {
      this.startResolve = resolve
      this.startReject = reject
    })

    this.startTimer = setTimeout(() => {
      this.rejectStart(new Error(`STT worker did not become ready within ${timeoutMs}ms.`))
    }, timeoutMs)

    this.send({ type: 'start_session', model, vad: options?.vad })

    return this.startPromise
  }

  stop(): void {
    if (!this.process) return

    this.send({ type: 'stop_session' })
    this.process.kill()
    this.rejectStart(new Error('STT worker stopped before ready.'))
    this.process = null
    this.ready = false
  }

  updateVad(vad: VadConfig): boolean {
    if (!this.process || !this.ready) return false

    this.send({ type: 'update_vad', vad })
    return true
  }

  sendAudioChunk(chunk: AudioChunkInput): void {
    if (!this.process || !this.ready) return
    this.send({
      type: 'audio_chunk',
      speaker: chunk.speaker,
      pcm_base64: chunk.pcmBase64,
      sample_rate: chunk.sampleRate
    })
  }

  injectTranscript(speaker: Speaker, textEn: string): void {
    const normalized = textEn.trim()
    if (!normalized) return

    const now = Date.now()
    const event: TranscriptEvent = {
      id: randomUUID(),
      speaker,
      textEn: normalized,
      isFinal: true,
      tStartMs: now,
      tEndMs: now,
      emittedMs: now,
      confidence: 0.95
    }

    if (this.process && this.ready) {
      this.send({ type: 'inject_transcript', speaker, text: event.textEn })
    } else {
      this.emit('transcript', event)
    }
  }

  private spawnProcess(): void {
    this.process = spawn(this.pythonBin, [this.workerPath], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.process.stdout.on('data', (chunk: Buffer) => {
      this.stdoutBuffer += chunk.toString('utf8')
      this.consumeStdout()
    })

    this.process.stderr.on('data', (chunk: Buffer) => {
      const msg = chunk.toString('utf8').trim()
      if (msg) {
        this.emit('log', msg)
      }
    })

    this.process.on('exit', () => {
      const wasReady = this.ready
      this.rejectStart(new Error('STT worker exited before startup completed.'))
      this.process = null
      this.ready = false
      this.stdoutBuffer = ''
      this.emit('stopped')

      if (!wasReady) {
        this.emit('error', new Error('STT worker exited unexpectedly during startup.'))
      }
    })
  }

  private send(command: WorkerCommand): void {
    if (!this.process) return
    this.process.stdin.write(`${JSON.stringify(command)}\n`)
  }

  private consumeStdout(): void {
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() || ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue

      let payload: WorkerEvent
      try {
        payload = JSON.parse(trimmed)
      } catch {
        this.emit('log', `Invalid worker event: ${trimmed}`)
        continue
      }

      if (payload.type === 'ready') {
        this.ready = true
        this.resolveStart()
        continue
      }

      if (payload.type === 'diagnostics') {
        const diagnostics: WorkerDiagnosticsEvent = {
          tsMs: Number(payload.ts_ms ?? Date.now()),
          remoteRms: Number(payload.remote_rms ?? 0),
          selfRms: Number(payload.self_rms ?? 0),
          droppedRemote: Number(payload.dropped_remote ?? 0),
          droppedSelf: Number(payload.dropped_self ?? 0)
        }

        this.emit('diagnostics', diagnostics)
        continue
      }

      if (payload.type === 'transcript') {
        const now = Date.now()
        const tStartMs = Number(payload.t_start_ms ?? now)
        const tEndMs = Number(payload.t_end_ms ?? now)
        const emittedMs = Number(payload.emitted_ms ?? now)

        const transcript: TranscriptEvent = {
          id: randomUUID(),
          speaker: payload.speaker,
          textEn: payload.text,
          isFinal: true,
          tStartMs,
          tEndMs,
          emittedMs,
          confidence: payload.confidence ?? 0.85
        }

        this.emit('transcript', transcript)
      } else if (payload.type === 'error') {
        this.rejectStart(new Error(payload.message))
        this.emit('error', new Error(payload.message))
      }
    }
  }

  private resolveStart(): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }

    if (this.startResolve) {
      this.startResolve()
    }

    this.startResolve = null
    this.startReject = null
    this.startPromise = null
  }

  private rejectStart(error: Error): void {
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }

    if (this.startReject) {
      this.startReject(error)
    }

    this.startResolve = null
    this.startReject = null
    this.startPromise = null
  }
}