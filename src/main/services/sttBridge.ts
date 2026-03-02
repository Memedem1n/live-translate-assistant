import { EventEmitter } from 'events'
import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { AudioChunkInput, Speaker, TranscriptEvent } from '../../shared/contracts'

interface WorkerCommand {
  type: string
  [key: string]: unknown
}

interface WorkerTranscriptEvent {
  type: 'transcript'
  speaker: Speaker
  text: string
  confidence?: number
}

interface WorkerErrorEvent {
  type: 'error'
  message: string
}

export interface SttBridgeOptions {
  workerPath: string
  pythonBin?: string
}

export class SttBridge extends EventEmitter {
  private readonly workerPath: string
  private readonly pythonBin: string
  private process: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''

  constructor(options: SttBridgeOptions) {
    super()
    this.workerPath = options.workerPath
    this.pythonBin = options.pythonBin || 'python'
  }

  start(model: string): void {
    if (this.process) return

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
      this.process = null
      this.emit('stopped')
    })

    this.send({ type: 'start_session', model })
  }

  stop(): void {
    if (!this.process) return
    this.send({ type: 'stop_session' })
    this.process.kill()
    this.process = null
  }

  sendAudioChunk(chunk: AudioChunkInput): void {
    if (!this.process) return
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

    const event: TranscriptEvent = {
      id: randomUUID(),
      speaker,
      textEn: normalized,
      isFinal: true,
      tStartMs: Date.now(),
      tEndMs: Date.now(),
      confidence: 0.95
    }

    if (this.process) {
      this.send({ type: 'inject_transcript', speaker, text: event.textEn })
    } else {
      this.emit('transcript', event)
    }
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

      let payload: WorkerTranscriptEvent | WorkerErrorEvent
      try {
        payload = JSON.parse(trimmed)
      } catch {
        this.emit('log', `Invalid worker event: ${trimmed}`)
        continue
      }

      if (payload.type === 'transcript') {
        const transcript: TranscriptEvent = {
          id: randomUUID(),
          speaker: payload.speaker,
          textEn: payload.text,
          isFinal: true,
          tStartMs: Date.now(),
          tEndMs: Date.now(),
          confidence: payload.confidence ?? 0.85
        }

        this.emit('transcript', transcript)
      } else if (payload.type === 'error') {
        this.emit('error', new Error(payload.message))
      }
    }
  }
}
