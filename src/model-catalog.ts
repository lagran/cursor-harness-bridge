import type {
  ModelListItem,
  ModelParameterDefinition,
  ModelParameterValue,
  ModelSelection,
  ModelVariant,
} from '@cursor/sdk'
import {
  ReasoningEffortId,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'

const ROUTE_SEPARATOR = '::'
const REASONING_PARAMETERS = new Set(['effort', 'reasoning', 'optimize_for'])

interface ReasoningRoute {
  parameterId: string
  values: Array<{ id: string; name: string }>
  defaultValue: string
}

interface CursorModelRoute {
  id: string
  baseModelId: string
  name: string
  description?: string
  fixedParams: ModelParameterValue[]
  reasoning?: ReasoningRoute
}

interface VariantGroup {
  fixedParams: ModelParameterValue[]
  variants: ModelVariant[]
}

export class CursorModelCatalog {
  private routes = new Map<string, CursorModelRoute>()

  update(models: readonly ModelListItem[], fallbackModelId = 'auto'): void {
    const next = new Map<string, CursorModelRoute>()
    const source = [...models]
    if (!source.some(model => model.id === fallbackModelId)) {
      source.unshift({
        id: fallbackModelId,
        displayName: fallbackModelId === 'auto' ? 'Cursor Auto' : fallbackModelId,
      })
    }

    for (const model of source) {
      for (const route of expandModel(model)) {
        if (next.has(route.id)) {
          throw new Error(`Cursor model route collision: ${route.id}`)
        }
        next.set(route.id, route)
      }
    }
    this.routes = next
  }

  list(provider: string): LlmModelInfo[] {
    return [...this.routes.values()].map(route => ({
      provider,
      id: route.id,
      name: route.name,
      inputModalities: ['text', 'image'],
      ...(route.description === undefined ? {} : { description: route.description }),
    }))
  }

  resolve(provider: string, routeId: string): LlmResolvedModelInfo {
    const route = this.require(routeId)
    return {
      provider,
      id: route.id,
      name: route.name,
      inputModalities: ['text', 'image'],
      ...(route.description === undefined ? {} : { description: route.description }),
      ...(route.reasoning === undefined
        ? {}
        : {
            reasoning: {
              efforts: route.reasoning.values.map(value => ({
                id: ReasoningEffortId(value.id),
                name: value.name,
              })),
              defaultEffort: ReasoningEffortId(route.reasoning.defaultValue),
            },
          }),
    }
  }

  selection(routeId: string, reasoningEffort?: string): ModelSelection {
    const route = this.require(routeId)
    const params = route.fixedParams.map(param => ({ ...param }))
    if (route.reasoning !== undefined) {
      const value = reasoningEffort || route.reasoning.defaultValue
      if (!route.reasoning.values.some(candidate => candidate.id === value)) {
        throw new Error(
          `Cursor model route "${routeId}" does not support ${route.reasoning.parameterId}=${value}`,
        )
      }
      params.push({ id: route.reasoning.parameterId, value })
    }
    return {
      id: route.baseModelId,
      ...(params.length === 0 ? {} : { params }),
    }
  }

  has(routeId: string): boolean {
    return this.routes.has(routeId)
  }

  private require(routeId: string): CursorModelRoute {
    const route = this.routes.get(routeId)
    if (route === undefined) {
      throw new Error(`Unknown Cursor model route: ${routeId}`)
    }
    return route
  }
}

function expandModel(model: ModelListItem): CursorModelRoute[] {
  const modelName = catalogDisplayName(model)
  const definitions = model.parameters ?? []
  const reasoningDefinition = definitions.find(definition =>
    REASONING_PARAMETERS.has(definition.id),
  )
  const variants = model.variants?.length
    ? model.variants
    : [{ params: [], displayName: model.displayName, isDefault: true }]
  const defaultVariant = variants.find(variant => variant.isDefault) ?? variants[0]!
  const defaultKey = fixedKey(fixedParams(defaultVariant, reasoningDefinition))
  const groups = groupVariants(variants, reasoningDefinition)
  const globalDefaultReasoning = reasoningValue(defaultVariant, reasoningDefinition)
  const usedNames = new Map<string, number>()
  const orderedGroups = [...groups.entries()].sort(([left], [right]) => {
    if (left === defaultKey) return -1
    if (right === defaultKey) return 1
    return 0
  })

  return orderedGroups.map(([key, group], groupIndex) => {
    const isDefaultGroup = key === defaultKey
    const routeId = isDefaultGroup
      ? model.id
      : encodedRouteId(model.id, group.fixedParams, groupIndex)
    const qualifiers = visibleQualifiers(group.fixedParams, definitions)
    let name = qualifiers.length === 0
      ? modelName
      : `${modelName} · ${qualifiers.join(' · ')}`
    const seen = usedNames.get(name) ?? 0
    usedNames.set(name, seen + 1)
    if (seen > 0) name = `${name} · Variant ${seen + 1}`

    const reasoning = reasoningRoute(
      group,
      reasoningDefinition,
      globalDefaultReasoning,
    )
    return {
      id: routeId,
      baseModelId: model.id,
      name,
      ...(model.description === undefined ? {} : { description: model.description }),
      fixedParams: group.fixedParams,
      ...(reasoning === undefined ? {} : { reasoning }),
    }
  })
}

function catalogDisplayName(model: ModelListItem): string {
  switch (model.id) {
    case 'auto': return 'Cursor Auto'
    case 'auto-smart': return 'Cursor Router'
    case 'default': return 'Cursor Default'
    default: return model.displayName
  }
}

function groupVariants(
  variants: readonly ModelVariant[],
  reasoningDefinition: ModelParameterDefinition | undefined,
): Map<string, VariantGroup> {
  const groups = new Map<string, VariantGroup>()
  for (const variant of variants) {
    const fixed = fixedParams(variant, reasoningDefinition)
    const key = fixedKey(fixed)
    const group = groups.get(key)
    if (group === undefined) {
      groups.set(key, { fixedParams: fixed, variants: [variant] })
    } else {
      group.variants.push(variant)
    }
  }
  return groups
}

function fixedParams(
  variant: ModelVariant,
  reasoningDefinition: ModelParameterDefinition | undefined,
): ModelParameterValue[] {
  return variant.params
    .filter(param => param.id !== reasoningDefinition?.id)
    .map(param => ({ ...param }))
}

function fixedKey(params: readonly ModelParameterValue[]): string {
  return JSON.stringify(
    [...params].sort((left, right) =>
      left.id.localeCompare(right.id) || left.value.localeCompare(right.value),
    ),
  )
}

function encodedRouteId(
  baseModelId: string,
  params: readonly ModelParameterValue[],
  groupIndex: number,
): string {
  const suffix = [...params]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(param => `${encodeURIComponent(param.id)}=${encodeURIComponent(param.value)}`)
    .join('&')
  return `${baseModelId}${ROUTE_SEPARATOR}${suffix || `variant=${groupIndex + 1}`}`
}

function visibleQualifiers(
  params: readonly ModelParameterValue[],
  definitions: readonly ModelParameterDefinition[],
): string[] {
  const definitionsById = new Map(definitions.map(definition => [definition.id, definition]))
  const output: string[] = []
  for (const param of params) {
    const definition = definitionsById.get(param.id)
    if (definition === undefined) continue
    const valueName = definition.values.find(value => value.value === param.value)?.displayName
      || param.value
    switch (param.id) {
      case 'fast':
        output.push(param.value === 'true' ? 'Fast' : 'Standard')
        break
      case 'thinking':
        output.push(param.value === 'true' ? 'Thinking On' : 'Thinking Off')
        break
      case 'context':
        output.push(`Context ${valueName.toUpperCase()}`)
        break
      default:
        output.push(`${definition.displayName || titleCase(param.id)} ${valueName}`)
        break
    }
  }
  return output
}

function reasoningRoute(
  group: VariantGroup,
  definition: ModelParameterDefinition | undefined,
  globalDefault: string | undefined,
): ReasoningRoute | undefined {
  if (definition === undefined) return undefined
  const values = new Set<string>()
  for (const variant of group.variants) {
    const value = reasoningValue(variant, definition)
    if (value !== undefined) values.add(value)
  }
  if (values.size === 0) {
    for (const value of definition.values) values.add(value.value)
  }
  if (values.size === 0) return undefined

  const ordered = definition.values
    .filter(value => values.has(value.value))
    .map(value => ({
      id: value.value,
      name: value.displayName || titleCase(value.value),
    }))
  for (const value of values) {
    if (!ordered.some(candidate => candidate.id === value)) {
      ordered.push({ id: value, name: titleCase(value) })
    }
  }

  const groupDefault = group.variants.find(variant => variant.isDefault)
  const groupDefaultValue = groupDefault === undefined
    ? undefined
    : reasoningValue(groupDefault, definition)
  const defaultValue = groupDefaultValue
    || (globalDefault !== undefined && values.has(globalDefault) ? globalDefault : undefined)
    || ordered[0]!.id
  return {
    parameterId: definition.id,
    values: ordered,
    defaultValue,
  }
}

function reasoningValue(
  variant: ModelVariant,
  definition: ModelParameterDefinition | undefined,
): string | undefined {
  if (definition === undefined) return undefined
  return variant.params.find(param => param.id === definition.id)?.value
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
}
