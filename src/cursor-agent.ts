import { createHash } from 'node:crypto'
import {
  AgentNotFoundError,
  CursorSdkError,
  type AgentOptions as CursorSdkAgentOptions,
  type InteractionUpdate,
  type LocalAgentStore,
  type ModelSelection,
  type Run,
  type RunResult,
  type SDKAgent,
  type SDKMessage,
  type SDKUserMessage,
} from '@cursor/sdk'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import {
  Inbox,
  agentEvents,
  assembleContextFor,
  type Agent,
  type AgentCancelCause,
  type AgentEventDispatch,
  type AgentOptions,
  type AgentStatus,
  type CancelOptions,
  type InboxTarget,
} from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import {
  type LlmCallConfig,
  type LlmFailure,
} from '@deepseek-ai/dsh-llm'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import {
  canonicalHeader,
  headerEquals,
  type Session,
  type SessionId,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import {
  CURSOR_PROVIDER,
  type ApiKeyResolver,
  type Config,
} from './config.js'
import type { CursorRuntime } from './cursor-runtime.js'
import { CursorEventMapper } from './event-mapper.js'
import type { CursorModelCatalog } from './model-catalog.js'

interface ActiveTurn {
  abort: AbortController
  turn: number
  run: Run | undefined
}

export interface CursorHarnessAgentDependencies {
  ctx: Context
  id: SessionId
  options: AgentOptions
  session: Session
  config: Config
  runtime: CursorRuntime
  store: LocalAgentStore
  modelCatalog: CursorModelCatalog
  attachments: AttachmentStore
  resolveApiKey: ApiKeyResolver
}

export class CursorHarnessAgent implements Agent {
  readonly inbox: Inbox
  readonly scope: Scope
  readonly ctx: Context

  private readonly dispatch: AgentEventDispatch
  private currentStatus: AgentStatus = 'idle'
  private active: ActiveTurn | undefined
  private activityDone: Promise<void> = Promise.resolve()
  private cursor: SDKAgent | undefined
  private cursorPromise: Promise<SDKAgent> | undefined
  private disposed = false
  private lastTurn: number
  private requestHeaderLogged = false

  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session

  constructor(private readonly dependencies: CursorHarnessAgentDependencies) {
    this.id = dependencies.id
    this.options = dependencies.options
    this.session = dependencies.session
    this.lastTurn = dependencies.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 0
    this.scope = createScope(dependencies.ctx, this)
    this.ctx = this.scope.ctx.extend({ agent: this })
    this.dispatch = agentEvents(dependencies.ctx, this)
    this.inbox = new Inbox(this.session, {
      inserted: message => this.dispatch.emit('agent/inbox/inserted', { message }),
      discarded: message => this.dispatch.emit('agent/inbox/discarded', { message }),
      claimed: (message, turn) => this.dispatch.emit('agent/inbox/claimed', { message, turn }),
    })
  }

  get status(): AgentStatus {
    return this.currentStatus
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {
    if (this.disposed) throw new Error(`agent "${this.id}" is disposed`)
    const resolvedTarget: InboxTarget = this.active === undefined ? target : 'next-turn'
    this.inbox.splice(resolvedTarget, Number.POSITIVE_INFINITY, 0, [message])
    if (wakeup) this.wake()
  }

  followup(message: UserMessage): void {
    this.send(message, 'next-turn', true)
  }

  steer(message: UserMessage): void {
    this.send(message, 'next-step', true)
  }

  inject(message: UserMessage): void {
    this.send(message, 'next-step', false)
  }

  cancel(cause: AgentCancelCause, options: CancelOptions = {}): void {
    if (!options.keepInbox) this.inbox.clear()
    const active = this.active
    if (active === undefined) return
    active.abort.abort(cause)
    if (active.run?.supports('cancel')) {
      void active.run.cancel().catch(error => {
        this.dependencies.ctx.logger.warn(`Cursor run cancellation failed: ${errorMessage(error)}`)
      })
    }
  }

  async whenIdle(): Promise<void> {
    let observed: Promise<void>
    do {
      await (observed = this.activityDone)
    } while (observed !== this.activityDone)
  }

  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.active !== undefined) throw new Error(`agent "${this.id}" already has active work`)
    const abort = new AbortController()
    const turn: ActiveTurn = { abort, turn: this.lastTurn, run: undefined }
    this.active = turn
    const result = task(abort.signal)
    this.activityDone = result.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      if (this.active === turn) this.active = undefined
      if (this.inbox.hasPending && !this.disposed) this.wake()
    })
    return result
  }

  async disposeRuntime(): Promise<void> {
    this.disposed = true
    this.cancel({ kind: 'disposed' })
    await this.whenIdle()
    const cursor = await this.cursorPromise?.catch(() => undefined) ?? this.cursor
    if (cursor !== undefined) await cursor[Symbol.asyncDispose]()
  }

  private wake(): void {
    if (this.active !== undefined || this.currentStatus === 'running') return
    const done = Promise.withResolvers<void>()
    this.activityDone = done.promise
    this.setStatus('running')
    void this.dependencies.ctx.agents.withInitiator(this, () => this.drive()).then(
      () => done.resolve(),
      error => {
        this.dependencies.ctx.logger.warn(`Cursor agent driver failed: ${errorMessage(error)}`)
        done.resolve()
      },
    )
  }

  private async drive(): Promise<void> {
    try {
      while (!this.disposed && this.inbox.hasPending) {
        await this.driveTurn()
      }
    } finally {
      this.active = undefined
      this.setStatus('idle')
      if (!this.disposed && this.inbox.hasPending) this.wake()
    }
  }

  private async driveTurn(): Promise<void> {
    const turn = ++this.lastTurn
    const abort = new AbortController()
    const active: ActiveTurn = { abort, turn, run: undefined }
    this.active = active
    this.session.append('turn/start', { turn })
    let turnEnd: TurnEndReason = { kind: 'completed' }
    let mapper: CursorEventMapper | undefined

    try {
      const claimed = this.inbox.claim('next-turn', turn)
      // Entry-point model selection is snapshotted by the scoped
      // system-prompt/assemble listener before agent/request. The default
      // Harness loop performs this assembly automatically; this external
      // Cursor driver must trigger the same boundary even though Cursor owns
      // its own system prompt.
      await this.dependencies.ctx.systemPrompt.assemble(
        assembleContextFor(this, abort.signal),
      )
      abort.signal.throwIfAborted()
      const decision = await this.dispatch.waterfall(
        'agent/pre-step',
        { messages: claimed, turn, step: 1, signal: abort.signal },
        () => Promise.resolve({ kind: 'enter' as const, messages: claimed }),
      )
      abort.signal.throwIfAborted()
      if (decision.kind === 'reject') {
        turnEnd = { kind: 'blocked' }
        return
      }
      if (decision.messages.length === 0) return

      const config = await this.resolveRequest(turn, abort.signal)
      mapper = new CursorEventMapper(this.session, turn, config.provider, config.model)
      mapper.begin(decision.messages)
      this.logRequest(config)

      const prompt = await buildCursorMessage(
        decision.messages,
        this.dependencies.attachments,
        abort.signal,
      )
      let result: RunResult
      let authenticationRetries = 0
      while (true) {
        try {
          result = await this.executeCursorRun(
            config,
            prompt,
            mapper,
            active,
          )
        } catch (error) {
          if (
            authenticationRetries === 0
            && !mapper.hasAssistantOutput()
            && isAuthenticationFailure(error)
          ) {
            authenticationRetries++
            await this.resetCursorAgent()
            this.dependencies.ctx.logger.warn(
              `Cursor authentication state expired for session "${this.id}"; reopened the SDK agent and retrying once`,
            )
            continue
          }
          throw error
        }
        if (
          result.status === 'error'
          && authenticationRetries === 0
          && !mapper.hasAssistantOutput()
          && isAuthenticationFailure(result.error)
        ) {
          authenticationRetries++
          await this.resetCursorAgent()
          this.dependencies.ctx.logger.warn(
            `Cursor authentication state expired for session "${this.id}"; reopened the SDK agent and retrying once`,
          )
          continue
        }
        break
      }

      if (result.status === 'finished') {
        mapper.finish(result.usage)
        turnEnd = { kind: 'completed' }
      } else if (result.status === 'cancelled') {
        mapper.abort()
        turnEnd = { kind: 'aborted', reason: abortReason(abort.signal) }
      } else {
        mapper.abort()
        turnEnd = { kind: 'error', error: runFailure(result.error) }
      }
    } catch (error) {
      if (active.run?.supports('cancel') && active.run.status === 'running') {
        await active.run.cancel().catch(cancelError => {
          this.dependencies.ctx.logger.warn(`Cursor run cleanup failed: ${errorMessage(cancelError)}`)
        })
      }
      mapper?.abort()
      if (abort.signal.aborted) {
        turnEnd = { kind: 'aborted', reason: abortReason(abort.signal) }
      } else {
        const failure = cursorFailure(error)
        turnEnd = { kind: 'error', error: failure }
        this.dispatch.emit('agent/error', { turn, step: 1, error })
      }
    } finally {
      this.session.append('turn/end', { turn, reason: turnEnd })
      this.active = undefined
    }
  }

  private async executeCursorRun(
    config: LlmCallConfig,
    prompt: string | SDKUserMessage,
    mapper: CursorEventMapper,
    active: ActiveTurn,
  ): Promise<RunResult> {
    const cursor = await this.cursorAgent(config, active.abort.signal)
    const queue = new MappingQueue()
    const run = await cursor.send(prompt, {
      model: this.dependencies.modelCatalog.selection(
        config.model,
        config.reasoningEffort,
      ),
      onDelta: ({ update }) => queue.push(() => mapper.handleDelta(update)),
    })
    active.run = run
    mapper.setRunMetadata({
      agentId: run.agentId,
      runId: run.id,
      ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
    })
    for await (const message of run.stream()) {
      await queue.push(() => mapper.handleMessage(message))
    }
    await queue.drain()
    const result = await run.wait()
    active.run = undefined
    return result
  }

  private async resolveRequest(turn: number, signal: AbortSignal): Promise<LlmCallConfig> {
    const previous = this.session.requestHeader()?.config
    const seed: LlmCallConfig = {
      provider: previous?.provider || this.options.provider || CURSOR_PROVIDER,
      model: previous?.model || this.options.model || this.dependencies.config.defaultModel,
      ...(previous?.reasoningEffort === undefined ? {} : { reasoningEffort: previous.reasoningEffort }),
    }
    const proposed = await this.dispatch.waterfall(
      'agent/request',
      { turn, step: 1, signal },
      () => Promise.resolve(seed),
    )
    signal.throwIfAborted()
    if (proposed.provider !== CURSOR_PROVIDER) {
      throw new Error(`Cursor AgentFactory only supports provider "${CURSOR_PROVIDER}", got "${proposed.provider}"`)
    }
    return this.dependencies.ctx.llm.resolveCallConfig(proposed, signal)
  }

  private logRequest(config: LlmCallConfig): void {
    const header = canonicalHeader({ config })
    const previous = this.session.requestHeader()
    if (!this.requestHeaderLogged) {
      this.session.append('request/header', {
        header,
        reason: previous === undefined ? 'initial' : 'resume',
      })
      this.requestHeaderLogged = true
    } else if (previous === undefined || !headerEquals(previous, header)) {
      this.session.append('request/header', { header, reason: 'change' })
    }
    const context = { provider: config.provider, model: config.model }
    const previousContext = this.session.requestContext()
    if (previousContext?.provider !== context.provider || previousContext.model !== context.model) {
      this.session.append('request/context', context)
    }
  }

  private async cursorAgent(config: LlmCallConfig, signal: AbortSignal): Promise<SDKAgent> {
    if (this.cursor !== undefined) return this.cursor
    if (this.cursorPromise !== undefined) return this.cursorPromise
    this.cursorPromise = this.openCursorAgent(config, signal)
    try {
      return await this.cursorPromise
    } finally {
      this.cursorPromise = undefined
    }
  }

  private async resetCursorAgent(): Promise<void> {
    const cursor = this.cursor
    this.cursor = undefined
    this.cursorPromise = undefined
    if (cursor !== undefined) {
      await cursor[Symbol.asyncDispose]()
    }
  }

  private async openCursorAgent(config: LlmCallConfig, signal: AbortSignal): Promise<SDKAgent> {
    signal.throwIfAborted()
    const cursorId = deterministicCursorId(this.id)
    const options = await this.cursorOptions(config)
    try {
      this.cursor = await this.dependencies.runtime.resume(cursorId, options)
    } catch (error) {
      if (!isAgentMissing(error)) throw error
      const hasCursorHistory = this.session.events.some(event => event.type === 'assistant/message')
      if (hasCursorHistory && this.session.header.parentSession === undefined) {
        throw new Error(
          `Cursor checkpoint "${cursorId}" is missing for existing Harness session "${this.id}"; start a new session to avoid silently losing context`,
          { cause: error },
        )
      }
      this.cursor = await this.dependencies.runtime.create({
        ...options,
        agentId: cursorId,
        name: `DeepSeek Harness ${String(this.id).slice(0, 12)}`,
      })
    }
    signal.throwIfAborted()
    return this.cursor
  }

  private async cursorOptions(config: LlmCallConfig): Promise<CursorSdkAgentOptions> {
    const apiKey = await this.dependencies.resolveApiKey()
    return {
      ...(apiKey === undefined ? {} : { apiKey }),
      model: this.dependencies.modelCatalog.selection(
        config.model,
        config.reasoningEffort,
      ),
      local: {
        cwd: this.session.header.cwd || process.cwd(),
        ...(this.dependencies.config.additionalDirs.length === 0
          ? {}
          : { dirs: this.dependencies.config.additionalDirs }),
        store: this.dependencies.store,
        sandboxOptions: { enabled: this.dependencies.config.sandbox },
        autoReview: this.dependencies.config.autoReview,
        settingSources: this.dependencies.config.settingSources,
      },
    }
  }

  private setStatus(status: AgentStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    this.dispatch.emit('agent/status', { status })
  }
}

class MappingQueue {
  private pending: Promise<void> = Promise.resolve()

  push(operation: () => void): Promise<void> {
    const next = this.pending.then(operation)
    this.pending = next
    return next
  }

  drain(): Promise<void> {
    return this.pending
  }
}

function deterministicCursorId(sessionId: SessionId): string {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return `agent-dsh-${digest}`
}

export async function buildCursorMessage(
  messages: readonly UserMessage[],
  attachments: Pick<AttachmentStore, 'readImage'>,
  signal?: AbortSignal,
): Promise<string | SDKUserMessage> {
  const images: NonNullable<SDKUserMessage['images']> = []
  const sections: string[] = []
  let imageNumber = 0

  for (const [messageIndex, message] of messages.entries()) {
    const parts: string[] = []
    for (const block of message.content) {
      signal?.throwIfAborted()
      if (block.type === 'text' || block.type === 'reasoning') {
        if (block.text) parts.push(block.text)
        continue
      }
      if (block.type === 'image') {
        const stored = await attachments.readImage(block.attachment, signal)
        signal?.throwIfAborted()
        images.push({
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
          dimension: {
            width: stored.ref.width,
            height: stored.ref.height,
          },
        })
        imageNumber++
        parts.push(
          `[Attached image ${imageNumber}${stored.ref.name ? `: ${stored.ref.name}` : ''}]`,
        )
        continue
      }
      parts.push(JSON.stringify(block))
    }
    const text = parts.join('\n')
    sections.push(
      messages.length === 1 ? text : `[Context ${messageIndex + 1}]\n${text}`,
    )
  }

  const text = sections.join('\n\n').trim()
  if (images.length === 0) return text
  return {
    text: text || '[Image attachment]',
    images,
  }
}

function isAgentMissing(error: unknown): boolean {
  return error instanceof AgentNotFoundError
    || (error instanceof CursorSdkError && error.code === 'AGENT_NOT_FOUND')
}

function isAuthenticationFailure(error: unknown): boolean {
  if (error === undefined || error === null) return false
  const candidate = error as {
    name?: unknown
    code?: unknown
    status?: unknown
    message?: unknown
  }
  if (candidate.status === 401) return true
  const name = String(candidate.name ?? '').toLowerCase()
  const code = String(candidate.code ?? '').toLowerCase()
  const message = String(candidate.message ?? error).toLowerCase()
  return name.includes('authentication')
    || code === 'auth'
    || code.includes('authentication')
    || code.includes('unauthorized')
    || code.includes('invalid_api_key')
    || message.includes('authentication error')
    || message.includes('invalid user api key')
    || message.includes('invalid api key')
    || message.includes('unauthorized')
}

function cursorFailure(error: unknown): LlmFailure {
  if (error instanceof CursorSdkError) {
    return {
      message: error.message,
      code: isAuthenticationFailure(error) ? 'AUTH' : error.code || 'CURSOR_SDK',
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  return {
    message: errorMessage(error),
    code: isAuthenticationFailure(error) ? 'AUTH' : 'CURSOR_SDK',
  }
}

function runFailure(error: { message: string; code?: string } | undefined): LlmFailure {
  return {
    message: error?.message || 'Cursor run failed',
    code: isAuthenticationFailure(error) ? 'AUTH' : error?.code || 'CURSOR_RUN',
  }
}

function abortReason(signal: AbortSignal): AgentCancelCause {
  const reason = signal.reason
  if (
    typeof reason === 'object'
    && reason !== null
    && 'kind' in reason
    && (reason.kind === 'user' || reason.kind === 'parent' || reason.kind === 'hook' || reason.kind === 'disposed')
  ) {
    return reason as AgentCancelCause
  }
  return { kind: 'user' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type { InteractionUpdate, ModelSelection, SDKMessage }
