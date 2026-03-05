import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { AppSettings, InferenceProfileId, ProviderConfig, VadConfig } from '../../shared/contracts'

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

const DEFAULT_PROVIDER_CONFIG: ProviderConfig = {
  inference: {
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'llama3.1:8b-instruct-q4_K_M'
  },
  translation: {
    enabled: true,
    kind: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:3b-instruct-q4_K_M'
  }
}

const DEFAULT_SETTINGS: AppSettings = {
  productMode: 'interview_live',
  personalizationEnabled: true,
  assistPersonalizationPolicy: 'intent_aware',
  assistCompositionPolicy: 'auto',
  githubSyncEnabled: true,
  interviewAnswerStyle: 'natural_first_person',
  sessionLanguage: 'en',
  sttModel: 'medium.en',
  sttRuntimeMode: 'cuda',
  inferenceProfileId: 'llama3_1_8b_primary',
  helperTranslationEnabled: true,
  providerConfig: {
    inference: { ...DEFAULT_PROVIDER_CONFIG.inference },
    translation: { ...DEFAULT_PROVIDER_CONFIG.translation }
  },
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

type SerializedSettings = Omit<AppSettings, 'providerConfig'> & {
  providerConfigEncrypted?: string
  providerConfig?: ProviderConfig
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

function normalizeInferenceProfileId(value: string | undefined): InferenceProfileId {
  const lowered = String(value || '').trim().toLowerCase()
  if (lowered === 'qwen2_5_7b_latency') return 'qwen2_5_7b_latency'
  if (lowered === 'mistral_7b_natural') return 'mistral_7b_natural'
  return 'llama3_1_8b_primary'
}

function normalizeProviderConfig(config?: Partial<ProviderConfig> | null): ProviderConfig {
  return {
    inference: {
      kind: config?.inference?.kind === 'openai_compatible' ? 'openai_compatible' : 'ollama',
      baseUrl: String(config?.inference?.baseUrl || DEFAULT_PROVIDER_CONFIG.inference.baseUrl),
      model: String(config?.inference?.model || DEFAULT_PROVIDER_CONFIG.inference.model),
      apiKey: config?.inference?.apiKey ? String(config.inference.apiKey) : undefined
    },
    translation: {
      enabled: config?.translation?.enabled !== false,
      kind: config?.translation?.kind === 'openai_compatible' ? 'openai_compatible' : 'ollama',
      baseUrl: String(config?.translation?.baseUrl || DEFAULT_PROVIDER_CONFIG.translation.baseUrl),
      model: String(config?.translation?.model || DEFAULT_PROVIDER_CONFIG.translation.model),
      apiKey: config?.translation?.apiKey ? String(config.translation.apiKey) : undefined
    }
  }
}

function legacyProviderConfig(answerModel?: string, ollamaBaseUrl?: string): ProviderConfig {
  return {
    inference: {
      kind: 'ollama',
      baseUrl: String(ollamaBaseUrl || DEFAULT_PROVIDER_CONFIG.inference.baseUrl),
      model: String(answerModel || DEFAULT_PROVIDER_CONFIG.inference.model)
    },
    translation: {
      enabled: true,
      kind: 'ollama',
      baseUrl: String(ollamaBaseUrl || DEFAULT_PROVIDER_CONFIG.translation.baseUrl),
      model: DEFAULT_PROVIDER_CONFIG.translation.model
    }
  }
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const next: AppSettings = {
    ...settings,
    providerConfig: normalizeProviderConfig(settings.providerConfig),
    hotkeys: { ...settings.hotkeys },
    vad: {
      remote: { ...settings.vad.remote },
      self: { ...settings.vad.self }
    }
  }

  next.productMode = next.productMode === 'interview_practice' ? 'interview_practice' : 'interview_live'
  next.personalizationEnabled = next.personalizationEnabled !== false
  next.assistPersonalizationPolicy =
    next.assistPersonalizationPolicy === 'always' ? 'always' : 'intent_aware'
  next.assistCompositionPolicy =
    next.assistCompositionPolicy === 'general_then_profile'
      ? 'general_then_profile'
      : next.assistCompositionPolicy === 'profile_only'
        ? 'profile_only'
        : 'auto'
  next.githubSyncEnabled = next.githubSyncEnabled !== false
  next.interviewAnswerStyle = 'natural_first_person'
  next.sessionLanguage = 'en'
  next.sttRuntimeMode =
    next.sttRuntimeMode === 'cuda' ? 'cuda' : next.sttRuntimeMode === 'cpu' ? 'cpu' : 'auto'
  next.inferenceProfileId = normalizeInferenceProfileId(next.inferenceProfileId)
  next.helperTranslationEnabled = next.helperTranslationEnabled !== false
  next.providerConfig = normalizeProviderConfig(next.providerConfig)
  next.overlayOpacity = Math.min(1, Math.max(0.25, next.overlayOpacity))
  next.autoHideControlWindow = next.autoHideControlWindow !== false
  next.captureMicrophone = next.captureMicrophone === true
  next.systemAudioMode = next.systemAudioMode === 'manual' ? 'manual' : 'auto'
  next.systemAudioStrategy =
    next.systemAudioStrategy === 'picker_each_start'
      ? 'picker_each_start'
      : next.systemAudioStrategy === 'manual'
        ? 'manual'
        : next.systemAudioMode === 'manual'
          ? 'manual'
          : 'auto_live'
  next.manualSystemSourceId = String(next.manualSystemSourceId || '')
  next.historyOptIn = next.historyOptIn === true
  next.vad = clampVad(next.vad)
  next.vadApplyMode = next.vadApplyMode === 'restart' ? 'restart' : 'live'
  return next
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
      providerConfig: normalizeProviderConfig(this.settings.providerConfig),
      hotkeys: { ...this.settings.hotkeys },
      vad: {
        remote: { ...this.settings.vad.remote },
        self: { ...this.settings.vad.self }
      }
    }
  }

  update(updates: Partial<AppSettings>): AppSettings {
    this.settings = normalizeSettings({
      ...this.settings,
      ...updates,
      providerConfig: updates.providerConfig
        ? normalizeProviderConfig({
            inference: {
              ...this.settings.providerConfig.inference,
              ...(updates.providerConfig.inference || {})
            },
            translation: {
              ...this.settings.providerConfig.translation,
              ...(updates.providerConfig.translation || {})
            }
          })
        : this.settings.providerConfig,
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
    })
    this.save()
    return this.get()
  }

  private load(): AppSettings {
    if (!fs.existsSync(this.settingsPath)) {
      return {
        ...DEFAULT_SETTINGS,
        providerConfig: normalizeProviderConfig(DEFAULT_SETTINGS.providerConfig),
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

      if (parsed.providerConfigEncrypted) {
        parsed.providerConfig = JSON.parse(
          safeStorage.decryptString(Buffer.from(parsed.providerConfigEncrypted, 'base64'))
        ) as ProviderConfig
      }

      const providerConfig = parsed.providerConfig
        ? normalizeProviderConfig(parsed.providerConfig)
        : legacyProviderConfig(parsed.answerModel, parsed.ollamaBaseUrl)

      const vad = parsed.vad ? clampVad(parsed.vad) : { ...DEFAULT_SETTINGS.vad }
      const normalizedVad = isLegacyDefaultVad(vad) ? clampVad(DEFAULT_VAD) : vad

      const loaded: AppSettings = {
        productMode: parsed.productMode === 'interview_practice' ? 'interview_practice' : 'interview_live',
        personalizationEnabled: parsed.personalizationEnabled !== false,
        assistPersonalizationPolicy: parsed.assistPersonalizationPolicy === 'always' ? 'always' : 'intent_aware',
        assistCompositionPolicy:
          parsed.assistCompositionPolicy === 'general_then_profile'
            ? 'general_then_profile'
            : parsed.assistCompositionPolicy === 'profile_only'
              ? 'profile_only'
              : 'auto',
        githubSyncEnabled: parsed.githubSyncEnabled !== false,
        interviewAnswerStyle: 'natural_first_person',
        sessionLanguage: 'en',
        sttModel: String(parsed.sttModel || DEFAULT_SETTINGS.sttModel),
        sttRuntimeMode:
          parsed.sttRuntimeMode === 'cuda'
            ? 'cuda'
            : parsed.sttRuntimeMode === 'cpu'
              ? 'cpu'
              : 'auto',
        inferenceProfileId: normalizeInferenceProfileId(parsed.inferenceProfileId),
        helperTranslationEnabled: parsed.helperTranslationEnabled !== false,
        providerConfig,
        overlayOpacity: Number.isFinite(parsed.overlayOpacity) ? parsed.overlayOpacity : DEFAULT_SETTINGS.overlayOpacity,
        overlayVisible: parsed.overlayVisible !== false,
        overlayClickThrough: parsed.overlayClickThrough !== false,
        autoHideControlWindow: parsed.autoHideControlWindow !== false,
        captureMicrophone: parsed.captureMicrophone === true,
        systemAudioMode: parsed.systemAudioMode === 'manual' ? 'manual' : 'auto',
        systemAudioStrategy:
          parsed.systemAudioStrategy === 'picker_each_start'
            ? 'picker_each_start'
            : parsed.systemAudioStrategy === 'manual'
              ? 'manual'
              : 'auto_live',
        manualSystemSourceId: String(parsed.manualSystemSourceId || ''),
        historyOptIn: parsed.historyOptIn === true,
        hotkeys: {
          toggleOverlay: parsed.hotkeys?.toggleOverlay || DEFAULT_SETTINGS.hotkeys.toggleOverlay,
          muteSuggestions: parsed.hotkeys?.muteSuggestions || DEFAULT_SETTINGS.hotkeys.muteSuggestions,
          panicHide: parsed.hotkeys?.panicHide || DEFAULT_SETTINGS.hotkeys.panicHide
        },
        vad: normalizedVad,
        vadApplyMode: parsed.vadApplyMode === 'restart' ? 'restart' : 'live'
      }

      return normalizeSettings(loaded)
    } catch {
      return {
        ...DEFAULT_SETTINGS,
        providerConfig: normalizeProviderConfig(DEFAULT_SETTINGS.providerConfig),
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
      providerConfig: undefined
    }

    if (safeStorage.isEncryptionAvailable()) {
      payload.providerConfigEncrypted = safeStorage
        .encryptString(JSON.stringify(this.settings.providerConfig))
        .toString('base64')
      delete payload.providerConfig
    } else {
      payload.providerConfig = this.settings.providerConfig
    }

    fs.mkdirSync(path.dirname(this.settingsPath), { recursive: true })
    fs.writeFileSync(this.settingsPath, JSON.stringify(payload, null, 2), 'utf8')
  }
}
