import type { SDKModel } from '@cursor/sdk'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  CURSOR_PROVIDER,
  type ApiKeyResolver,
  type Config,
} from './config.js'
import type { CursorRuntime } from './cursor-runtime.js'
import { CursorModelCatalog } from './model-catalog.js'
import type { CursorProviderModelSettings } from './provider-settings.js'

export class CursorModelAdapter extends LlmAdapter {
  private cachedAt = 0
  private cachedModels: SDKModel[] = []
  private cacheInitialized = false
  private configuredModels: () => readonly CursorProviderModelSettings[] = () => []

  constructor(
    private readonly runtime: CursorRuntime,
    private readonly config: Config,
    private readonly catalog: CursorModelCatalog,
    private readonly resolveApiKey: ApiKeyResolver,
    private readonly warn: (message: string) => void,
  ) {
    super()
  }

  override providerInfo(provider: string) {
    return { id: provider, name: 'Cursor Agent' }
  }

  setConfiguredModels(source: () => readonly CursorProviderModelSettings[]): void {
    this.configuredModels = source
  }

  async refreshModels(): Promise<readonly SDKModel[]> {
    this.cacheInitialized = false
    this.cachedAt = 0
    this.cachedModels = []
    return this.cursorModels()
  }

  private async cursorModels(): Promise<SDKModel[]> {
    const now = Date.now()
    if (this.cacheInitialized && now - this.cachedAt < this.config.modelCacheMs) {
      return this.cachedModels
    }
    try {
      const models = await this.runtime.listModels(await this.resolveApiKey())
      this.cachedModels = models
      this.cachedAt = now
      this.cacheInitialized = true
      this.catalog.update(models, this.config.defaultModel)
      return models
    } catch (error) {
      this.cachedAt = now
      this.cacheInitialized = true
      this.catalog.update([], this.config.defaultModel)
      this.warn(`Cursor model discovery failed; keeping the "${this.config.defaultModel}" fallback: ${errorMessage(error)}`)
      return this.cachedModels
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const configured = this.configuredModels()
    if (configured.length > 0) {
      return configured.map(model => ({
        provider,
        id: model.id,
        name: model.name || model.id,
        inputModalities: ['text', 'image'],
      }))
    }

    await this.cursorModels()
    return this.catalog.list(provider)
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const configured = this.configuredModels().find(candidate => candidate.id === model)
    if (!this.catalog.has(model)) await this.cursorModels()
    const resolved = this.catalog.resolve(provider, model)
    return configured?.name === undefined
      ? resolved
      : { ...resolved, name: configured.name }
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new LlmError(
      'The cursor-agent route is a catalog for the custom AgentFactory and cannot be called as an LLM adapter',
      'UNSUPPORTED',
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export { CURSOR_PROVIDER }
