import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Agent } from '@cursor/sdk'

if (!process.env.CURSOR_API_KEY) {
  console.log('SKIP: CURSOR_API_KEY is not set')
  process.exit(0)
}

const args = process.argv.slice(2)
const workspaceIndex = args.indexOf('--workspace')
const rawWorkspace = workspaceIndex >= 0 ? args[workspaceIndex + 1] : process.env.CURSOR_WORKSPACE
if (!rawWorkspace) {
  console.error('Usage: npm run smoke -- --workspace /absolute/path/to/project')
  process.exit(2)
}
const workspace = resolve(rawWorkspace)
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  console.error(`Workspace is not a directory: ${workspace}`)
  process.exit(2)
}

const result = await Agent.prompt('Reply with exactly: CURSOR_BRIDGE_OK. Do not call tools.', {
  apiKey: process.env.CURSOR_API_KEY,
  model: { id: process.env.CURSOR_MODEL || 'auto' },
  local: {
    cwd: workspace,
    sandboxOptions: { enabled: true },
    autoReview: true,
    settingSources: [],
  },
})

if (result.status !== 'finished' || !result.result?.includes('CURSOR_BRIDGE_OK')) {
  console.error(result)
  process.exit(1)
}
console.log('CURSOR_BRIDGE_OK')
