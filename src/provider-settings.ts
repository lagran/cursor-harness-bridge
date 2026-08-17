import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'

// Harness RC.6 ships hand-written model-setting cards only for the
// llm-deepseek and llm-pi-ai namespace shapes. The official DeepSeek adapter
// is disabled in this profile, so this bridge owns the compatible whole-route
// namespace and exposes Cursor's credential reference plus catalog through it.
export const CURSOR_SETTINGS_NAMESPACE = settingsNamespace('llm-deepseek')

export interface CursorProviderModelSettings {
  id: string
  name?: string
}

export interface CursorProviderSettings {
  apiKeyEnv: string
  baseURL?: string
  models: CursorProviderModelSettings[]
}

export const CursorProviderSettingsSchema: z<CursorProviderSettings> = z.object({
  apiKeyEnv: z.string().default('CURSOR_API_KEY'),
  baseURL: z.string(),
  models: z.array(z.object({
    id: z.string().required(),
    name: z.string(),
  })).default([]),
})

export function cursorProviderSettings(
  apiKeyEnv: string,
): CursorProviderSettings {
  return {
    apiKeyEnv,
    // Keep the composition base empty: an empty list means "use the adapter's
    // live catalog". A user-authored non-empty list remains an explicit
    // settings override, while credential rotation can refresh defaults
    // without freezing the startup fallback into settings.
    models: [],
  }
}
