import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CursorEventMapper, UnsupportedCursorRequestError } from '../src/event-mapper.js'

function createMapper() {
  const session = Session.create(SessionId(crypto.randomUUID()))
  session.append('turn/start', { turn: 1 })
  const mapper = new CursorEventMapper(session, 1, 'cursor-agent', 'auto')
  mapper.begin([
    createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }),
  ])
  return { session, mapper }
}

describe('CursorEventMapper', () => {
  it('streams text and attaches terminal usage to the final assistant message', () => {
    const { session, mapper } = createMapper()
    mapper.setRunMetadata({
      agentId: 'agent-1',
      runId: 'run-1',
      requestId: 'request-1',
    })
    mapper.handleDelta({ type: 'text-delta', text: 'hel' })
    mapper.handleDelta({ type: 'text-delta', text: 'lo' })
    mapper.handleMessage({
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      // Cursor's normalized assistant event may contain only the final
      // character; onDelta is the authoritative complete text stream.
      message: { role: 'assistant', content: [{ type: 'text', text: 'o' }] },
    })
    mapper.handleMessage({
      type: 'usage',
      agent_id: 'agent-1',
      run_id: 'run-1',
      usage: {
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        totalTokens: 15,
      },
    })
    mapper.finish()

    const assistant = session.events.find(event => event.type === 'assistant/message')
    expect(assistant?.data.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(assistant?.data.message.source.replayState).toEqual({
      version: 1,
      cursorAgentId: 'agent-1',
      cursorRunId: 'run-1',
      cursorRequestId: 'request-1',
    })
    expect(assistant?.data.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadTokens: 3,
    })
    expect(session.events.filter(event => event.type === 'assistant/chunk'
      && event.data.chunk.type === 'text-delta')).toHaveLength(2)
    expect(session.events.at(-1)?.type).toBe('step/end')
  })

  it('maps Cursor tool lifecycle without asking Harness to execute it', () => {
    const { session, mapper } = createMapper()
    mapper.handleMessage({
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'README.md' } }],
      },
    })
    mapper.handleMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'call-1',
      name: 'read',
      status: 'running',
      args: { path: 'README.md' },
    })
    mapper.handleMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'call-1',
      name: 'read',
      status: 'completed',
      result: { content: 'ok' },
    })
    mapper.handleDelta({ type: 'text-delta', text: 'done' })
    mapper.handleMessage({
      type: 'assistant',
      agent_id: 'agent-1',
      run_id: 'run-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'e' }] },
    })
    mapper.finish()

    expect(session.events.filter(event => event.type === 'tool/call')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'tool/result')).toHaveLength(1)
    expect(session.events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    const finalAssistant = session.events.filter(event => event.type === 'assistant/message').at(-1)
    expect(finalAssistant?.data.message.content).toContainEqual({ type: 'text', text: 'done' })
    expect(session.events.filter(event => event.type === 'step/start')).toHaveLength(2)
    expect(session.events.filter(event => event.type === 'step/start').map(event => event.data.step)).toEqual([1, 2])
    const result = session.events.find(event => event.type === 'tool/result')
    expect(result?.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-1',
      isError: false,
    })
  })

  it('closes an incomplete read-only tool neutrally when the run finishes', () => {
    const { session, mapper } = createMapper()
    mapper.handleMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'call-incomplete',
      name: 'read',
      status: 'running',
      args: { path: 'missing.txt' },
    })
    mapper.handleDelta({ type: 'text-delta', text: 'The file is unavailable.' })
    mapper.finish()

    const results = session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.error).toBeUndefined()
    expect(results[0]?.data.meta).toEqual({
      synthetic: true,
      terminalEvent: 'missing',
      disposition: 'neutral-read-only',
    })
    expect(results[0]?.data.message.content[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'call-incomplete',
      isError: false,
    })
    expect(results[0]?.data.step).toBe(1)
    expect(session.events.indexOf(results[0]!)).toBeLessThan(
      session.events.findIndex(event =>
        event.type === 'step/end' && event.data.step === 1),
    )
    expect(session.events.findLast(
      event => event.type === 'assistant/message',
    )?.data.message.content).toContainEqual({
      type: 'text',
      text: 'The file is unavailable.',
    })
  })

  it('keeps incomplete mutating tools red on finish and all tools red on abort', () => {
    const finished = createMapper()
    finished.mapper.handleMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'edit-incomplete',
      name: 'edit',
      status: 'running',
      args: { path: 'file.txt' },
    })
    finished.mapper.finish()
    expect(finished.session.events.find(
      event => event.type === 'tool/result',
    )?.data.error).toEqual({
      name: 'CursorToolIncompleteError',
      code: 'CURSOR_TOOL_INCOMPLETE',
    })

    const aborted = createMapper()
    aborted.mapper.handleMessage({
      type: 'tool_call',
      agent_id: 'agent-1',
      run_id: 'run-1',
      call_id: 'read-cancelled',
      name: 'read',
      status: 'running',
      args: { path: 'file.txt' },
    })
    aborted.mapper.abort()
    expect(aborted.session.events.find(
      event => event.type === 'tool/result',
    )?.data.error).toEqual({
      name: 'CursorToolCancelledError',
      code: 'CURSOR_TOOL_CANCELLED',
    })
  })

  it('fails explicitly when Cursor asks for unsupported interactive input', () => {
    const { mapper } = createMapper()
    expect(() => mapper.handleMessage({
      type: 'request',
      agent_id: 'agent-1',
      run_id: 'run-1',
      request_id: 'request-1',
    })).toThrow(UnsupportedCursorRequestError)
  })
})
