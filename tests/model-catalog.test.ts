import type { ModelListItem } from '@cursor/sdk'
import { describe, expect, it } from 'vitest'
import { CursorModelCatalog } from '../src/model-catalog.js'

describe('CursorModelCatalog', () => {
  it('splits fast into model variants and maps effort to Harness reasoning', () => {
    const catalog = new CursorModelCatalog()
    catalog.update([grokModel()])

    const routes = catalog.list('cursor-agent').filter(route => route.id !== 'auto')
    expect(routes.map(route => [route.id, route.name])).toEqual([
      ['grok-4.6', 'Cursor Grok 4.6 · Fast'],
      ['grok-4.6::fast=false', 'Cursor Grok 4.6 · Standard'],
    ])
    const standard = catalog.resolve('cursor-agent', 'grok-4.6::fast=false')
    expect(standard.reasoning?.efforts.map(effort => String(effort.id))).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ])
    expect(String(standard.reasoning?.defaultEffort)).toBe('high')
    expect(catalog.selection('grok-4.6')).toEqual({
      id: 'grok-4.6',
      params: [
        { id: 'fast', value: 'true' },
        { id: 'effort', value: 'high' },
      ],
    })
    expect(catalog.selection('grok-4.6::fast=false', 'medium')).toEqual({
      id: 'grok-4.6',
      params: [
        { id: 'fast', value: 'false' },
        { id: 'effort', value: 'medium' },
      ],
    })
  })

  it('exposes context, thinking, and fast without multiplying effort routes', () => {
    const catalog = new CursorModelCatalog()
    catalog.update([opusModel()])

    const routes = catalog.list('cursor-agent').filter(route => route.id !== 'auto')
    expect(routes).toHaveLength(2)
    expect(routes[0]).toMatchObject({
      id: 'claude-opus-4-8',
      name: 'Opus 4.8 · Thinking On · Context 1M · Fast',
    })
    expect(routes[1]?.name).toBe(
      'Opus 4.8 · Thinking Off · Context 300K · Standard',
    )
    expect(
      catalog.resolve('cursor-agent', routes[1]!.id).reasoning?.efforts
        .map(effort => String(effort.id)),
    ).toEqual(['low', 'high'])
    expect(catalog.selection(routes[1]!.id, 'high')).toEqual({
      id: 'claude-opus-4-8',
      params: [
        { id: 'thinking', value: 'false' },
        { id: 'context', value: '300k' },
        { id: 'fast', value: 'false' },
        { id: 'effort', value: 'high' },
      ],
    })
  })

  it('turns Haiku thinking into two explicit routes', () => {
    const catalog = new CursorModelCatalog()
    catalog.update([{
      id: 'claude-haiku-4-5',
      displayName: 'Haiku 4.5',
      parameters: [{
        id: 'thinking',
        displayName: 'Thinking',
        values: [{ value: 'false' }, { value: 'true' }],
      }],
      variants: [
        {
          params: [{ id: 'thinking', value: 'false' }],
          displayName: 'Haiku 4.5',
        },
        {
          params: [{ id: 'thinking', value: 'true' }],
          displayName: 'Haiku 4.5',
          isDefault: true,
        },
      ],
    }])

    const routes = catalog.list('cursor-agent').filter(route => route.id !== 'auto')
    expect(routes.map(route => route.name)).toEqual([
      'Haiku 4.5 · Thinking On',
      'Haiku 4.5 · Thinking Off',
    ])
    expect(catalog.selection('claude-haiku-4-5')).toEqual({
      id: 'claude-haiku-4-5',
      params: [{ id: 'thinking', value: 'true' }],
    })
    expect(catalog.selection('claude-haiku-4-5::thinking=false')).toEqual({
      id: 'claude-haiku-4-5',
      params: [{ id: 'thinking', value: 'false' }],
    })
  })

  it('maps GPT reasoning to the same effort selector', () => {
    const catalog = new CursorModelCatalog()
    catalog.update([{
      id: 'gpt-5.4-mini',
      displayName: 'GPT-5.4 Mini',
      parameters: [{
        id: 'reasoning',
        displayName: 'Reasoning',
        values: [
          { value: 'none', displayName: 'None' },
          { value: 'medium', displayName: 'Medium' },
          { value: 'high', displayName: 'High' },
        ],
      }],
      variants: [
        {
          params: [{ id: 'reasoning', value: 'none' }],
          displayName: 'GPT-5.4 Mini',
        },
        {
          params: [{ id: 'reasoning', value: 'medium' }],
          displayName: 'GPT-5.4 Mini',
          isDefault: true,
        },
        {
          params: [{ id: 'reasoning', value: 'high' }],
          displayName: 'GPT-5.4 Mini',
        },
      ],
    }])

    const resolved = catalog.resolve('cursor-agent', 'gpt-5.4-mini')
    expect(resolved.reasoning?.efforts.map(effort => String(effort.id))).toEqual([
      'none',
      'medium',
      'high',
    ])
    expect(catalog.selection('gpt-5.4-mini', 'high')).toEqual({
      id: 'gpt-5.4-mini',
      params: [{ id: 'reasoning', value: 'high' }],
    })
  })
})

function grokModel(): ModelListItem {
  const variants = []
  for (const effort of ['low', 'medium', 'high', 'xhigh']) {
    for (const fast of ['false', 'true']) {
      variants.push({
        params: [
          { id: 'effort', value: effort },
          { id: 'fast', value: fast },
        ],
        displayName: 'Cursor Grok 4.6',
        ...(effort === 'high' && fast === 'true' ? { isDefault: true } : {}),
      })
    }
  }
  return {
    id: 'grok-4.6',
    displayName: 'Cursor Grok 4.6',
    parameters: [
      {
        id: 'effort',
        displayName: 'Effort',
        values: ['low', 'medium', 'high', 'xhigh'].map(value => ({ value })),
      },
      {
        id: 'fast',
        displayName: 'Fast',
        values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
      },
    ],
    variants,
  }
}

function opusModel(): ModelListItem {
  return {
    id: 'claude-opus-4-8',
    displayName: 'Opus 4.8',
    parameters: [
      {
        id: 'thinking',
        displayName: 'Thinking',
        values: [{ value: 'false' }, { value: 'true' }],
      },
      {
        id: 'context',
        displayName: 'Context',
        values: [
          { value: '300k', displayName: '300K' },
          { value: '1m', displayName: '1M' },
        ],
      },
      {
        id: 'effort',
        displayName: 'Effort',
        values: [{ value: 'low' }, { value: 'high' }],
      },
      {
        id: 'fast',
        displayName: 'Fast',
        values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
      },
    ],
    variants: [
      {
        params: [
          { id: 'thinking', value: 'true' },
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'low' },
          { id: 'fast', value: 'true' },
        ],
        displayName: 'Opus 4.8',
      },
      {
        params: [
          { id: 'thinking', value: 'true' },
          { id: 'context', value: '1m' },
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'true' },
        ],
        displayName: 'Opus 4.8',
        isDefault: true,
      },
      {
        params: [
          { id: 'thinking', value: 'false' },
          { id: 'context', value: '300k' },
          { id: 'effort', value: 'low' },
          { id: 'fast', value: 'false' },
        ],
        displayName: 'Opus 4.8',
      },
      {
        params: [
          { id: 'thinking', value: 'false' },
          { id: 'context', value: '300k' },
          { id: 'effort', value: 'high' },
          { id: 'fast', value: 'false' },
        ],
        displayName: 'Opus 4.8',
      },
    ],
  }
}
