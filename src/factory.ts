import { mkdirSync } from 'node:fs'
import type { LocalAgentStore } from '@cursor/sdk'
import {
  emitAgentEvent,
  type AgentFactory,
  type AgentHandle,
  type AgentOptions,
  type AgentSetup,
  type CreateAgentOptions,
  type ResumeAgentOptions,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  SessionPreparation,
  type Session,
  type SessionId,
} from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  type ApiKeyResolver,
  type Config,
  resolveStateDir,
} from './config.js'
import { CursorHarnessAgent } from './cursor-agent.js'
import type { CursorModelCatalog } from './model-catalog.js'
import type { CursorRuntime } from './cursor-runtime.js'

export class CursorAgentFactory implements AgentFactory {
  private readonly store: LocalAgentStore
  private readonly shutdown = new AbortController()
  private readonly handles = new Set<() => Promise<void>>()
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly runtime: CursorRuntime,
    private readonly modelCatalog: CursorModelCatalog,
    private readonly resolveApiKey: ApiKeyResolver,
  ) {
    const stateDir = resolveStateDir(config)
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    this.store = runtime.createStore(stateDir)
  }

  async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
    const preparation = SessionPreparation.create(this.ctx.sessions.prepare(options.sessionId, {
      ...(options.seed === undefined ? {} : { seed: options.seed }),
      ...(options.meta === undefined ? {} : { meta: options.meta }),
    }))
    try {
      return await this.setupAndPublish(
        ownerCtx,
        options.sessionId,
        preparation.session,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'startup',
      )
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  async resume(ownerCtx: Context, options: ResumeAgentOptions): Promise<AgentHandle> {
    const persistence = this.ctx.get('sessionPersistence') as SessionPersistence | undefined
    if (persistence === undefined) {
      throw new Error('cannot resume Cursor agent: session persistence is not configured')
    }
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(options.signal === undefined ? [] : [options.signal]),
    ])
    const preparation = await persistence.prepare(options.resumeSessionId, signal)
    try {
      return await this.setupAndPublish(
        ownerCtx,
        options.resumeSessionId,
        preparation.session,
        options.agentOptions ?? {},
        options.setup,
        options.signal,
        'resume',
      )
    } finally {
      preparation[Symbol.dispose]()
    }
  }

  async dispose(): Promise<void> {
    if (this.stopped) {
      await Promise.allSettled([...this.handles].map(dispose => dispose()))
      return
    }
    this.stopped = true
    this.shutdown.abort(new Error('Cursor AgentFactory disposed'))
    await Promise.allSettled([...this.handles].map(dispose => dispose()))
  }

  private async setupAndPublish(
    ownerCtx: Context,
    id: SessionId,
    session: Session,
    options: AgentOptions,
    setup: AgentSetup | undefined,
    callerSignal: AbortSignal | undefined,
    source: SessionStartSource,
  ): Promise<AgentHandle> {
    if (this.stopped) throw new Error('Cursor AgentFactory is disposed')
    ownerCtx.fiber.assertActive()
    const signal = AbortSignal.any([
      this.shutdown.signal,
      ...(callerSignal === undefined ? [] : [callerSignal]),
    ])
    signal.throwIfAborted()

    const agent = new CursorHarnessAgent({
      ctx: this.ctx,
      id,
      options,
      session,
      config: this.config,
      runtime: this.runtime,
      store: this.store,
      modelCatalog: this.modelCatalog,
      attachments: this.ctx.attachments,
      resolveApiKey: this.resolveApiKey,
    })
    let detachSession: (() => void) | undefined
    let detachAgent: (() => void) | undefined
    let disposing: Promise<void> | undefined

    const dispose = (): Promise<void> => {
      disposing ??= (async () => {
        try {
          await agent.disposeRuntime()
          await agent.scope.dispose()
        } finally {
          detachAgent?.()
          detachSession?.()
        }
      })()
      return disposing
    }
    const trackedDispose = async (): Promise<void> => {
      try {
        await dispose()
      } finally {
        this.handles.delete(trackedDispose)
      }
    }
    this.handles.add(trackedDispose)

    let ownerCleanup: (() => Promise<void> | void) | undefined
    try {
      ownerCleanup = ownerCtx.effect(
        () => () => trackedDispose(),
        `cursorAgentFactory.lifecycle(${id})`,
      )
      const commit = await setup?.(agent.ctx)
      ownerCtx.fiber.assertActive()
      signal.throwIfAborted()
      commit?.commit()

      detachSession = agent.ctx.sessions.enter(session)
      detachAgent = this.ctx.agents.enter(agent, ownerCtx.agent)
      agent.ctx.sessions.announce(session)
      this.ctx.agents.announce(agent)
      emitAgentEvent(this.ctx, agent, 'agent/session-start', { source })
      signal.throwIfAborted()

      return {
        agent,
        dispose: async () => {
          await trackedDispose()
          await ownerCleanup?.()
        },
      }
    } catch (error) {
      await trackedDispose()
      await ownerCleanup?.()
      throw error
    }
  }
}
