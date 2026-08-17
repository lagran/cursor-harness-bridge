import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dsh = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')

if (!existsSync(dsh)) {
  console.error('DeepSeek Harness CLI is missing. Run npm install first.')
  process.exit(1)
}

const result = spawnSync(dsh, ['plugin', '--profile', 'web', 'add', root], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
})

if (result.error) throw result.error
process.exit(result.status ?? 1)
