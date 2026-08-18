import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import type { SettingSource } from '@cursor/sdk'

export const CURSOR_PROVIDER = 'cursor-agent'
export type ApiKeyResolver = () => Promise<string | undefined>

export interface Config {
  apiKeyEnv: string
  defaultModel: string
  stateDir?: string
  settingSources: SettingSource[]
  additionalDirs: string[]
  modelCacheMs: number
  workspaceScanCacheMs: number
  runStallMs: number
}

export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().default('CURSOR_API_KEY'),
  defaultModel: z.string().default('auto'),
  stateDir: z.string(),
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
  additionalDirs: z.array(z.string()).default([]),
  modelCacheMs: z.number().step(1).min(1_000).default(60_000),
  workspaceScanCacheMs: z.number().step(1).min(1_000).default(300_000),
  runStallMs: z.number().step(1).min(10_000).default(90_000),
})

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME?.trim()
  return configured || join(homedir(), '.dsh')
}

export function resolveStateDir(config: Config): string {
  return config.stateDir?.trim() || join(resolveDshHome(), 'cursor-agent-store')
}

export function installCursorSandboxCompatibility(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (process.platform !== 'linux') return
  const bridgeRoot = dirname(dirname(fileURLToPath(import.meta.url)))
  const compatBin = join(bridgeRoot, 'scripts', 'compat-bin')
  try {
    accessSync(join(compatBin, 'bwrap'), constants.X_OK)
  } catch {
    return
  }

  const entries = (env.PATH ?? '').split(delimiter).filter(Boolean)
  if (entries.includes(compatBin)) return
  const realBwrap = env.CURSOR_REAL_BWRAP ?? executablePath('bwrap', env)
  if (realBwrap === undefined) return
  if (env.CURSOR_REAL_BWRAP === undefined) {
    env.CURSOR_REAL_BWRAP = realBwrap
  }
  env.PATH = [compatBin, ...entries].join(delimiter)
}

export function hasExecutable(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return executablePath(name, env) !== undefined
}

function executablePath(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    try {
      const candidate = join(directory, name)
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue through PATH.
    }
  }
  return undefined
}

export function assertRuntimePrerequisites(): void {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(`cursor-harness-bridge requires Node.js 22.19+ or 24+ (current: ${process.versions.node})`)
  }
  if (process.platform === 'linux' && !hasExecutable('bwrap')) {
    throw new Error(
      'Cursor sandbox is available from the Harness permission selector but bubblewrap (bwrap) is not installed',
    )
  }
}
