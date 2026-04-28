import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Agent } from './types.js'

const execFileAsync = promisify(execFile)
const EXEC_TIMEOUT_MS = 5_000
const MAX_INPUT_LENGTH = 4_000

function controlError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status })
}

// tmux connector agent names preserve the exact tmux target as
// "<session>:<window>.<pane>". Prefer that over the ID because IDs are
// sanitized for transport/display safety.
function getTmuxAgent(state: Map<string, Agent>, id: string): Agent {
  if (!id.startsWith('tmux:')) {
    throw controlError('Control is only supported for tmux agents (id must start with "tmux:")', 400)
  }
  const agent = state.get(id)
  if (!agent) {
    throw controlError('Agent not found', 404)
  }
  if (!agent.name.includes(':')) {
    throw controlError('Agent does not expose a valid tmux target', 400)
  }
  return agent
}

export async function sendAgentInput(
  state: Map<string, Agent>,
  id: string,
  body: unknown,
): Promise<{ ok: true }> {
  const agent = getTmuxAgent(state, id)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw controlError('Request body must be a JSON object', 400)
  }

  const b = body as Record<string, unknown>
  const text = b['text']
  const rawEnter = b['enter']
  const enter = rawEnter === undefined ? false : rawEnter

  if (typeof text !== 'string' || text.length === 0) {
    throw controlError('text is required and must be a non-empty string', 400)
  }
  if (text.length > MAX_INPUT_LENGTH) {
    throw controlError(`text exceeds maximum length of ${MAX_INPUT_LENGTH} characters`, 400)
  }
  if (typeof enter !== 'boolean') {
    throw controlError('enter must be a boolean if provided', 400)
  }

  const target = agent.name
  try {
    await execFileAsync('tmux', ['send-keys', '-t', target, '--', text], { timeout: EXEC_TIMEOUT_MS })
    if (enter) {
      await execFileAsync('tmux', ['send-keys', '-t', target, 'Enter'], { timeout: EXEC_TIMEOUT_MS })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw controlError(`tmux send-keys failed: ${msg}`, 500)
  }

  return { ok: true }
}

export async function stopAgent(
  state: Map<string, Agent>,
  id: string,
  body: unknown,
): Promise<{ ok: true; scope: 'pane' | 'session'; target: string }> {
  const agent = getTmuxAgent(state, id)

  let scope: 'pane' | 'session' = 'session'
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const b = body as Record<string, unknown>
    if (b['scope'] !== undefined) {
      if (b['scope'] !== 'pane' && b['scope'] !== 'session') {
        throw controlError('scope must be "pane" or "session"', 400)
      }
      scope = b['scope'] as 'pane' | 'session'
    }
  }

  const paneTarget = agent.name
  // For session scope we need only the session name (everything before the first ':').
  const session = paneTarget.split(':')[0]!
  const tmuxTarget = scope === 'session' ? session : paneTarget

  try {
    if (scope === 'session') {
      await execFileAsync('tmux', ['kill-session', '-t', session], { timeout: EXEC_TIMEOUT_MS })
    } else {
      await execFileAsync('tmux', ['kill-pane', '-t', paneTarget], { timeout: EXEC_TIMEOUT_MS })
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    throw controlError(`tmux ${scope === 'session' ? 'kill-session' : 'kill-pane'} failed: ${msg}`, 500)
  }

  return { ok: true, scope, target: tmuxTarget }
}
