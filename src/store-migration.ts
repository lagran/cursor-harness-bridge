import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  LocalAgentDocument,
  LocalAgentRunDocument,
  LocalAgentRunEventDocument,
} from '@cursor/sdk'
import type { ManagedLocalAgentStore } from './cursor-runtime.js'

const MIGRATION_VERSION = 1
const MARKER_NAME = 'sqlite-migration-v1.json'

interface CheckpointLine {
  agentId: string
  blobId: string
  dataBase64: string
}

export interface StoreMigrationLogger {
  info(message: string): void
}

export interface StoreMigrationOptions {
  stateDir: string
  openStore(workspaceRef: string): Promise<ManagedLocalAgentStore>
  logger: StoreMigrationLogger
}

export interface StoreMigrationResult {
  migrated: boolean
  agents: number
  checkpoints: number
  runs: number
  events: number
  elapsedMs: number
}

export function sqliteWorkspaceRoot(stateDir: string, workspaceRef: string): string {
  const identity = resolve(workspaceRef)
  const digest = createHash('sha256').update(identity).digest('hex').slice(0, 24)
  return join(stateDir, 'sqlite', digest)
}

export async function migrateJsonlStores(
  options: StoreMigrationOptions,
): Promise<StoreMigrationResult> {
  const startedAt = performance.now()
  const markerPath = join(options.stateDir, MARKER_NAME)
  const existingMarker = await readMarker(markerPath)
  if (existingMarker === MIGRATION_VERSION) {
    return {
      migrated: false,
      agents: 0,
      checkpoints: 0,
      runs: 0,
      events: 0,
      elapsedMs: performance.now() - startedAt,
    }
  }

  const agentsPath = join(options.stateDir, 'agents.ndjson')
  const checkpointsPath = join(options.stateDir, 'checkpoints.ndjson')
  const runsPath = join(options.stateDir, 'runs.ndjson')
  const eventsPath = join(options.stateDir, 'run_events.ndjson')
  const agentTargets = new Map<string, {
    workspaceRef: string
    store: ManagedLocalAgentStore
  }>()
  const runTargets = new Map<string, {
    agentId: string
    workspaceRef: string
    store: ManagedLocalAgentStore
  }>()
  const runsByWorkspace = new Map<string, {
    store: ManagedLocalAgentStore
    runIds: string[]
  }>()
  const counts = { agents: 0, checkpoints: 0, runs: 0, events: 0 }
  const migrationTime = Date.now()

  await forEachJsonLine<LocalAgentDocument>(agentsPath, async agent => {
    const workspaceRef = resolve(agent.cwd)
    const store = await options.openStore(workspaceRef)
    const normalized: LocalAgentDocument = agent.status === 'running'
      ? {
          ...agent,
          status: 'idle',
          activeRunId: null,
          updatedAt: migrationTime,
        }
      : agent
    const existing = await store.agents.get({ agentId: agent.agentId })
    if (existing === null) {
      await store.agents.create({ agent: normalized })
    } else {
      await store.agents.update({ agent: normalized })
    }
    agentTargets.set(agent.agentId, { workspaceRef, store })
    counts.agents++
  })

  await forEachJsonLine<CheckpointLine>(checkpointsPath, async checkpoint => {
    const target = agentTargets.get(checkpoint.agentId)
    if (target === undefined) {
      throw new Error(
        `cannot migrate checkpoint "${checkpoint.blobId}": agent "${checkpoint.agentId}" is missing`,
      )
    }
    const existing = await target.store.checkpoints.get({
      agentId: checkpoint.agentId,
      blobId: checkpoint.blobId,
    })
    if (existing === null) {
      await target.store.checkpoints.create({
        agentId: checkpoint.agentId,
        blobId: checkpoint.blobId,
        data: Buffer.from(checkpoint.dataBase64, 'base64'),
      })
    }
    counts.checkpoints++
  })

  await forEachJsonLine<LocalAgentRunDocument>(runsPath, async run => {
    const target = agentTargets.get(run.agentId)
    if (target === undefined) {
      throw new Error(`cannot migrate run "${run.runId}": agent "${run.agentId}" is missing`)
    }
    const normalized: LocalAgentRunDocument = run.status === 'running'
      || run.status === 'queued'
      ? {
          ...run,
          status: 'expired',
          error: run.error ?? 'Expired while migrating the Cursor SDK store',
          updatedAt: migrationTime,
          endedAt: migrationTime,
        }
      : run
    const existing = await target.store.runs.get({
      agentId: run.agentId,
      runId: run.runId,
    })
    if (existing === null) {
      await target.store.runs.create({ run: normalized })
    } else {
      await target.store.runs.update({ run: normalized })
    }
    runTargets.set(run.runId, {
      agentId: run.agentId,
      workspaceRef: target.workspaceRef,
      store: target.store,
    })
    const grouped = runsByWorkspace.get(target.workspaceRef)
    if (grouped === undefined) {
      runsByWorkspace.set(target.workspaceRef, {
        store: target.store,
        runIds: [run.runId],
      })
    } else {
      grouped.runIds.push(run.runId)
    }
    counts.runs++
  })

  for (const { store, runIds } of runsByWorkspace.values()) {
    await store.runEvents.delete({ filter: { runIds } })
  }

  await forEachJsonLine<LocalAgentRunEventDocument>(eventsPath, async event => {
    const target = runTargets.get(event.runId)
    if (target === undefined) {
      throw new Error(`cannot migrate event for unknown run "${event.runId}"`)
    }
    await target.store.runEvents.append({
      runId: event.runId,
      eventType: event.eventType,
      payload: event.payload,
      payloadRef: event.payloadRef,
      idempotencyKey: event.idempotencyKey,
    })
    counts.events++
  })

  await mkdir(options.stateDir, { recursive: true, mode: 0o700 })
  const marker = {
    version: MIGRATION_VERSION,
    completedAt: new Date().toISOString(),
    source: 'jsonl',
    counts,
  }
  const temporaryMarker = `${markerPath}.${process.pid}.tmp`
  await writeFile(temporaryMarker, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(temporaryMarker, markerPath)

  const elapsedMs = performance.now() - startedAt
  options.logger.info(
    `Migrated Cursor SDK JSONL store to SQLite `
    + `(agents=${counts.agents}, checkpoints=${counts.checkpoints}, `
    + `runs=${counts.runs}, events=${counts.events}, elapsedMs=${Math.round(elapsedMs)})`,
  )
  return { migrated: true, ...counts, elapsedMs }
}

async function readMarker(path: string): Promise<number | undefined> {
  if (!existsSync(path)) return undefined
  const value = JSON.parse(await readFile(path, 'utf8')) as { version?: unknown }
  if (value.version !== MIGRATION_VERSION) {
    throw new Error(`unsupported Cursor SDK store migration marker version: ${String(value.version)}`)
  }
  return value.version
}

async function forEachJsonLine<T>(
  path: string,
  visit: (value: T) => Promise<void>,
): Promise<void> {
  if (!existsSync(path)) return
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })
  try {
    for await (const line of lines) {
      if (!line.trim()) continue
      await visit(JSON.parse(line) as T)
    }
  } finally {
    lines.close()
    input.destroy()
  }
}
