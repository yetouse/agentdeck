import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stat } from 'node:fs/promises'

const execFileAsync = promisify(execFile)

const EXEC_TIMEOUT_MS = 10_000
const MAX_TASK_LENGTH = 2_000

export interface LaunchOptions {
  task: string
  name?: string
  cwd?: string
  // Dev/smoke-test convenience: override the full shell command that runs inside
  // the new tmux window.  Intentionally not exposed in the UI; local-only.
  command?: string
}

export interface LaunchResult {
  sessionName: string
  target: string
  commandSummary: string
  cwd: string
  message: string
  warning?: string
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'agent'
}

function makeSessionName(displayName?: string): string {
  const slug = displayName ? slugify(displayName) : 'agent'
  const ts = Date.now().toString(36)  // short base-36 timestamp
  return `agentdeck-${slug}-${ts}`
}

// Wrap a string in single quotes, escaping any embedded single quotes.
// Safe for embedding user-supplied values in shell commands run by tmux.
function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Attach a numeric `status` to an Error for the HTTP layer.
function launchError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

export async function launchClaude(opts: LaunchOptions): Promise<LaunchResult> {
  const { task, name, cwd: cwdOpt, command: commandOverride } = opts

  if (typeof task !== 'string' || task.trim().length === 0) {
    throw launchError('task is required and must be a non-empty string', 400)
  }
  if (task.length > MAX_TASK_LENGTH) {
    throw launchError(`task exceeds maximum length of ${MAX_TASK_LENGTH} characters`, 400)
  }

  // Resolve and validate working directory.
  const cwd = cwdOpt ?? process.cwd()
  if (cwdOpt !== undefined) {
    try {
      const info = await stat(cwdOpt)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch {
      throw launchError(`cwd does not exist or is not a directory: ${cwdOpt}`, 400)
    }
  }

  // Verify tmux is present before doing anything else.
  try {
    await execFileAsync('tmux', ['-V'], { timeout: EXEC_TIMEOUT_MS })
  } catch {
    throw launchError(
      'tmux is not available. Install tmux and start a session to use the launch endpoint.',
      503,
    )
  }

  if (commandOverride !== undefined && process.env['AGENTDECK_ALLOW_COMMAND_OVERRIDE'] !== '1') {
    throw launchError('command override is disabled; set AGENTDECK_ALLOW_COMMAND_OVERRIDE=1 for local smoke tests', 403)
  }

  const sessionName = makeSessionName(name)
  // Default: interactive claude with the task as its initial prompt.
  // execFile keeps the outer args injection-free; shellQuote handles the
  // task string inside the shell command that tmux runs.
  const claudeCmd = commandOverride ?? `claude ${shellQuote(task.trim())}`
  const target = `${sessionName}:0.0`

  try {
    // -d  detach immediately so the call returns without blocking
    // -s  session name
    // -c  start directory
    // last arg is the shell command tmux will execute in the new window
    await execFileAsync(
      'tmux',
      ['new-session', '-d', '-s', sessionName, '-c', cwd, claudeCmd],
      { timeout: EXEC_TIMEOUT_MS },
    )
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw launchError(`Failed to create tmux session: ${msg}`, 500)
  }

  const connector = process.env['AGENTDECK_CONNECTOR']
  const warning = connector !== 'tmux'
    ? 'AGENTDECK_CONNECTOR=tmux is not set — restart the bridge with that variable to observe this session automatically.'
    : undefined

  const summary = claudeCmd.length > 80 ? claudeCmd.slice(0, 77) + '…' : claudeCmd

  return {
    sessionName,
    target,
    commandSummary: summary,
    cwd,
    message: `Claude session launched as tmux session "${sessionName}". Attach with: tmux attach -t ${sessionName}`,
    warning,
  }
}
