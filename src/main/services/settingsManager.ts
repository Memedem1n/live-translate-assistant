import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { AppSettings, VadConfig } from '../../shared/contracts'

const SETTINGS_FILE = 'settings.json'

const LEGACY_DEFAULT_VAD: VadConfig = {
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

const DEFAULT_VAD: VadConfig = {
  remote: {
    minAudioMs: 560,
    silenceMs: 540,
    voiceRmsThreshold: 320
  },
  self: {
    minAudioMs: 560,
    silenceMs: 540,
    voiceRmsThreshold: 220
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  assistantMode: 'meeting',
  personalizationEnabled: true,
  assistPersonalizationPolicy: 'intent_aware',
  assistCompositionPolicy: 'auto',
  assistLanguagePolicy: 'auto',
  githubSyncEnabled: true,
  interviewAnswerStyle: 'star_short_30s',
  sttModel: 'large-v3',
  sttRuntimeMode: 'cuda',
  sttLanguageMode: 'segment_auto',
  manualSttLanguage: 'tr',
  answerModel: 'qwen2.5:14b-instruct-q4_K_M',
  assistOutputPolicy: 'source_based',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  overlayOpacity: 0.78,
  overlayVisible: true,
  overlayClickThrough: true,
  autoHideControlWindow: true,
  captureMicrophone: false,
  systemAudioMode: 'auto',
  systemAudioStrategy: 'auto_live',
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

function normalizeSttModel(value: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return DEFAULT_SETTINGS.sttModel
  const lowered = trimmed.toLowerCase()
  if (lowered.endsWith('.en')) {
    return 'large-v3'
  }
  return trimmed
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

function isLegacyDefaultVad(config: VadConfig): boolean {
  return (
    config.remote.minAudioMs === LEGACY_DEFAULT_VAD.remote.minAudioMs &&
    config.remote.silenceMs === LEGACY_DEFAULT_VAD.remote.silenceMs &&
    config.remote.voiceRmsThreshold === LEGACY_DEFAULT_VAD.remote.voiceRmsThreshold &&
    config.self.minAudioMs === LEGACY_DEFAULT_VAD.self.minAudioMs &&
    config.self.silenceMs === LEGACY_DEFAULT_VAD.self.silenceMs &&
    config.self.voiceRmsThreshold === LEGACY_DEFAULT_VAD.self.voiceRmsThreshold
  )
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
    this.settings.captureMicrophone = this.settings.captureMicrophone === true
    this.settings.systemAudioMode = this.settings.systemAudioMode === 'manual' ? 'manual' : 'auto'
    this.settings.systemAudioStrategy =
      this.settings.systemAudioStrategy === 'picker_each_start'
        ? 'picker_each_start'
        : this.settings.systemAudioStrategy === 'manual'
          ? 'manual'
          : this.settings.systemAudioMode === 'manual'
            ? 'manual'
            : 'auto_live'
    this.settings.manualSystemSourceId = String(this.settings.manualSystemSourceId || '')
    this.settings.sttRuntimeMode =
      this.settings.sttRuntimeMode === 'cuda'
        ? 'cuda'
        : this.settings.sttRuntimeMode === 'cpu'
          ? 'cpu'
          : 'auto'
    this.settings.sttLanguageMode =
      this.settings.sttLanguageMode === 'manual'
        ? 'manual'
        : this.settings.sttLanguageMode === 'session_lock'
          ? 'session_lock'
          : 'segment_auto'
    this.settings.assistantMode = this.settings.assistantMode === 'interview' ? 'interview' : 'meeting'
    this.settings.personalizationEnabled = this.settings.personalizationEnabled !== false
    this.settings.assistPersonalizationPolicy =
      this.settings.assistPersonalizationPolicy === 'always' ? 'always' : 'intent_aware'
    this.settings.assistCompositionPolicy =
      this.settings.assistCompositionPolicy === 'general_then_profile'
        ? 'general_then_profile'
        : this.settings.assistCompositionPolicy === 'profile_only'
          ? 'profile_only'
          : 'auto'
    this.settings.assistLanguagePolicy =
      this.settings.assistLanguagePolicy === 'tr'
        ? 'tr'
        : this.settings.assistLanguagePolicy === 'bilingual'
          ? 'bilingual'
          : 'auto'
    this.settings.githubSyncEnabled = this.settings.githubSyncEnabled !== false
    this.settings.interviewAnswerStyle = 'star_short_30s'
    this.settings.manualSttLanguage = this.settings.manualSttLanguage === 'en' ? 'en' : 'tr'
    this.settings.assistOutputPolicy =
      this.settings.assistOutputPolicy === 'bilingual' ? 'bilingual' : 'source_based'
    this.settings.sttModel = normalizeSttModel(this.settings.sttModel)
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
      const clampedVad = clampVad(mergedVad)
      const migratedVad = isLegacyDefaultVad(clampedVad)
        ? {
            remote: { ...DEFAULT_SETTINGS.vad.remote },
            self: { ...DEFAULT_SETTINGS.vad.self }
          }
        : clampedVad

      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        hotkeys: {
          ...DEFAULT_SETTINGS.hotkeys,
          ...(parsed.hotkeys || {})
        },
        autoHideControlWindow: parsed.autoHideControlWindow !== false,
        captureMicrophone: parsed.captureMicrophone === true,
        systemAudioMode: parsed.systemAudioMode === 'manual' ? 'manual' : 'auto',
        systemAudioStrategy:
          parsed.systemAudioStrategy === 'picker_each_start'
            ? 'picker_each_start'
            : parsed.systemAudioStrategy === 'manual'
              ? 'manual'
              : parsed.systemAudioMode === 'manual'
                ? 'manual'
                : 'auto_live',
        manualSystemSourceId: String(parsed.manualSystemSourceId || ''),
        sttLanguageMode:
          parsed.sttLanguageMode === 'manual'
            ? 'manual'
            : parsed.sttLanguageMode === 'session_lock'
              ? 'session_lock'
              : 'segment_auto',
        assistantMode: parsed.assistantMode === 'interview' ? 'interview' : 'meeting',
        personalizationEnabled: parsed.personalizationEnabled !== false,
        assistPersonalizationPolicy:
          parsed.assistPersonalizationPolicy === 'always' ? 'always' : 'intent_aware',
        assistCompositionPolicy:
          parsed.assistCompositionPolicy === 'general_then_profile'
            ? 'general_then_profile'
            : parsed.assistCompositionPolicy === 'profile_only'
              ? 'profile_only'
              : 'auto',
        assistLanguagePolicy:
          parsed.assistLanguagePolicy === 'tr'
            ? 'tr'
            : parsed.assistLanguagePolicy === 'bilingual'
              ? 'bilingual'
              : 'auto',
        githubSyncEnabled: parsed.githubSyncEnabled !== false,
        interviewAnswerStyle: 'star_short_30s',
        manualSttLanguage: parsed.manualSttLanguage === 'en' ? 'en' : 'tr',
        assistOutputPolicy: parsed.assistOutputPolicy === 'bilingual' ? 'bilingual' : 'source_based',
        sttModel: normalizeSttModel(parsed.sttModel || DEFAULT_SETTINGS.sttModel),
        sttRuntimeMode:
          parsed.sttRuntimeMode === 'cuda'
            ? 'cuda'
            : parsed.sttRuntimeMode === 'cpu'
              ? 'cpu'
              : 'auto',
        vad: migratedVad,
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
