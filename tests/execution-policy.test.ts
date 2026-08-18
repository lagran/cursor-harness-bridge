import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  READ_ONLY_TOOLS,
  cursorExecutionPolicy,
} from '../src/execution-policy.js'

const roots: string[] = []
const bridgeRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const bwrapCompat = join(bridgeRoot, 'scripts', 'compat-bin', 'bwrap')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Cursor execution policy', () => {
  it('keeps Workspace Write inside the sandbox without classifier bypass', () => {
    expect(cursorExecutionPolicy('workspace-write')).toEqual({
      mode: 'workspace-write',
      sandboxEnabled: true,
      autoReview: false,
      includeAdditionalDirs: false,
    })
  })

  it('uses a read-only tool allowlist and leaves Full Access unrestricted', () => {
    expect(cursorExecutionPolicy('read-only')).toEqual({
      mode: 'read-only',
      sandboxEnabled: true,
      autoReview: true,
      tools: READ_ONLY_TOOLS,
      includeAdditionalDirs: true,
    })
    expect(cursorExecutionPolicy('danger-full-access')).toEqual({
      mode: 'danger-full-access',
      sandboxEnabled: false,
      autoReview: false,
      includeAdditionalDirs: true,
    })
  })
})

describe('RHEL 8 Bubblewrap compatibility', () => {
  it('drops only a redundant symlink self-bind with a resolved-target bind', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-bwrap-compat-'))
    roots.push(root)
    const target = join(root, 'resolved-ca.pem')
    const link = join(root, 'ca-bundle.crt')
    const fakeBwrap = join(root, 'real-bwrap')
    writeFileSync(target, 'certificate')
    symlinkSync(target, link)
    writeFileSync(fakeBwrap, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(fakeBwrap, 0o755)

    const result = spawnSync(
      bwrapCompat,
      [
        '--ro-bind', '/', '/',
        '--ro-bind', link, link,
        '--ro-bind', target, target,
        '--', '/bin/true',
      ],
      {
        encoding: 'utf8',
        env: { ...process.env, CURSOR_REAL_BWRAP: fakeBwrap },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      '--ro-bind', '/', '/',
      '--ro-bind', target, target,
      '--', '/bin/true',
    ])
  })

  it('preserves a symlink bind when no resolved-target bind exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'cursor-bwrap-compat-'))
    roots.push(root)
    const target = join(root, 'target')
    const link = join(root, 'link')
    const fakeBwrap = join(root, 'real-bwrap')
    writeFileSync(target, 'target')
    symlinkSync(target, link)
    writeFileSync(fakeBwrap, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
    chmodSync(fakeBwrap, 0o755)

    const result = spawnSync(
      bwrapCompat,
      ['--ro-bind', link, link, '--', '/bin/true'],
      {
        encoding: 'utf8',
        env: { ...process.env, CURSOR_REAL_BWRAP: fakeBwrap },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual([
      '--ro-bind', link, link, '--', '/bin/true',
    ])
  })
})
