import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { buildCursorMessage } from '../src/cursor-agent.js'

describe('buildCursorMessage', () => {
  it('keeps text-only prompts as strings', async () => {
    const readImage = vi.fn()
    const result = await buildCursorMessage([
      createUserMessage({
        content: [{ type: 'text', text: 'hello' }],
        source: { kind: 'user' },
      }),
    ], { readImage })

    expect(result).toBe('hello')
    expect(readImage).not.toHaveBeenCalled()
  })

  it('resolves durable Harness images into Cursor base64 messages', async () => {
    const ref: ImageAttachmentRef = {
      attachmentId: AttachmentId('image-test'),
      mediaType: 'image/png',
      bytes: 4,
      width: 2,
      height: 1,
      name: 'screen.png',
    }
    const readImage = vi.fn(async () => ({
      ref,
      data: new Uint8Array([0, 1, 2, 3]),
    }))
    const result = await buildCursorMessage([
      createUserMessage({
        content: [
          { type: 'text', text: 'What is shown?' },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'user' },
      }),
    ], { readImage })

    expect(readImage).toHaveBeenCalledWith(ref, undefined)
    expect(result).toEqual({
      text: 'What is shown?\n[Attached image 1: screen.png]',
      images: [{
        data: 'AAECAw==',
        mimeType: 'image/png',
        dimension: { width: 2, height: 1 },
      }],
    })
  })

  it('preserves image order across injected and user messages', async () => {
    const first = imageRef('first', 'image/jpeg', 10, 20)
    const second = imageRef('second', 'image/webp', 30, 40)
    const bytes = new Map([
      [first.attachmentId, new Uint8Array([1])],
      [second.attachmentId, new Uint8Array([2])],
    ])
    const result = await buildCursorMessage([
      createUserMessage({
        content: [{ type: 'image', attachment: first }],
        source: { kind: 'plugin', plugin: 'test' },
      }),
      createUserMessage({
        content: [
          { type: 'text', text: 'Compare these.' },
          { type: 'image', attachment: second },
        ],
        source: { kind: 'user' },
      }),
    ], {
      readImage: async ref => ({ ref, data: bytes.get(ref.attachmentId)! }),
    })

    expect(result).toMatchObject({
      images: [
        { data: 'AQ==', mimeType: 'image/jpeg' },
        { data: 'Ag==', mimeType: 'image/webp' },
      ],
    })
    expect(typeof result === 'string' ? result : result.text).toContain(
      '[Context 2]\nCompare these.',
    )
  })
})

function imageRef(
  id: string,
  mediaType: ImageAttachmentRef['mediaType'],
  width: number,
  height: number,
): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(id),
    mediaType,
    bytes: 1,
    width,
    height,
  }
}
