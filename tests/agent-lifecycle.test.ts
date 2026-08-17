import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentNotFoundError,
  type AgentOptions as CursorAgentOptions,
  type LocalAgentStore,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
  type SendOptions,
} from '@cursor/sdk'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { afterEach, describe, expect, it } from 'vitest'
import type { Config } from '../src/config.js'
import type { CursorRuntime } from '../src/cursor-runtime.js'
import { CursorAgentFactory } from '../src/factory.js'
import { CURSOR_PROVIDER, CursorModelAdapter } from '../src/model-adapter.js'
import { CursorModelCatalog } from '../src/model-catalog.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('CursorAgentFactory lifecycle', () => {
  it('drives two Harness turns through one durable Cursor agent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-harness-test-'))
    roots.push(root)
    const runtime = new FakeCursorRuntime()
    const ctx = new Context()
    new AgentRegistry(ctx)
    new SessionStore(ctx)
    new LlmRuntime(ctx)
    new SystemPrompt(ctx, {
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      persona: '',
    })

    const config: Config = {
      apiKeyEnv: 'CURSOR_API_KEY_TEST_MISSING',
      defaultModel: 'auto',
      stateDir: root,
      sandbox: true,
      autoReview: true,
      settingSources: [],
      modelCacheMs: 60_000,
    }
    const catalog = new CursorModelCatalog()
    ctx.llm.registerAdapter(
      [CURSOR_PROVIDER],
      new CursorModelAdapter(
        runtime,
        config,
        catalog,
        async () => undefined,
        () => {},
      ),
    )
    const factory = new CursorAgentFactory(
      ctx,
      config,
      runtime,
      catalog,
      async () => undefined,
    )
    ctx.agents.setFactory(factory)

    const selection = {
      current: { provider: CURSOR_PROVIDER, model: 'auto' },
      assembled: undefined,
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(crypto.randomUUID()),
      meta: { cwd: process.cwd() },
      agentOptions: { provider: CURSOR_PROVIDER, model: 'auto' },
      setup: agentCtx => {
        installModelSelection(agentCtx, selection)
      },
    })
    handle.agent.followup(userMessage('first'))
    await handle.agent.whenIdle()
    selection.current = { provider: CURSOR_PROVIDER, model: 'grok-4.6' }
    handle.agent.followup(userMessage('second'))
    await handle.agent.whenIdle()
    handle.agent.followup(userMessage('hang'))
    while (runtime.agent.sendCalls < 3 || runtime.agent.lastRun?.started !== true) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    handle.agent.cancel({ kind: 'user' })
    await handle.agent.whenIdle()
    handle.agent.followup(userMessage('auth-retry'))
    await handle.agent.whenIdle()
    handle.agent.followup(userMessage('request'))
    await handle.agent.whenIdle()

    const turns = handle.agent.session.events.filter(event => event.type === 'turn/end')
    const assistants = handle.agent.session.events.filter(event => event.type === 'assistant/message')
    expect(turns.map(event => event.data.reason.kind)).toEqual([
      'completed',
      'completed',
      'aborted',
      'completed',
      'error',
    ])
    expect(assistants.map(event => event.data.message.content[0])).toEqual([
      { type: 'text', text: 'reply:first' },
      { type: 'text', text: 'reply:second' },
      { type: 'text', text: 'reply:auth-retry' },
    ])
    expect(runtime.resumeCalls).toBe(2)
    expect(runtime.createCalls).toBe(1)
    expect(runtime.agent.sendCalls).toBe(6)
    expect(runtime.agent.models).toEqual([
      'auto',
      'grok-4.6',
      'grok-4.6',
      'grok-4.6',
      'grok-4.6',
      'grok-4.6',
    ])
    expect(runtime.agent.lastRun?.cancelCalls).toBe(1)

    await handle.dispose()
    expect(runtime.agent.disposed).toBe(true)
    await factory.dispose()
    await ctx.root.fiber.dispose()
  })
})

function userMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

class FakeCursorRuntime implements CursorRuntime {
  readonly agent = new FakeSdkAgent()
  resumeCalls = 0
  createCalls = 0
  private created = false

  async create(_options: CursorAgentOptions): Promise<SDKAgent> {
    this.createCalls++
    this.created = true
    return this.agent.value
  }

  async resume(_agentId: string, _options: Partial<CursorAgentOptions>): Promise<SDKAgent> {
    this.resumeCalls++
    if (!this.created) throw new AgentNotFoundError('missing')
    return this.agent.value
  }

  async listModels() {
    return [
      { id: 'auto', displayName: 'Auto' },
      { id: 'grok-4.6', displayName: 'Cursor Grok 4.6' },
    ]
  }

  createStore(): LocalAgentStore {
    return {} as LocalAgentStore
  }
}

class FakeSdkAgent {
  sendCalls = 0
  disposed = false
  lastRun: FakeRun | undefined
  models: string[] = []
  authFailures = 1

  readonly value = {
    agentId: 'agent-fake',
    model: { id: 'auto' },
    send: async (message: string, options?: SendOptions) => {
      this.sendCalls++
      this.models.push(options?.model?.id ?? '')
      const authenticationFailure = message === 'auth-retry'
        && this.authFailures-- > 0
      this.lastRun = new FakeRun(message, options, authenticationFailure)
      return this.lastRun as unknown as Run
    },
    close: () => {},
    reload: async () => {},
    [Symbol.asyncDispose]: async () => {
      this.disposed = true
    },
    listArtifacts: async () => [],
    downloadArtifact: async () => Buffer.alloc(0),
    getUsage: async () => ({ runs: [], total: { inputTokens: 0, outputTokens: 0, cost: 0 } }),
  } as unknown as SDKAgent
}

class FakeRun {
  readonly id = `run-${crypto.randomUUID()}`
  readonly requestId = crypto.randomUUID()
  readonly agentId = 'agent-fake'
  status: Run['status'] = 'running'
  result?: string
  error?: Run['error']
  model = { id: 'auto' }
  durationMs?: number
  usage?: Run['usage']
  git?: Run['git']
  createdAt = Date.now()
  cancelCalls = 0
  started = false
  private readonly released = Promise.withResolvers<void>()

  constructor(
    private readonly prompt: string,
    private readonly options?: SendOptions,
    private readonly authenticationFailure = false,
  ) {}

  supports(): boolean {
    return true
  }

  unsupportedReason(): undefined {
    return undefined
  }

  async * stream(): AsyncGenerator<SDKMessage, void> {
    this.started = true
    if (this.prompt === 'hang') {
      await this.released.promise
      return
    }
    if (this.prompt === 'request') {
      yield {
        type: 'request',
        agent_id: this.agentId,
        run_id: this.id,
        request_id: 'approval-1',
      }
      return
    }
    if (this.authenticationFailure) {
      this.status = 'error'
      this.error = {
        message: 'Authentication error If you are logged in, try logging out and back in.',
      }
      return
    }
    const text = `reply:${this.prompt}`
    await this.options?.onDelta?.({ update: { type: 'text-delta', text } })
    yield {
      type: 'assistant',
      agent_id: this.agentId,
      run_id: this.id,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }
    this.usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 2,
    }
    yield { type: 'usage', agent_id: this.agentId, run_id: this.id, usage: this.usage }
    this.result = text
    this.status = 'finished'
  }

  async wait(): Promise<RunResult> {
    return {
      id: this.id,
      requestId: this.requestId,
      status: this.status === 'running' ? 'error' : this.status,
      ...(this.result === undefined ? {} : { result: this.result }),
      ...(this.error === undefined ? {} : { error: this.error }),
      model: this.model,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
    }
  }

  async cancel(): Promise<void> {
    this.cancelCalls++
    this.status = 'cancelled'
    this.released.resolve()
  }

  async conversation() {
    return []
  }

  onDidChangeStatus(): () => void {
    return () => {}
  }
}
