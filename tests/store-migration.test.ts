import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  JsonlLocalAgentStore,
  type LocalAgentStore,
} from '@cursor/sdk'
import { SqliteLocalAgentStore } from '@cursor/sdk/sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateJsonlStores,
  sqliteWorkspaceRoot,
} from '../src/store-migration.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Cursor JSONL to SQLite migration', () => {
  it('preserves checkpoints and event order and expires stale activity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-store-migration-'))
    roots.push(root)
    const stateDir = join(root, 'state')
    const workspaceRef = join(root, 'workspace')
    const source = new JsonlLocalAgentStore(stateDir)
    const agentId = 'agent-migration-test'
    const runId = 'run-migration-test'
    const blobId = 'a'.repeat(64)
    const checkpoint = Buffer.from('checkpoint bytes')
    const now = Date.now()

    await source.agents.create({
      agent: {
        agentId,
        cwd: workspaceRef,
        status: 'running',
        activeRunId: runId,
        name: 'Migration test',
        createdAt: now,
        updatedAt: now,
        latestCheckpoint: { schemaVersion: 1, rootBlobId: blobId },
        sdkMetadata: { encryption: 'preserved' },
      },
    })
    await source.checkpoints.create({
      agentId,
      blobId,
      data: checkpoint,
    })
    await source.runs.create({
      run: {
        runId,
        agentId,
        turnNumber: 1,
        status: 'running',
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        latestCheckpointRef: { schemaVersion: 1, rootBlobId: blobId },
      },
    })
    await source.runEvents.append({
      runId,
      eventType: 'first',
      payload: { value: 1 },
      payloadRef: null,
      idempotencyKey: 'first-key',
    })
    await source.runEvents.append({
      runId,
      eventType: 'second',
      payload: { value: 2 },
      payloadRef: null,
      idempotencyKey: 'second-key',
    })

    const stores = new Map<string, SqliteLocalAgentStore>()
    const openStore = async (workspace: string): Promise<LocalAgentStore> => {
      let store = stores.get(workspace)
      if (store === undefined) {
        store = await SqliteLocalAgentStore.open({
          workspaceRef: workspace,
          stateRoot: sqliteWorkspaceRoot(stateDir, workspace),
        })
        stores.set(workspace, store)
      }
      return store
    }
    const messages: string[] = []
    const first = await migrateJsonlStores({
      stateDir,
      openStore,
      logger: { info: message => messages.push(message) },
    })

    expect(first).toMatchObject({
      migrated: true,
      agents: 1,
      checkpoints: 1,
      runs: 1,
      events: 2,
    })
    expect(messages).toHaveLength(1)
    const target = stores.get(workspaceRef)
    expect(target).toBeDefined()
    expect(await target?.agents.get({ agentId })).toMatchObject({
      status: 'idle',
      activeRunId: null,
      sdkMetadata: { encryption: 'preserved' },
    })
    expect(Buffer.from(
      await target?.checkpoints.get({ agentId, blobId }) ?? [],
    )).toEqual(checkpoint)
    expect(await target?.runs.get({ agentId, runId })).toMatchObject({
      status: 'expired',
      latestCheckpointRef: { schemaVersion: 1, rootBlobId: blobId },
    })
    const events = await target?.runEvents.list({ runId, limit: 10 })
    expect(events?.items.map(event => ({
      type: event.eventType,
      payload: event.payload,
      key: event.idempotencyKey,
    }))).toEqual([
      { type: 'first', payload: { value: 1 }, key: 'first-key' },
      { type: 'second', payload: { value: 2 }, key: 'second-key' },
    ])

    const second = await migrateJsonlStores({
      stateDir,
      openStore,
      logger: { info: message => messages.push(message) },
    })
    expect(second.migrated).toBe(false)
    expect((await target?.runEvents.list({ runId, limit: 10 }))?.items).toHaveLength(2)

    await Promise.all([...stores.values()].map(store => store.dispose()))
  })
})
