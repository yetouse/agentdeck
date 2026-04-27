// All date fields use ISO 8601 strings for JSON serializability.

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'done'

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  task: string
  startedAt: string | null
  updatedAt: string
  logs: LogEntry[]
  metrics: AgentMetrics
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error' | 'debug'
  message: string
  source?: string
}

export interface AgentMetrics {
  tokensUsed: number
  toolCallsCount: number
  filesModified: string[]
  durationMs: number
}

export interface SessionSummary {
  agentId: string
  endedAt: string
  metrics: AgentMetrics
  outcome: 'success' | 'failure' | 'cancelled'
}

export type AgentEvent =
  | { type: 'agent:registered'; agent: Agent }
  | { type: 'agent:status';     agentId: string; status: AgentStatus }
  | { type: 'agent:log';        agentId: string; entry: LogEntry }
  | { type: 'tool:call';        agentId: string; tool: string; input: unknown }
  | { type: 'tool:result';      agentId: string; tool: string; output: unknown }
  | { type: 'session:end';      agentId: string; summary: SessionSummary }
