import type { ToolName } from '@cursor/sdk'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'

/**
 * Cursor only exposes an on/off filesystem sandbox. Read-only therefore also
 * needs a positive tool allowlist so no shell, MCP, subagent, or mutation tool
 * can escape the narrower Harness policy.
 */
export const READ_ONLY_TOOLS = [
  'read',
  'grep',
  'glob',
  'ls',
  'readLints',
  'semSearch',
  'webSearch',
  'webFetch',
] as const satisfies readonly ToolName[]

export const HEADLESS_DISALLOWED_TOOLS = [
  'delete',
] as const satisfies readonly ToolName[]

export interface CursorExecutionPolicy {
  mode: SandboxMode
  sandboxEnabled: boolean
  autoReview: boolean
  tools?: readonly ToolName[]
  disallowedTools?: readonly ToolName[]
  includeAdditionalDirs: boolean
}

export type CursorExecutionPolicyResolver = () => CursorExecutionPolicy

export function cursorExecutionPolicy(mode: SandboxMode): CursorExecutionPolicy {
  switch (mode) {
    case 'read-only':
      return {
        mode,
        sandboxEnabled: true,
        autoReview: true,
        tools: READ_ONLY_TOOLS,
        includeAdditionalDirs: true,
      }
    case 'workspace-write':
      return {
        mode,
        sandboxEnabled: true,
        // Auto-review deliberately sends commands that cannot run in the
        // sandbox (including writes outside cwd) to a classifier, which may
        // allow an unsandboxed retry. Sandbox-only execution is required for
        // Harness Workspace Write to remain a hard filesystem boundary.
        autoReview: false,
        disallowedTools: HEADLESS_DISALLOWED_TOOLS,
        includeAdditionalDirs: false,
      }
    case 'danger-full-access':
      return {
        mode,
        sandboxEnabled: false,
        autoReview: false,
        disallowedTools: HEADLESS_DISALLOWED_TOOLS,
        includeAdditionalDirs: true,
      }
  }
}
