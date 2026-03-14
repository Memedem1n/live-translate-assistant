import { AppSettings, ProviderKind } from '../../../../shared/contracts'
import { PROFILE_PRESETS, STT_MODELS } from './shared'

interface AdvancedSettingsDrawerProps {
  open: boolean
  settings: AppSettings
  savingSettings: boolean
  onPatchSettings: (updates: Partial<AppSettings>) => void
  onSaveSettings: () => Promise<void>
  onClose: () => void
}

export function AdvancedSettingsDrawer(
  props: AdvancedSettingsDrawerProps
): React.JSX.Element | null {
  const { open, settings, savingSettings, onPatchSettings, onSaveSettings, onClose } = props

  if (!open) return null

  return (
    <div className="drawer-root" role="presentation">
      <button className="drawer-backdrop" aria-label="Close advanced settings" onClick={onClose} />
      <aside className="drawer-panel" aria-label="Advanced settings">
        <div className="drawer-head">
          <div>
            <div className="eyebrow">Advanced</div>
            <h2>Detailed setup</h2>
            <p>Most users do not need these settings. Keep them here when you want full control.</p>
          </div>
          <div className="inline-actions">
            <button className="secondary-btn" disabled={savingSettings} onClick={() => void onSaveSettings()}>
              {savingSettings ? 'Saving...' : 'Save preferences'}
            </button>
            <button className="ghost-btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>

        <div className="drawer-sections">
          <section className="drawer-section">
            <div className="section-kicker">Answer Engine</div>
            <div className="field-grid two-up">
              <label className="field">
                <span>Answer profile</span>
                <select
                  value={settings.inferenceProfileId}
                  onChange={(event) => {
                    const next = PROFILE_PRESETS.find((item) => item.id === event.target.value) || PROFILE_PRESETS[0]
                    onPatchSettings({
                      inferenceProfileId: next.id,
                      providerConfig: {
                        inference: { ...settings.providerConfig.inference, model: next.model },
                        translation: { ...settings.providerConfig.translation }
                      }
                    })
                  }}
                >
                  {PROFILE_PRESETS.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Inference provider</span>
                <select
                  value={settings.providerConfig.inference.kind}
                  onChange={(event) =>
                    onPatchSettings({
                      providerConfig: {
                        inference: {
                          ...settings.providerConfig.inference,
                          kind: event.target.value as ProviderKind
                        },
                        translation: { ...settings.providerConfig.translation }
                      }
                    })
                  }
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai_compatible">OpenAI compatible</option>
                </select>
              </label>
            </div>
            <label className="field">
              <span>Inference model</span>
              <input
                value={settings.providerConfig.inference.model}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference, model: event.target.value },
                      translation: { ...settings.providerConfig.translation }
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>Inference base URL</span>
              <input
                value={settings.providerConfig.inference.baseUrl}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference, baseUrl: event.target.value },
                      translation: { ...settings.providerConfig.translation }
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>Inference API key</span>
              <input
                type="password"
                placeholder="Optional"
                value={settings.providerConfig.inference.apiKey || ''}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference, apiKey: event.target.value },
                      translation: { ...settings.providerConfig.translation }
                    }
                  })
                }
              />
            </label>
          </section>

          <section className="drawer-section">
            <div className="section-kicker">Translation Helper</div>
            <label className="inline-toggle">
              <span>Enable Turkish helper</span>
              <input
                type="checkbox"
                checked={settings.helperTranslationEnabled}
                onChange={(event) =>
                  onPatchSettings({
                    helperTranslationEnabled: event.target.checked,
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference },
                      translation: {
                        ...settings.providerConfig.translation,
                        enabled: event.target.checked
                      }
                    }
                  })
                }
              />
            </label>
            <div className="field-grid two-up">
              <label className="field">
                <span>Translation provider</span>
                <select
                  disabled={!settings.helperTranslationEnabled}
                  value={settings.providerConfig.translation.kind}
                  onChange={(event) =>
                    onPatchSettings({
                      providerConfig: {
                        inference: { ...settings.providerConfig.inference },
                        translation: {
                          ...settings.providerConfig.translation,
                          kind: event.target.value as ProviderKind
                        }
                      }
                    })
                  }
                >
                  <option value="ollama">Ollama</option>
                  <option value="openai_compatible">OpenAI compatible</option>
                </select>
              </label>
              <label className="field">
                <span>Speech model</span>
                <select
                  value={settings.sttModel}
                  onChange={(event) => onPatchSettings({ sttModel: event.target.value })}
                >
                  {STT_MODELS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>Translation model</span>
              <input
                disabled={!settings.helperTranslationEnabled}
                value={settings.providerConfig.translation.model}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference },
                      translation: { ...settings.providerConfig.translation, model: event.target.value }
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>Translation base URL</span>
              <input
                disabled={!settings.helperTranslationEnabled}
                value={settings.providerConfig.translation.baseUrl}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference },
                      translation: { ...settings.providerConfig.translation, baseUrl: event.target.value }
                    }
                  })
                }
              />
            </label>
            <label className="field">
              <span>Translation API key</span>
              <input
                type="password"
                placeholder="Optional"
                disabled={!settings.helperTranslationEnabled}
                value={settings.providerConfig.translation.apiKey || ''}
                onChange={(event) =>
                  onPatchSettings({
                    providerConfig: {
                      inference: { ...settings.providerConfig.inference },
                      translation: { ...settings.providerConfig.translation, apiKey: event.target.value }
                    }
                  })
                }
              />
            </label>
          </section>

          <section className="drawer-section">
            <div className="section-kicker">Behavior</div>
            <div className="field-grid two-up">
              <label className="field">
                <span>Runtime mode</span>
                <select
                  value={settings.sttRuntimeMode}
                  onChange={(event) =>
                    onPatchSettings({
                      sttRuntimeMode:
                        event.target.value === 'cpu'
                          ? 'cpu'
                          : event.target.value === 'cuda'
                            ? 'cuda'
                            : 'auto'
                    })
                  }
                >
                  <option value="cuda">cuda</option>
                  <option value="auto">auto</option>
                  <option value="cpu">cpu</option>
                </select>
              </label>
              <label className="field">
                <span>Personalization policy</span>
                <select
                  value={settings.assistPersonalizationPolicy}
                  onChange={(event) =>
                    onPatchSettings({
                      assistPersonalizationPolicy:
                        event.target.value === 'always' ? 'always' : 'intent_aware'
                    })
                  }
                >
                  <option value="intent_aware">Intent aware</option>
                  <option value="always">Always use profile</option>
                </select>
              </label>
            </div>
            <div className="field-grid two-up">
              <label className="field">
                <span>Composition policy</span>
                <select
                  value={settings.assistCompositionPolicy}
                  onChange={(event) =>
                    onPatchSettings({
                      assistCompositionPolicy:
                        event.target.value === 'general_then_profile'
                          ? 'general_then_profile'
                          : event.target.value === 'profile_only'
                            ? 'profile_only'
                            : 'auto'
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="general_then_profile">General then profile</option>
                  <option value="profile_only">Profile only</option>
                </select>
              </label>
              <label className="field">
                <span>Audio source behavior</span>
                <select
                  value={settings.systemAudioStrategy}
                  onChange={(event) =>
                    onPatchSettings({
                      systemAudioStrategy: event.target.value === 'manual' ? 'manual' : 'picker_each_start'
                    })
                  }
                >
                  <option value="picker_each_start">Ask each start</option>
                  <option value="manual">Fixed source</option>
                </select>
              </label>
            </div>
            <div className="settings-card-grid">
              <label className="inline-toggle card-toggle">
                <span>
                  <strong>Capture microphone</strong>
                  <small>Useful if you want the app to listen to your side as well.</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.captureMicrophone}
                  onChange={(event) => onPatchSettings({ captureMicrophone: event.target.checked })}
                />
              </label>
              <label className="inline-toggle card-toggle">
                <span>
                  <strong>Auto-hide control panel</strong>
                  <small>Hide the main panel after a session starts.</small>
                </span>
                <input
                  type="checkbox"
                  checked={settings.autoHideControlWindow}
                  onChange={(event) => onPatchSettings({ autoHideControlWindow: event.target.checked })}
                />
              </label>
            </div>
          </section>

          <details className="drawer-section details-block">
            <summary>VAD and timing controls</summary>
            <div className="field-grid two-up">
              <label className="field">
                <span>Remote min audio (ms)</span>
                <input
                  type="number"
                  value={settings.vad.remote.minAudioMs}
                  onChange={(event) =>
                    onPatchSettings({
                      vad: {
                        ...settings.vad,
                        remote: {
                          ...settings.vad.remote,
                          minAudioMs: Number(event.target.value)
                        }
                      }
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Remote silence (ms)</span>
                <input
                  type="number"
                  value={settings.vad.remote.silenceMs}
                  onChange={(event) =>
                    onPatchSettings({
                      vad: {
                        ...settings.vad,
                        remote: {
                          ...settings.vad.remote,
                          silenceMs: Number(event.target.value)
                        }
                      }
                    })
                  }
                />
              </label>
            </div>
            <div className="field-grid two-up">
              <label className="field">
                <span>Remote RMS threshold</span>
                <input
                  type="number"
                  value={settings.vad.remote.voiceRmsThreshold}
                  onChange={(event) =>
                    onPatchSettings({
                      vad: {
                        ...settings.vad,
                        remote: {
                          ...settings.vad.remote,
                          voiceRmsThreshold: Number(event.target.value)
                        }
                      }
                    })
                  }
                />
              </label>
              <label className="field">
                <span>Self RMS threshold</span>
                <input
                  type="number"
                  value={settings.vad.self.voiceRmsThreshold}
                  onChange={(event) =>
                    onPatchSettings({
                      vad: {
                        ...settings.vad,
                        self: {
                          ...settings.vad.self,
                          voiceRmsThreshold: Number(event.target.value)
                        }
                      }
                    })
                  }
                />
              </label>
            </div>
          </details>
        </div>
      </aside>
    </div>
  )
}
