import type {
  InteractionUpdate,
  SDKAssistantMessage,
  SDKMessage,
  SDKToolUseMessage,
  TokenUsage as CursorTokenUsage,
} from '@cursor/sdk'
import {
  CallId,
  createAssistantMessage,
  createToolResultMessage,
  type ContentBlock,
  type TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'

const MAX_TOOL_PAYLOAD_CHARS = 50_000
const READ_ONLY_TOOL_NAMES = new Set([
  'read',
  'read_file',
  'grep',
  'grep_search',
  'glob',
  'ls',
  'readlints',
  'semsearch',
  'semantic_search',
  'websearch',
  'web_search',
  'webfetch',
  'web_fetch',
  'readtodos',
])
// Subagent delegation runs independently of the parent step sequence: the
// model legitimately continues to a new step (or a new turn's worth of
// steps) while a delegated task still executes in the background, and its
// terminal tool_call event can arrive many steps later. A step boundary
// crossing is therefore not evidence of incompleteness for this tool, unlike
// synchronous tools where the protocol guarantees the result precedes the
// next step.
const ASYNC_TOOL_NAMES = new Set([
  'task',
])

interface StepState {
  number: number
  chunkSeqs: number[]
  text: string
  reasoning: string
  textIndex?: number
  reasoningIndex?: number
  nextBlockIndex: number
  pendingAssistant?: SDKAssistantMessage
  assistantLogged: boolean
  hasToolCalls: boolean
}

interface ToolState {
  id: ReturnType<typeof CallId>
  name: string
  arguments: string
  step: number
  callLogged: boolean
  resultLogged: boolean
}

interface CursorRunMetadata {
  agentId: string
  runId: string
  requestId?: string
}

export class UnsupportedCursorRequestError extends Error {
  constructor(readonly requestId: string) {
    super(`Cursor SDK requested interactive input or approval (${requestId}), but its public headless API cannot answer it`)
    this.name = 'UnsupportedCursorRequestError'
  }
}

export class CursorEventMapper {
  private step: StepState | undefined
  private usage: TokenUsage | undefined
  private lastStep = 0
  private readonly tools = new Map<string, ToolState>()
  private runMetadata: CursorRunMetadata | undefined

  constructor(
    private readonly session: Session,
    private readonly turn: number,
    private readonly provider: string,
    private readonly model: string,
  ) {}

  begin(messages: readonly UserMessage[]): void {
    this.openStep()
    for (const message of messages) {
      this.session.append('user/message', message, { surfaceOp: 'append' })
    }
  }

  setRunMetadata(metadata: CursorRunMetadata): void {
    this.runMetadata = metadata
  }

  hasAssistantOutput(): boolean {
    return this.step !== undefined
      && (this.step.chunkSeqs.length > 0 || this.step.assistantLogged)
  }

  hasRunOutput(): boolean {
    return this.hasAssistantOutput() || this.tools.size > 0
  }

  handleDelta(update: InteractionUpdate): void {
    switch (update.type) {
      case 'text-delta':
        this.appendText(update.text)
        break
      case 'thinking-delta':
        this.appendReasoning(update.text)
        break
      case 'summary':
        this.appendReasoning(update.summary)
        break
      case 'shell-output-delta':
      case 'thinking-completed':
      case 'token-delta':
      case 'step-started':
      case 'step-completed':
      case 'turn-ended':
      case 'user-message-appended':
      case 'summary-started':
      case 'summary-completed':
      case 'partial-tool-call':
      case 'tool-call-started':
      case 'tool-call-completed':
        break
      case 'tool-call-delta':
        this.handleNestedUpdate(update.callId, update.taskUpdate)
        break
      default:
        update satisfies never
    }
  }

  handleMessage(message: SDKMessage): void {
    switch (message.type) {
      case 'assistant':
        this.handleAssistant(message)
        break
      case 'thinking':
        if (!this.current().reasoning) this.appendReasoning(message.text)
        break
      case 'tool_call':
        this.handleTool(message)
        break
      case 'usage':
        this.usage = cursorUsage(message.usage)
        break
      case 'task':
        if (message.text) this.appendReasoning(message.text)
        break
      case 'request':
        throw new UnsupportedCursorRequestError(message.request_id)
      case 'system':
      case 'user':
      case 'status':
        break
      default:
        message satisfies never
    }
  }

  finish(usage?: CursorTokenUsage): void {
    if (usage !== undefined) this.usage = cursorUsage(usage)
    this.settleIncompleteTools('finished')
    const step = this.current()
    if (!step.assistantLogged) this.finalizeAssistant(this.usage)
    this.closeStep()
  }

  abort(): void {
    if (this.step === undefined) return
    this.settleIncompleteTools('aborted')
    const step = this.step
    if (!step.assistantLogged && (step.text || step.reasoning || step.pendingAssistant !== undefined)) {
      this.finalizeAssistant()
    }
    this.closeStep()
  }

  private handleAssistant(message: SDKAssistantMessage): void {
    const step = this.current()
    if (step.assistantLogged) {
      this.settleIncompleteTools('finished', step.number)
      this.advanceStep()
    }
    this.current().pendingAssistant = message
    const hasTools = message.message.content.some(block => block.type === 'tool_use')
    if (hasTools) this.finalizeAssistant()
  }

  private handleTool(message: SDKToolUseMessage): void {
    const step = this.current()
    let tool = this.tools.get(message.call_id)
    if (tool === undefined) {
      tool = {
        id: CallId(message.call_id),
        name: message.name || 'cursor_tool',
        arguments: safeJson(message.args),
        step: step.number,
        callLogged: false,
        resultLogged: false,
      }
      this.tools.set(message.call_id, tool)
    } else {
      tool.name = message.name || tool.name
      if (message.args !== undefined) tool.arguments = safeJson(message.args)
    }

    if (!step.assistantLogged) {
      const pendingHasCall = step.pendingAssistant?.message.content.some(
        block => block.type === 'tool_use' && block.id === message.call_id,
      )
      if (!pendingHasCall) {
        step.pendingAssistant = syntheticAssistant(message)
      }
      this.finalizeAssistant()
    }

    if (!tool.callLogged) {
      this.session.append('tool/call', {
        turn: this.turn,
        step: tool.step,
        callId: tool.id,
        name: tool.name,
        arguments: tool.arguments,
      })
      tool.callLogged = true
    }

    if (message.status === 'running' || tool.resultLogged) return
    const resultText = toolResultText(message)
    this.session.append('tool/result', {
      turn: this.turn,
      step: tool.step,
      message: createToolResultMessage({
        callId: tool.id,
        content: [{ type: 'text', text: resultText }],
        isError: message.status === 'error',
      }),
      ...(message.status === 'error'
        ? { error: { name: 'CursorToolError', code: 'CURSOR_TOOL_ERROR' } }
        : {}),
    }, { surfaceOp: 'append' })
    tool.resultLogged = true
  }

  private settleIncompleteTools(
    reason: 'finished' | 'aborted',
    stepNumber?: number,
  ): void {
    for (const tool of this.tools.values()) {
      if (
        !tool.callLogged
        || tool.resultLogged
        || (stepNumber !== undefined && tool.step !== stepNumber)
      ) continue
      const isAsync = ASYNC_TOOL_NAMES.has(tool.name.toLowerCase())
      // Only a step-scoped settlement (stepNumber defined) treats an async
      // tool's step boundary as meaningless; the run-scoped settlement from
      // finish()/abort() (stepNumber undefined) still must close its card,
      // since nothing will update it once the run object is gone.
      if (stepNumber !== undefined && isAsync) continue
      const aborted = reason === 'aborted'
      const neutral = !aborted && (READ_ONLY_TOOL_NAMES.has(tool.name.toLowerCase()) || isAsync)
      this.session.append('tool/result', {
        turn: this.turn,
        step: tool.step,
        message: createToolResultMessage({
          callId: tool.id,
          content: [{
            type: 'text',
            text: neutral
              ? isAsync
                ? `Cursor run ended while delegated task "${tool.name}" was still running in the background; its outcome was not reported before the run closed.`
                : `Cursor run completed without a separate terminal event for read-only tool "${tool.name}"; the card was closed without marking the run as failed.`
              : aborted
                ? `Cursor run was interrupted before "${tool.name}" returned a result.`
                : `Cursor run ended before "${tool.name}" returned a terminal result; the operation may not have completed.`,
          }],
          isError: !neutral,
        }),
        ...(neutral
          ? {
              meta: {
                synthetic: true,
                terminalEvent: 'missing',
                disposition: isAsync ? 'neutral-async-pending' : 'neutral-read-only',
              },
            }
          : {
              error: {
                name: aborted ? 'CursorToolCancelledError' : 'CursorToolIncompleteError',
                code: aborted ? 'CURSOR_TOOL_CANCELLED' : 'CURSOR_TOOL_INCOMPLETE',
              },
            }),
      }, { surfaceOp: 'append' })
      tool.resultLogged = true
    }
  }

  private appendText(text: string): void {
    if (!text) return
    const step = this.ensureWritableStep()
    if (step.textIndex === undefined) {
      step.textIndex = step.nextBlockIndex++
      this.appendChunk({ type: 'block-start', index: step.textIndex, blockType: 'text' })
    }
    step.text += text
    this.appendChunk({ type: 'text-delta', index: step.textIndex, text })
  }

  private appendReasoning(text: string): void {
    if (!text) return
    const step = this.ensureWritableStep()
    if (step.reasoningIndex === undefined) {
      step.reasoningIndex = step.nextBlockIndex++
      this.appendChunk({ type: 'block-start', index: step.reasoningIndex, blockType: 'reasoning' })
    }
    step.reasoning += text
    this.appendChunk({ type: 'reasoning-delta', index: step.reasoningIndex, text })
  }

  private handleNestedUpdate(parentCallId: string, update: InteractionUpdate): void {
    if (update.type === 'text-delta' && update.text) {
      this.appendReasoning(`[${parentCallId}] ${update.text}`)
      return
    }
    if (update.type === 'thinking-delta' && update.text) {
      this.appendReasoning(update.text)
      return
    }
    if (update.type === 'tool-call-delta') {
      this.handleNestedUpdate(update.callId, update.taskUpdate)
    }
  }

  private ensureWritableStep(): StepState {
    const step = this.current()
    if (step.assistantLogged) {
      this.settleIncompleteTools('finished', step.number)
      this.advanceStep()
      return this.current()
    }
    return step
  }

  private finalizeAssistant(usage?: TokenUsage): void {
    const step = this.current()
    if (step.assistantLogged) return
    const content = assistantContent(step)
    if (content.length === 0) return

    if (step.reasoningIndex !== undefined) {
      this.appendChunk({
        type: 'block-end',
        index: step.reasoningIndex,
        block: { type: 'reasoning', text: step.reasoning },
      })
    }
    if (step.textIndex !== undefined) {
      this.appendChunk({
        type: 'block-end',
        index: step.textIndex,
        block: { type: 'text', text: visibleText(step) },
      })
    }

    const toolBlocks = content.filter(block => block.type === 'tool-call')
    for (const block of toolBlocks) {
      const index = step.nextBlockIndex++
      this.appendChunk({ type: 'block-start', index, blockType: 'tool-call' })
      this.appendChunk({
        type: 'tool-call-delta',
        index,
        id: block.id,
        name: block.name,
        argumentsDelta: block.arguments,
      })
      this.appendChunk({ type: 'block-end', index, block })
    }
    if (usage !== undefined) this.appendChunk({ type: 'usage', usage })
    this.appendChunk({
      type: 'finish',
      reason: { kind: toolBlocks.length > 0 ? 'tool-calls' : 'stop' },
    })

    this.session.append('assistant/message', {
      turn: this.turn,
      step: step.number,
      message: createAssistantMessage({
        content,
        source: {
          provider: this.provider,
          model: this.model,
          ...(this.runMetadata === undefined
            ? {}
            : {
                replayState: {
                  version: 1,
                  cursorAgentId: this.runMetadata.agentId,
                  cursorRunId: this.runMetadata.runId,
                  ...(this.runMetadata.requestId === undefined
                    ? {}
                    : { cursorRequestId: this.runMetadata.requestId }),
                },
              }),
        },
      }),
      ...(usage === undefined ? {} : { usage }),
    }, { surfaceOp: 'append', sourceEventSeqs: step.chunkSeqs })
    step.assistantLogged = true
    step.hasToolCalls = toolBlocks.length > 0
  }

  private appendChunk(chunk: import('@deepseek-ai/dsh-llm').StreamChunk): void {
    const step = this.current()
    const event = this.session.append('assistant/chunk', {
      turn: this.turn,
      step: step.number,
      chunk,
    })
    step.chunkSeqs.push(event.seq)
  }

  private openStep(): void {
    const number = ++this.lastStep
    this.session.append('step/start', { turn: this.turn, step: number })
    this.step = {
      number,
      chunkSeqs: [],
      text: '',
      reasoning: '',
      nextBlockIndex: 0,
      assistantLogged: false,
      hasToolCalls: false,
    }
  }

  private closeStep(): void {
    const step = this.step
    if (step === undefined) return
    this.session.append('step/end', { turn: this.turn, step: step.number })
    this.step = undefined
  }

  private advanceStep(): void {
    this.closeStep()
    this.openStep()
  }

  private current(): StepState {
    if (this.step === undefined) this.openStep()
    return this.step!
  }
}

function assistantContent(step: StepState): ContentBlock[] {
  const content: ContentBlock[] = []
  if (step.reasoning) content.push({ type: 'reasoning', text: step.reasoning })
  const pending = step.pendingAssistant?.message.content
  const streamedText = step.text
  if (streamedText) content.push({ type: 'text', text: streamedText })
  if (pending !== undefined) {
    for (const block of pending) {
      if (block.type === 'text') {
        if (!streamedText && block.text) content.push({ type: 'text', text: block.text })
      } else {
        content.push({
          type: 'tool-call',
          id: CallId(block.id),
          name: block.name,
          arguments: safeJson(block.input),
        })
      }
    }
  }
  return content
}

function visibleText(step: StepState): string {
  const fromMessage = step.pendingAssistant?.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('') ?? ''
  return step.text || fromMessage
}

function syntheticAssistant(message: SDKToolUseMessage): SDKAssistantMessage {
  return {
    type: 'assistant',
    agent_id: message.agent_id,
    run_id: message.run_id,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: message.call_id,
        name: message.name || 'cursor_tool',
        input: message.args ?? {},
      }],
    },
  }
}

function cursorUsage(usage: CursorTokenUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.cacheReadTokens === 0 ? {} : { cacheReadTokens: usage.cacheReadTokens }),
    ...(usage.cacheWriteTokens === 0 ? {} : { cacheWriteTokens: usage.cacheWriteTokens }),
    ...(usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens }),
  }
}

function toolResultText(message: SDKToolUseMessage): string {
  const value = message.result === undefined
    ? message.status === 'error' ? 'Cursor tool failed without a result payload.' : 'Cursor tool completed.'
    : safeJson(message.result)
  const notices = [
    message.truncated?.args ? 'arguments truncated by Cursor SDK' : '',
    message.truncated?.result ? 'result truncated by Cursor SDK' : '',
  ].filter(Boolean)
  return notices.length === 0 ? value : `${value}\n\n[${notices.join('; ')}]`
}

function safeJson(value: unknown): string {
  let rendered: string
  try {
    const json = value === undefined ? '{}' : JSON.stringify(value)
    rendered = json ?? JSON.stringify(String(value))
  } catch {
    rendered = JSON.stringify(String(value))
  }
  if (rendered.length <= MAX_TOOL_PAYLOAD_CHARS) return rendered
  return `${rendered.slice(0, MAX_TOOL_PAYLOAD_CHARS)}… [bridge truncated]`
}
