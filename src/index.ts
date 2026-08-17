import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import {
  Config,
  assertRuntimePrerequisites,
  type Config as BridgeConfig,
} from './config.js'
import { defaultCursorRuntime } from './cursor-runtime.js'
import { CursorAgentFactory } from './factory.js'
import { CURSOR_PROVIDER, CursorModelAdapter } from './model-adapter.js'
import { CursorModelCatalog } from './model-catalog.js'
import {
  CURSOR_SETTINGS_NAMESPACE,
  CursorProviderSettingsSchema,
  cursorProviderSettings,
} from './provider-settings.js'

export const name = 'cursor-harness-bridge'
export const inject = [
  'agents',
  'sessions',
  'llm',
  'systemPrompt',
  'attachments',
  'credentials',
]
export { Config }

export async function apply(ctx: Context, config: BridgeConfig): Promise<void> {
  assertRuntimePrerequisites(config)
  const modelCatalog = new CursorModelCatalog()
  const apiKeyRef = credentialRef(config.apiKeyEnv)
  const resolveApiKey = async (): Promise<string | undefined> => {
    const resolved = await ctx.credentials.resolve(apiKeyRef)
    const value = resolved?.value.trim()
    return value || undefined
  }
  const adapter = new CursorModelAdapter(
    defaultCursorRuntime,
    config,
    modelCatalog,
    resolveApiKey,
    message => ctx.logger.warn(message),
  )
  const initialModels = await adapter.listModels(CURSOR_PROVIDER)
  const settingsEntry = cursorProviderSettings(config.apiKeyEnv)
  let settingsSource = () => settingsEntry
  let adapterRegistration: AdapterRegistrationHandle | undefined

  adapter.setConfiguredModels(() => settingsSource().models)
  installSettingsSection(
    ctx,
    CURSOR_SETTINGS_NAMESPACE,
    CursorProviderSettingsSchema,
    settingsEntry,
    {
      setSource: current => {
        settingsSource = current
      },
      onChange: () => {
        adapterRegistration?.replace([CURSOR_PROVIDER])
      },
    },
  )
  ctx.llm.registerConfigurableProviders([{
    provider: CURSOR_PROVIDER,
    displayName: 'Cursor Agent',
    settingsNs: CURSOR_SETTINGS_NAMESPACE,
    settingsPath: [],
    declared: false,
  }])
  adapterRegistration = ctx.llm.registerAdapter([CURSOR_PROVIDER], adapter)
  let credentialRefresh: Promise<void> = Promise.resolve()
  ctx.on('credentials/updated', updatedRef => {
    if (updatedRef !== apiKeyRef) return
    credentialRefresh = credentialRefresh.then(async () => {
      await adapter.refreshModels()
      adapterRegistration?.replace([CURSOR_PROVIDER])
      ctx.logger.info(`Cursor model catalog refreshed after ${config.apiKeyEnv} changed`)
    }).catch(error => {
      ctx.logger.warn(`Cursor model catalog refresh failed: ${errorMessage(error)}`)
    })
  })

  const factory = new CursorAgentFactory(
    ctx,
    config,
    defaultCursorRuntime,
    modelCatalog,
    resolveApiKey,
  )
  ctx.agents.setFactory(factory)
  ctx.effect(
    () => () => factory.dispose(),
    'cursorHarnessBridge.dispose()',
  )

  ctx.logger.info(
    `Cursor AgentFactory active (models=${initialModels.length}, default=${config.defaultModel}, sandbox=${config.sandbox}, autoReview=${config.autoReview})`,
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { CursorHarnessAgent } from './cursor-agent.js'
export { CursorEventMapper, UnsupportedCursorRequestError } from './event-mapper.js'
export { CursorAgentFactory } from './factory.js'
export { CursorModelAdapter } from './model-adapter.js'
export { CursorModelCatalog } from './model-catalog.js'
export type { CursorRuntime } from './cursor-runtime.js'

export default { name, inject, Config, apply }
