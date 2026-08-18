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
import type {
  CursorExecutionPolicy,
  CursorExecutionPolicyResolver,
} from './execution-policy.js'
import type { CursorModelCatalog } from './model-catalog.js'

interface ActiveTurn {
  abort: AbortController
  turn: number
  run: Run | undefined
}

interface PrewarmState {
  mode: CursorExecutionPolicy['mode']
  release: Promise<(() => Promise<void>) | undefined>
}

export const CURSOR_RUN_STALLED = 'CURSOR_RUN_STALLED'

export class CursorRunStalledError extends Error {
  readonly code = CURSOR_RUN_STALLED

  constructor(readonly timeoutMs: number) {
    super(`Cursor run produced no events for ${timeoutMs}ms`)
    this.name = 'CursorRunStalledError'
  }
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
  resolveExecutionPolicy: CursorExecutionPolicyResolver
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
  private cursorPolicyMode: CursorExecutionPolicy['mode'] | undefined
  private prewarmState: PrewarmState | undefined
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
    this.ctx.on('session/event', (session, event) => {
      if (session !== this.session || event.type !== 'sandbox/mode') return
      this.cancel(
        { kind: 'hook', reason: 'Harness permission changed' },
        { keepInbox: true },
      )
      this.startPrewarm()
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

  startPrewarm(): void {
    if (this.disposed) return
    const config = this.seedRequestConfig()
    const policy = this.dependencies.resolveExecutionPolicy()
    void this.ensurePrewarm(config, policy)
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
    const prewarm = this.prewarmState
    this.prewarmState = undefined
    const release = await prewarm?.release.catch(() => undefined)
    await release?.()
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

      const prompt = applyExecutionPolicyGuidance(
        await buildCursorMessage(
          decision.messages,
          this.dependencies.attachments,
          abort.signal,
        ),
        this.dependencies.resolveExecutionPolicy(),
      )
      abort.signal.throwIfAborted()
      let result: RunResult
      let authenticationRetries = 0
      let stallRetries = 0
      let transportRetries = 0
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
          if (error instanceof CursorRunStalledError) {
            const retry = stallRetries === 0 && !mapper.hasRunOutput()
            await this.resetCursorAgent()
            if (retry) {
              stallRetries++
              this.dependencies.ctx.logger.warn(
                `Cursor run stalled before producing output for session "${this.id}"; reopened the SDK agent and retrying once`,
              )
              continue
            }
          }
          if (
            error instanceof CursorSdkError
            && error.isRetryable
            && transportRetries === 0
            && !mapper.hasRunOutput()
          ) {
            transportRetries++
            await this.resetCursorAgent()
            this.dependencies.ctx.logger.warn(
              `Cursor transport failed before producing output for session "${this.id}"; reopened the SDK agent and retrying once`,
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
    const startedAt = performance.now()
    const cursor = await this.cursorAgent(config, active.abort.signal)
    const agentReadyAt = performance.now()
    const watchdog = new RunActivityWatchdog(this.dependencies.config.runStallMs)
    let run: Run | undefined
    let runReadyAt: number | undefined
    let firstOutputAt: number | undefined
    let terminalStatus = 'error'
    const markFirstOutput = (): void => {
      firstOutputAt ??= performance.now()
    }
    try {
      run = await Promise.race([
        cursor.send(prompt, {
          model: this.dependencies.modelCatalog.selection(
            config.model,
            config.reasoningEffort,
          ),
          local: { force: true },
          onDelta: ({ update }) => {
            if (!watchdog.open) return
            watchdog.touch()
            markFirstOutput()
            mapper.handleDelta(update)
          },
        }),
        watchdog.expired,
      ])
      runReadyAt = performance.now()
      active.run = run
      mapper.setRunMetadata({
        agentId: run.agentId,
        runId: run.id,
        ...(run.requestId === undefined ? {} : { requestId: run.requestId }),
      })
      const stream = run.stream()[Symbol.asyncIterator]()
      while (true) {
        const next = await Promise.race([stream.next(), watchdog.expired])
        if (next.done) break
        watchdog.touch()
        if (
          next.value.type !== 'status'
          && next.value.type !== 'system'
          && next.value.type !== 'user'
          && next.value.type !== 'usage'
        ) {
          markFirstOutput()
        }
        mapper.handleMessage(next.value)
      }
      const result = await Promise.race([run.wait(), watchdog.expired])
      active.run = undefined
      terminalStatus = result.status
      return result
    } catch (error) {
      if (error instanceof CursorRunStalledError) terminalStatus = 'stalled'
      if (
        error instanceof CursorRunStalledError
        && run?.supports('cancel')
        && run.status === 'running'
      ) {
        await cancelRunBounded(run)
        active.run = undefined
      }
      throw error
    } finally {
      watchdog.close()
      const completedAt = performance.now()
      this.dependencies.ctx.logger.info(
        `Cursor run timing session="${this.id}" `
        + `run="${run?.id ?? 'pending'}" status=${terminalStatus} `
        + `openMs=${Math.round(agentReadyAt - startedAt)} `
        + `sendMs=${runReadyAt === undefined ? -1 : Math.round(runReadyAt - agentReadyAt)} `
        + `firstOutputMs=${firstOutputAt === undefined ? -1 : Math.round(firstOutputAt - startedAt)} `
        + `totalMs=${Math.round(completedAt - startedAt)}`,
      )
    }
  }

  private async resolveRequest(turn: number, signal: AbortSignal): Promise<LlmCallConfig> {
    const seed = this.seedRequestConfig()
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

  private seedRequestConfig(): LlmCallConfig {
    const previous = this.session.requestHeader()?.config
    return {
      provider: previous?.provider || this.options.provider || CURSOR_PROVIDER,
      model: previous?.model || this.options.model || this.dependencies.config.defaultModel,
      ...(previous?.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: previous.reasoningEffort }),
    }
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
    const policy = this.dependencies.resolveExecutionPolicy()
    if (
      this.cursor !== undefined
      && this.cursorPolicyMode !== undefined
      && this.cursorPolicyMode !== policy.mode
    ) {
      await this.resetCursorAgent()
    }
    if (this.cursor !== undefined) return this.cursor
    if (this.cursorPromise !== undefined) return this.cursorPromise
    this.cursorPromise = this.openCursorAgent(config, policy, signal)
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
    this.cursorPolicyMode = undefined
    if (cursor !== undefined) {
      await cursor[Symbol.asyncDispose]()
    }
  }

  private async openCursorAgent(
    config: LlmCallConfig,
    policy: CursorExecutionPolicy,
    signal: AbortSignal,
  ): Promise<SDKAgent> {
    signal.throwIfAborted()
    await this.ensurePrewarm(config, policy)
    signal.throwIfAborted()
    const cursorId = deterministicCursorId(this.id)
    const options = await this.cursorOptions(config, policy)
    let cursor: SDKAgent
    try {
      cursor = await this.dependencies.runtime.resume(cursorId, options)
    } catch (error) {
      if (!isAgentMissing(error)) throw error
      const hasCursorHistory = this.session.events.some(event => event.type === 'assistant/message')
      if (hasCursorHistory && this.session.header.parentSession === undefined) {
        throw new Error(
          `Cursor checkpoint "${cursorId}" is missing for existing Harness session "${this.id}"; start a new session to avoid silently losing context`,
          { cause: error },
        )
      }
      cursor = await this.dependencies.runtime.create({
        ...options,
        agentId: cursorId,
        name: `DeepSeek Harness ${String(this.id).slice(0, 12)}`,
      })
    }
    try {
      signal.throwIfAborted()
    } catch (error) {
      await cursor[Symbol.asyncDispose]().catch(disposeError => {
        this.dependencies.ctx.logger.warn(
          `Cursor agent cleanup after permission change failed: ${errorMessage(disposeError)}`,
        )
      })
      throw error
    }
    this.cursor = cursor
    this.cursorPolicyMode = policy.mode
    return cursor
  }

  private async ensurePrewarm(
    config: LlmCallConfig,
    policy: CursorExecutionPolicy,
  ): Promise<void> {
    const current = this.prewarmState
    if (current?.mode === policy.mode) {
      const release = await current.release
      if (release !== undefined || this.prewarmState !== current) return
      this.prewarmState = undefined
    }

    const previous = this.prewarmState
    const state: PrewarmState = {
      mode: policy.mode,
      release: Promise.resolve(undefined),
    }
    state.release = (async () => {
      const previousRelease = await previous?.release.catch(() => undefined)
      await previousRelease?.()
      if (this.disposed) return undefined
      try {
        const startedAt = performance.now()
        const options = await this.cursorOptions(config, policy)
        if (this.disposed) return undefined
        const release = await this.dependencies.runtime.prewarm(options)
        this.dependencies.ctx.logger.info(
          `Cursor workspace prewarmed cwd="${this.session.header.cwd}" `
          + `mode=${policy.mode} elapsedMs=${Math.round(performance.now() - startedAt)}`,
        )
        return release
      } catch (error) {
        this.dependencies.ctx.logger.warn(
          `Cursor workspace prewarm failed for "${this.session.header.cwd}": ${errorMessage(error)}`,
        )
        return undefined
      }
    })()
    this.prewarmState = state
    await state.release
  }

  private async cursorOptions(
    config: LlmCallConfig,
    policy: CursorExecutionPolicy,
  ): Promise<CursorSdkAgentOptions> {
    const apiKey = await this.dependencies.resolveApiKey()
    return {
      ...(apiKey === undefined ? {} : { apiKey }),
      model: this.dependencies.modelCatalog.selection(
        config.model,
        config.reasoningEffort,
      ),
      ...(policy.tools === undefined ? {} : { tools: [...policy.tools] }),
      ...(policy.disallowedTools === undefined
        ? {}
        : { disallowedTools: [...policy.disallowedTools] }),
      local: {
        cwd: this.session.header.cwd || process.cwd(),
        ...(policy.includeAdditionalDirs
          ? (this.dependencies.config.additionalDirs.length === 0
              ? {}
              : { dirs: this.dependencies.config.additionalDirs })
          : { dirs: [] }),
        store: this.dependencies.store,
        sandboxOptions: { enabled: policy.sandboxEnabled },
        autoReview: policy.autoReview,
        settingSources: this.dependencies.config.settingSources,
        enableAgentRetries: false,
      },
    }
  }

  private setStatus(status: AgentStatus): void {
    if (this.currentStatus === status) return
    this.currentStatus = status
    this.dispatch.emit('agent/status', { status })
  }
}

class RunActivityWatchdog {
  readonly expired: Promise<never>
  open = true
  private timer: NodeJS.Timeout | undefined
  private readonly reject: (reason?: unknown) => void

  constructor(private readonly timeoutMs: number) {
    const deferred = Promise.withResolvers<never>()
    this.expired = deferred.promise
    this.reject = deferred.reject
    this.arm()
  }

  touch(): void {
    if (!this.open) return
    this.arm()
  }

  close(): void {
    this.open = false
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private arm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.open = false
      this.timer = undefined
      this.reject(new CursorRunStalledError(this.timeoutMs))
    }, this.timeoutMs)
    this.timer.unref()
  }
}

async function cancelRunBounded(run: Run): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      run.cancel().catch(() => undefined),
      new Promise<void>(resolve => {
        timer = setTimeout(resolve, 5_000)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function deterministicCursorId(sessionId: SessionId): string {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return `agent-dsh-${digest}`
}

const WORKSPACE_WRITE_GUIDANCE = [
  '<cursor_harness_execution_policy>',
  'Harness Workspace Write is active.',
  'The built-in delete tool is intentionally unavailable because Cursor Headless cannot approve it.',
  'When the user requests deletion inside the current workspace, use the sandboxed shell tool instead.',
  'Shell-quote every path and use `rm -- <path>` for files; use recursive deletion only when the user explicitly requests a directory deletion.',
  'Do not claim deletion is unavailable merely because the delete tool is absent, and never attempt deletion outside the workspace.',
  '</cursor_harness_execution_policy>',
].join('\n')

const READ_ONLY_GUIDANCE = [
  '<cursor_harness_execution_policy>',
  'Harness Read Only is active.',
  'You cannot create, modify, or delete files in this mode.',
  'When the user requests a filesystem mutation, do not claim that it is underway and do not repeatedly probe for a file you cannot create.',
  'Explain the limitation immediately and ask the user to switch the session to Workspace Write.',
  '</cursor_harness_execution_policy>',
].join('\n')

const FULL_ACCESS_GUIDANCE = [
  '<cursor_harness_execution_policy>',
  'Harness Full Access is active.',
  'This current policy supersedes every earlier Read Only or Workspace Write instruction retained in the conversation.',
  'Cursor Sandbox and Auto-review are disabled, so operations outside the workspace are allowed when the user explicitly requests them.',
  'Do not refuse an operation solely because its path is outside the workspace.',
  'The approval-gated built-in delete tool is intentionally unavailable; use the shell tool for an explicitly requested deletion and shell-quote the exact path.',
  '</cursor_harness_execution_policy>',
].join('\n')

export function applyExecutionPolicyGuidance(
  prompt: string | SDKUserMessage,
  policy: CursorExecutionPolicy,
): string | SDKUserMessage {
  const guidance = policy.mode === 'workspace-write'
    ? WORKSPACE_WRITE_GUIDANCE
    : policy.mode === 'read-only'
      ? READ_ONLY_GUIDANCE
      : policy.mode === 'danger-full-access'
        ? FULL_ACCESS_GUIDANCE
        : undefined
  if (guidance === undefined) return prompt
  const text = `${guidance}\n\n${typeof prompt === 'string' ? prompt : prompt.text}`
  return typeof prompt === 'string' ? text : { ...prompt, text }
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
  if (error instanceof CursorRunStalledError) {
    return {
      message: error.message,
      code: CURSOR_RUN_STALLED,
    }
  }
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
