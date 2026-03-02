import { AudioChunkInput, Speaker } from '../../../shared/contracts'

type OnChunk = (chunk: AudioChunkInput) => void

class ChannelCapture {
  private readonly speaker: Speaker
  private audioContext: AudioContext | null = null
  private mediaStream: MediaStream | null = null
  private sourceNode: MediaStreamAudioSourceNode | null = null
  private workletNode: AudioWorkletNode | null = null

  constructor(speaker: Speaker) {
    this.speaker = speaker
  }

  async startMicrophone(onChunk: OnChunk): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })

    await this.startWithStream(stream, onChunk)
  }

  async startSystem(sourceId: string, onChunk: OnChunk): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // Electron desktop capture constraint
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
    await this.startWithStream(stream, onChunk)
  }

  async stop(): Promise<void> {
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
  }

  private async startWithStream(stream: MediaStream, onChunk: OnChunk): Promise<void> {
    this.mediaStream = stream

    this.audioContext = new AudioContext({ sampleRate: 16000 })
    this.sourceNode = this.audioContext.createMediaStreamSource(stream)

    const blobUrl = this.createWorkletBlob()
    await this.audioContext.audioWorklet.addModule(blobUrl)

    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm16-streamer')
    this.workletNode.port.onmessage = (event) => {
      const audioData = event.data?.audioData as ArrayBuffer | undefined
      if (!audioData) return

      onChunk({
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
                for (let j = 0; j < this.bufferSize; j++) {
                  const s = Math.max(-1, Math.min(1, this.buffer[j]))
                  pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff
                }
                this.port.postMessage({ audioData: pcm.buffer }, [pcm.buffer])
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

  async start(systemSourceId: string, onChunk: OnChunk): Promise<void> {
    try {
      await this.remoteChannel.startSystem(systemSourceId, onChunk)
      await this.selfChannel.startMicrophone(onChunk)
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.remoteChannel.stop(), this.selfChannel.stop()])
  }
}
