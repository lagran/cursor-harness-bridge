import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
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
import type {} from '@deepseek-ai/dsh-sandbox-policy'
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
import { cursorExecutionPolicy } from './execution-policy.js'
import type { CursorModelCatalog } from './model-catalog.js'
import type {
  CursorRuntime,
  ManagedLocalAgentStore,
} from './cursor-runtime.js'
import {
  migrateJsonlStores,
  sqliteWorkspaceRoot,
} from './store-migration.js'

export class CursorAgentFactory implements AgentFactory {
  private readonly stateDir: string
  private readonly stores = new Map<string, Promise<ManagedLocalAgentStore>>()
  private readonly ready: Promise<void>
  private readonly shutdown = new AbortController()
  private readonly handles = new Set<() => Promise<void>>()
  private disposePromise: Promise<void> | undefined
  private stopped = false

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly runtime: CursorRuntime,
    private readonly modelCatalog: CursorModelCatalog,
    private readonly resolveApiKey: ApiKeyResolver,
  ) {
    this.stateDir = resolveStateDir(config)
    mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    this.ready = migrateJsonlStores({
      stateDir: this.stateDir,
      openStore: workspaceRef => this.storeFor(workspaceRef),
      logger: {
        info: message => this.ctx.logger.info(message),
      },
    }).then(() => undefined)
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
    this.disposePromise ??= this.disposeOnce()
    await this.disposePromise
  }

  private async disposeOnce(): Promise<void> {
    this.stopped = true
    this.shutdown.abort(new Error('Cursor AgentFactory disposed'))
    await Promise.allSettled([...this.handles].map(dispose => dispose()))
    await this.ready.catch(() => undefined)
    const stores = await Promise.allSettled(this.stores.values())
    await Promise.allSettled(
      stores.flatMap(result => result.status === 'fulfilled' && result.value.dispose !== undefined
        ? [result.value.dispose()]
        : []),
    )
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
    await this.ready
    signal.throwIfAborted()
    const workspaceRef = resolve(session.header.cwd || process.cwd())
    const store = await this.storeFor(workspaceRef)
    signal.throwIfAborted()

    const agent = new CursorHarnessAgent({
      ctx: this.ctx,
      id,
      options,
      session,
      config: this.config,
      runtime: this.runtime,
      store,
      modelCatalog: this.modelCatalog,
      attachments: this.ctx.attachments,
      resolveApiKey: this.resolveApiKey,
      resolveExecutionPolicy: () => cursorExecutionPolicy(
        this.ctx.sandboxPolicy.resolve({ session }).mode,
      ),
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
      agent.startPrewarm()
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

  private storeFor(workspaceRef: string): Promise<ManagedLocalAgentStore> {
    const identity = resolve(workspaceRef)
    let store = this.stores.get(identity)
    if (store === undefined) {
      store = this.runtime.createStore(
        sqliteWorkspaceRoot(this.stateDir, identity),
        identity,
      )
      this.stores.set(identity, store)
    }
    return store
  }
}
