import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
const args = process.argv.slice(2)
const workspaceIndex = args.indexOf('--workspace')
let workspace = process.env.CURSOR_WORKSPACE

if (workspaceIndex >= 0) {
  workspace = args[workspaceIndex + 1]
  args.splice(workspaceIndex, 2)
}
if (!workspace) {
  console.error('Usage: npm run web -- --workspace /absolute/path/to/project [--port 3080]')
  process.exit(2)
}

workspace = isAbsolute(workspace) ? workspace : resolve(process.cwd(), workspace)
if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
  console.error(`Workspace is not a directory: ${workspace}`)
  process.exit(2)
}
if (!existsSync(dsh)) {
  console.error('DeepSeek Harness CLI is missing. Run npm install first.')
  process.exit(1)
}

const child = spawn(dsh, ['web', ...args], {
  cwd: workspace,
  env: process.env,
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', error => {
  console.error(error)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 1)
})
