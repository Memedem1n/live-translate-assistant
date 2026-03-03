import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { AppSettings, VadConfig } from '../../shared/contracts'

const SETTINGS_FILE = 'settings.json'

const DEFAULT_VAD: VadConfig = {
  remote: {
    minAudioMs: 450,
    silenceMs: 320,
    voiceRmsThreshold: 380
  },
  self: {
    minAudioMs: 450,
    silenceMs: 320,
    voiceRmsThreshold: 380
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  sttModel: 'small.en',
  answerModel: 'qwen2.5:7b-instruct-q4_K_M',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  overlayOpacity: 0.78,
  overlayVisible: true,
  overlayClickThrough: true,
  autoHideControlWindow: true,
  systemAudioMode: 'auto',
  manualSystemSourceId: '',
  historyOptIn: false,
  hotkeys: {
    toggleOverlay: 'CommandOrControl+Shift+O',
    muteSuggestions: 'CommandOrControl+Shift+M',
    panicHide: 'CommandOrControl+Shift+H'
  },
  vad: {
    remote: { ...DEFAULT_VAD.remote },
    self: { ...DEFAULT_VAD.self }
  },
  vadApplyMode: 'live'
}

type SerializedSettings = Omit<AppSettings, 'answerModel' | 'ollamaBaseUrl'> & {
  answerModelEncrypted?: string
  ollamaBaseUrlEncrypted?: string
  answerModel?: string
  ollamaBaseUrl?: string
}

function clampVad(config: VadConfig): VadConfig {
  const clampChannel = (channel: VadConfig['remote']) => ({
    minAudioMs: Math.max(120, Math.min(3000, Math.round(channel.minAudioMs))),
    silenceMs: Math.max(80, Math.min(2500, Math.round(channel.silenceMs))),
    voiceRmsThreshold: Math.max(50, Math.min(3000, channel.voiceRmsThreshold))
  })

  return {
    remote: clampChannel(config.remote),
    self: clampChannel(config.self)
  }
}

export class SettingsManager {
  private readonly settingsPath: string
  private settings: AppSettings

  constructor() {
    const userData = app.getPath('userData')
    this.settingsPath = path.join(userData, SETTINGS_FILE)
    this.settings = this.load()
  }

  get(): AppSettings {
    return {
      ...this.settings,
      hotkeys: { ...this.settings.hotkeys },
      vad: {
        remote: { ...this.settings.vad.remote },
        self: { ...this.settings.vad.self }
      }
    }
  }

  update(updates: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...updates,
      hotkeys: {
        ...this.settings.hotkeys,
        ...(updates.hotkeys || {})
      },
      vad: updates.vad
        ? {
            remote: {
              ...this.settings.vad.remote,
              ...updates.vad.remote
            },
            self: {
              ...this.settings.vad.self,
              ...updates.vad.self
            }
          }
        : this.settings.vad
    }

    this.settings.overlayOpacity = Math.min(1, Math.max(0.25, this.settings.overlayOpacity))
    this.settings.autoHideControlWindow = this.settings.autoHideControlWindow !== false
    this.settings.systemAudioMode = this.settings.systemAudioMode === 'manual' ? 'manual' : 'auto'
    this.settings.manualSystemSourceId = String(this.settings.manualSystemSourceId || '')
    this.settings.vad = clampVad(this.settings.vad)
    this.settings.vadApplyMode = this.settings.vadApplyMode === 'restart' ? 'restart' : 'live'
    this.save()
    return this.get()
  }

  private load(): AppSettings {
    if (!fs.existsSync(this.settingsPath)) {
      return {
        ...DEFAULT_SETTINGS,
        hotkeys: { ...DEFAULT_SETTINGS.hotkeys },
        vad: {
          remote: { ...DEFAULT_SETTINGS.vad.remote },
          self: { ...DEFAULT_SETTINGS.vad.self }
        }
      }
    }

    try {
      const raw = fs.readFileSync(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as SerializedSettings

      if (safeStorage.isEncryptionAvailable()) {
        if (parsed.answerModelEncrypted) {
          parsed.answerModel = safeStorage.decryptString(
            Buffer.from(parsed.answerModelEncrypted, 'base64')
          )
        }

        if (parsed.ollamaBaseUrlEncrypted) {
          parsed.ollamaBaseUrl = safeStorage.decryptString(
            Buffer.from(parsed.ollamaBaseUrlEncrypted, 'base64')
          )
        }
      }

      const mergedVad = {
        remote: {
          ...DEFAULT_SETTINGS.vad.remote,
          ...(parsed.vad?.remote || {})
        },
        self: {
          ...DEFAULT_SETTINGS.vad.self,
          ...(parsed.vad?.self || {})
        }
      }

      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        hotkeys: {
          ...DEFAULT_SETTINGS.hotkeys,
          ...(parsed.hotkeys || {})
        },
        autoHideControlWindow: parsed.autoHideControlWindow !== false,
        systemAudioMode: parsed.systemAudioMode === 'manual' ? 'manual' : 'auto',
        manualSystemSourceId: String(parsed.manualSystemSourceId || ''),
        vad: clampVad(mergedVad),
        vadApplyMode: parsed.vadApplyMode === 'restart' ? 'restart' : 'live'
      }
    } catch {
      return {
        ...DEFAULT_SETTINGS,
        hotkeys: { ...DEFAULT_SETTINGS.hotkeys },
        vad: {
          remote: { ...DEFAULT_SETTINGS.vad.remote },
          self: { ...DEFAULT_SETTINGS.vad.self }
        }
      }
    }
  }

  private save(): void {
    const payload: SerializedSettings = {
      ...this.settings,
      hotkeys: { ...this.settings.hotkeys },
      vad: {
        remote: { ...this.settings.vad.remote },
        self: { ...this.settings.vad.self }
      }
    }

    if (safeStorage.isEncryptionAvailable()) {
      payload.answerModelEncrypted = safeStorage
        .encryptString(this.settings.answerModel)
        .toString('base64')
      payload.ollamaBaseUrlEncrypted = safeStorage
        .encryptString(this.settings.ollamaBaseUrl)
        .toString('base64')
      delete payload.answerModel
      delete payload.ollamaBaseUrl
    }

    fs.writeFileSync(this.settingsPath, JSON.stringify(payload, null, 2), 'utf8')
  }
}
