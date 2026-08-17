import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { SettingSource } from '@cursor/sdk'

export const CURSOR_PROVIDER = 'cursor-agent'
export type ApiKeyResolver = () => Promise<string | undefined>

export interface Config {
  apiKeyEnv: string
  defaultModel: string
  stateDir?: string
  sandbox: boolean
  autoReview: boolean
  settingSources: SettingSource[]
  modelCacheMs: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().default('CURSOR_API_KEY'),
  defaultModel: z.string().default('auto'),
  stateDir: z.string(),
  sandbox: z.boolean().default(true),
  autoReview: z.boolean().default(true),
  settingSources: z.array(
    z.union([
      z.const('project'),
      z.const('user'),
      z.const('team'),
      z.const('mdm'),
      z.const('plugins'),
      z.const('all'),
    ]),
  ).default([]),
  modelCacheMs: z.number().step(1).min(1_000).default(60_000),
})

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured || join(homedir(), '.dsh')
}

export function resolveStateDir(config: Config): string {
  return config.stateDir?.trim() || join(resolveDshHome(), 'cursor-agent-store')
}

export function hasExecutable(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    try {
      accessSync(join(directory, name), constants.X_OK)
      return true
    } catch {
      // Continue through PATH.
    }
  }
  return false
}

export function assertRuntimePrerequisites(config: Config): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`cursor-harness-bridge requires Node.js 22.19+ or 24+ (current: ${process.versions.node})`)
  }
  if (config.sandbox && process.platform === 'linux' && !hasExecutable('bwrap')) {
    throw new Error('Cursor sandbox is enabled but bubblewrap (bwrap) is not installed')
  }
}
