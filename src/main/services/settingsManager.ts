import { app, safeStorage } from 'electron'
import fs from 'fs'
import path from 'path'
import { AppSettings } from '../../shared/contracts'

const SETTINGS_FILE = 'settings.json'

const DEFAULT_SETTINGS: AppSettings = {
  sttModel: 'small.en',
  answerModel: 'qwen2.5:7b-instruct-q4_K_M',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  overlayOpacity: 0.78,
  overlayVisible: true,
  overlayClickThrough: true,
  historyOptIn: false,
  hotkeys: {
    toggleOverlay: 'CommandOrControl+Shift+O',
    muteSuggestions: 'CommandOrControl+Shift+M',
    panicHide: 'CommandOrControl+Shift+H'
  }
}

type SerializedSettings = Omit<AppSettings, 'answerModel' | 'ollamaBaseUrl'> & {
  answerModelEncrypted?: string
  ollamaBaseUrlEncrypted?: string
  answerModel?: string
  ollamaBaseUrl?: string
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
    return { ...this.settings, hotkeys: { ...this.settings.hotkeys } }
  }

  update(updates: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...updates,
      hotkeys: {
        ...this.settings.hotkeys,
        ...(updates.hotkeys || {})
      }
    }

    this.settings.overlayOpacity = Math.min(1, Math.max(0.25, this.settings.overlayOpacity))
    this.save()
    return this.get()
  }

  private load(): AppSettings {
    if (!fs.existsSync(this.settingsPath)) {
      return { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_SETTINGS.hotkeys } }
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

      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        hotkeys: {
          ...DEFAULT_SETTINGS.hotkeys,
          ...(parsed.hotkeys || {})
        }
      }
    } catch {
      return { ...DEFAULT_SETTINGS, hotkeys: { ...DEFAULT_SETTINGS.hotkeys } }
    }
  }

  private save(): void {
    const payload: SerializedSettings = {
      ...this.settings,
      hotkeys: { ...this.settings.hotkeys }
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
