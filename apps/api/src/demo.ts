import type { Agent, AgentEvent, LogEntry } from './types.js'

const START_MS = Date.now() - 18 * 60 * 1000

function iso(ms?: number): string {
  return new Date(ms ?? Date.now()).toISOString()
}

// In-memory agent state — snapshot sent to each new SSE client.
export const state = new Map<string, Agent>([
  [
    'claude-dev',
    {
      id: 'claude-dev',
      name: 'Claude Dev',
      status: 'running',
      task: 'Implement the API bridge under apps/api',
      startedAt: iso(START_MS),
      updatedAt: iso(),
      logs: [],
      metrics: {
        tokensUsed: 18420,
        toolCallsCount: 27,
        filesModified: [
          'apps/api/src/index.ts',
          'apps/api/src/types.ts',
          'apps/api/src/demo.ts',
        ],
        durationMs: 18 * 60 * 1000,
      },
    },
  ],
  [
    'reviewer',
    {
      id: 'reviewer',
      name: 'Review Agent',
      status: 'waiting',
      task: 'Waiting for the next diff to review',
      startedAt: null,
      updatedAt: iso(),
      logs: [],
      metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
    },
  ],
  [
    'tests',
    {
      id: 'tests',
      name: 'Test Runner',
      status: 'done',
      task: 'Run typecheck and smoke tests — 0 errors',
      startedAt: iso(START_MS),
      updatedAt: iso(),
      logs: [],
      metrics: {
        tokensUsed: 1420,
        toolCallsCount: 5,
        filesModified: [],
        durationMs: 18 * 60 * 1000,
      },
    },
  ],
])

const LOG_SCRIPT: ReadonlyArray<Omit<LogEntry, 'timestamp'>> = [
  { level: 'info',  message: 'Reading apps/api/src/index.ts',              source: 'tool:Read'  },
  { level: 'info',  message: 'Planning SSE event router',                  source: 'claude-dev' },
  { level: 'info',  message: 'Writing HTTP router',                        source: 'tool:Write' },
  { level: 'debug', message: 'Compiled types to dist/',                    source: 'tsc'        },
  { level: 'info',  message: 'Broadcasting agent:registered to client(s)', source: 'bridge'     },
  { level: 'warn',  message: 'noUnusedLocals: variable declared but not read', source: 'tsc'   },
  { level: 'info',  message: 'Fixed unused variable in demo.ts',           source: 'tool:Edit'  },
  { level: 'info',  message: 'npm run typecheck — 0 errors',               source: 'tool:Bash'  },
  { level: 'info',  message: 'Updated docs/architecture.md',               source: 'tool:Write' },
  { level: 'debug', message: 'SSE heartbeat sent to 1 client(s)',          source: 'bridge'     },
]

const TOOL_SCRIPT: ReadonlyArray<{ tool: string; input: unknown; output: unknown }> = [
  { tool: 'Read',  input: { file_path: 'apps/api/src/types.ts' },              output: { lines: 42    } },
  { tool: 'Write', input: { file_path: 'apps/api/src/index.ts' },              output: { bytes: 2048  } },
  { tool: 'Bash',  input: { command: 'npm run typecheck --workspace=apps/api' }, output: { exitCode: 0 } },
  { tool: 'Edit',  input: { file_path: 'apps/api/src/demo.ts' },               output: { success: true } },
  { tool: 'Glob',  input: { pattern: 'apps/api/src/**/*.ts' },                 output: { count: 3     } },
]

let logCursor = 0
let toolCursor = 0

export function nextLogEvent(): AgentEvent {
  const template = LOG_SCRIPT[logCursor % LOG_SCRIPT.length]
  logCursor++

  const agent = state.get('claude-dev')!
  agent.metrics.tokensUsed += Math.floor(Math.random() * 180 + 40)
  agent.metrics.toolCallsCount++
  agent.updatedAt = iso()

  return { type: 'agent:log', agentId: 'claude-dev', entry: { ...template, timestamp: iso() } }
}

export function nextToolCallEvent(): AgentEvent {
  const t = TOOL_SCRIPT[toolCursor % TOOL_SCRIPT.length]
  return { type: 'tool:call', agentId: 'claude-dev', tool: t.tool, input: t.input }
}

export function nextToolResultEvent(): AgentEvent {
  const t = TOOL_SCRIPT[toolCursor % TOOL_SCRIPT.length]
  toolCursor++
  return { type: 'tool:result', agentId: 'claude-dev', tool: t.tool, output: t.output }
}
