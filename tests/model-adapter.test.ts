import type { LocalAgentStore } from '@cursor/sdk'
import { describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import type { CursorRuntime } from '../src/cursor-runtime.js'
import { CursorModelAdapter } from '../src/model-adapter.js'
import { CursorModelCatalog } from '../src/model-catalog.js'

const config: Config = {
  apiKeyEnv: 'CURSOR_API_KEY_TEST_MISSING',
  defaultModel: 'auto',
  settingSources: [],
  additionalDirs: [],
  modelCacheMs: 60_000,
  workspaceScanCacheMs: 300_000,
  runStallMs: 90_000,
}

describe('CursorModelAdapter', () => {
  it('keeps the Auto fallback and caches a failed discovery', async () => {
    let calls = 0
    const runtime = runtimeWithModels(async () => {
      calls++
      throw new Error('no key')
    })
    const catalog = new CursorModelCatalog()
    const adapter = new CursorModelAdapter(
      runtime,
      config,
      catalog,
      async () => undefined,
      () => {},
    )

    expect(await adapter.listModels('cursor-agent')).toEqual([
      {
        provider: 'cursor-agent',
        id: 'auto',
        name: 'Cursor Auto',
        inputModalities: ['text', 'image'],
      },
    ])
    await adapter.listModels('cursor-agent')
    expect(calls).toBe(1)
  })

  it('refreshes the fallback catalog after a credential is stored', async () => {
    let key: string | undefined
    let calls = 0
    const runtime = runtimeWithModels(async apiKey => {
      calls++
      if (apiKey !== 'stored-key') throw new Error('no key')
      return [{ id: 'grok-4.6', displayName: 'Cursor Grok 4.6' }]
    })
    const catalog = new CursorModelCatalog()
    const adapter = new CursorModelAdapter(
      runtime,
      config,
      catalog,
      async () => key,
      () => {},
    )

    expect((await adapter.listModels('cursor-agent')).map(model => model.id)).toEqual([
      'auto',
    ])
    key = 'stored-key'
    await adapter.refreshModels()
    expect((await adapter.listModels('cursor-agent')).map(model => model.id)).toEqual([
      'auto',
      'grok-4.6',
    ])
    expect(calls).toBe(2)
  })

  it('maps Cursor Router modes through Harness reasoning effort', async () => {
    const runtime = runtimeWithModels(async () => [{
      id: 'auto-smart',
      displayName: 'Cursor Router',
      parameters: [{
        id: 'optimize_for',
        values: [
          { value: 'cost' },
          { value: 'balanced' },
          { value: 'intelligence' },
        ],
      }],
      variants: [
        {
          params: [{ id: 'optimize_for', value: 'cost' }],
          displayName: 'Auto Cost',
        },
        {
          params: [{ id: 'optimize_for', value: 'balanced' }],
          displayName: 'Auto Balance',
          isDefault: true,
        },
        {
          params: [{ id: 'optimize_for', value: 'intelligence' }],
          displayName: 'Auto Intelligence',
        },
      ],
    }])
    const catalog = new CursorModelCatalog()
    const adapter = new CursorModelAdapter(
      runtime,
      config,
      catalog,
      async () => undefined,
      () => {},
    )
    const resolved = await adapter.resolveModel('cursor-agent', 'auto-smart')

    expect(resolved.reasoning?.efforts.map(effort => String(effort.id))).toEqual([
      'cost',
      'balanced',
      'intelligence',
    ])
    expect(String(resolved.reasoning?.defaultEffort)).toBe('balanced')
    expect(catalog.selection('auto-smart', 'intelligence')).toEqual({
      id: 'auto-smart',
      params: [{ id: 'optimize_for', value: 'intelligence' }],
    })
  })

  it('reuses the startup catalog instead of hitting get_models per request', async () => {
    let calls = 0
    const runtime = runtimeWithModels(async () => {
      calls++
      return [{ id: 'grok-4.6', displayName: 'Cursor Grok 4.6' }]
    })
    const catalog = new CursorModelCatalog()
    const adapter = new CursorModelAdapter(
      runtime,
      config,
      catalog,
      async () => undefined,
      () => {},
    )
    await adapter.listModels('cursor-agent')
    adapter.setConfiguredModels(() => [{ id: 'grok-4.6', name: 'Cursor Grok 4.6' }])

    await adapter.resolveModel('cursor-agent', 'grok-4.6')
    await adapter.resolveModel('cursor-agent', 'grok-4.6')
    expect(calls).toBe(1)
  })
})

function runtimeWithModels(listModels: CursorRuntime['listModels']): CursorRuntime {
  return {
    create: async () => {
      throw new Error('not used')
    },
    resume: async () => {
      throw new Error('not used')
    },
    listModels,
    createStore: async () => ({} as LocalAgentStore),
    configureWorkspaceCache: () => {},
    prewarm: async () => undefined,
  }
}
