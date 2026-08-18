import {
  Agent as CursorAgent,
  Cursor,
  configureCursorSdk,
  createAgentPlatform,
  type AgentOptions as CursorAgentOptions,
  type LocalAgentStore,
  type SDKAgent,
  type SDKModel,
} from '@cursor/sdk'
import { SqliteLocalAgentStore } from '@cursor/sdk/sqlite'

export interface ManagedLocalAgentStore extends LocalAgentStore {
  dispose?(): Promise<void>
}

export interface CursorRuntime {
  create(options: CursorAgentOptions): Promise<SDKAgent>
  resume(agentId: string, options: Partial<CursorAgentOptions>): Promise<SDKAgent>
  listModels(apiKey?: string): Promise<SDKModel[]>
  createStore(root: string, workspaceRef: string): Promise<ManagedLocalAgentStore>
  configureWorkspaceCache(ttlMs: number): void
  prewarm(options: CursorAgentOptions): Promise<(() => Promise<void>) | undefined>
}

export const defaultCursorRuntime: CursorRuntime = {
  create: options => CursorAgent.create(options),
  resume: (agentId, options) => CursorAgent.resume(agentId, options),
  listModels: apiKey => Cursor.models.list(apiKey === undefined ? {} : { apiKey }),
  createStore: (root, workspaceRef) => SqliteLocalAgentStore.open({
    stateRoot: root,
    workspaceRef,
  }),
  configureWorkspaceCache: ttlMs => {
    configureCursorSdk({ local: { workspaceScanCacheTtlMs: ttlMs } })
  },
  prewarm: async options => {
    const localStore = options.local?.store
    const workspaceRef = options.local?.cwd
    if (localStore === undefined || workspaceRef === undefined) return undefined
    const platform = await createAgentPlatform({
      localStore,
      workspaceRef,
      scopedWorkspaceRef: workspaceRef,
    })
    return platform.prewarmLocalWorkspace(options)
  },
}
