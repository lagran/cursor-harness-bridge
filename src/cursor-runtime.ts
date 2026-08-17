import {
  Agent as CursorAgent,
  Cursor,
  JsonlLocalAgentStore,
  type AgentOptions as CursorAgentOptions,
  type LocalAgentStore,
  type SDKAgent,
  type SDKModel,
} from '@cursor/sdk'

export interface CursorRuntime {
  create(options: CursorAgentOptions): Promise<SDKAgent>
  resume(agentId: string, options: Partial<CursorAgentOptions>): Promise<SDKAgent>
  listModels(apiKey?: string): Promise<SDKModel[]>
  createStore(root: string): LocalAgentStore
}

export const defaultCursorRuntime: CursorRuntime = {
  create: options => CursorAgent.create(options),
  resume: (agentId, options) => CursorAgent.resume(agentId, options),
  listModels: apiKey => Cursor.models.list(apiKey === undefined ? {} : { apiKey }),
  createStore: root => new JsonlLocalAgentStore(root),
}
