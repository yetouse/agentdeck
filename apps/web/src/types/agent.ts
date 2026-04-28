export type AgentStatus = 'idle' | 'running' | 'waiting' | 'error' | 'done'

export interface Agent {
  id: string
  name: string
  status: AgentStatus
  task: string
  startedAt: Date | null
  updatedAt: Date
  logs: LogEntry[]
  metrics: AgentMetrics
  topology?: Topology
}

export type TopologyNodeKind = 'agent' | 'workstream' | 'tool' | 'file' | 'event'

export interface TopologyNode {
  id: string
  label: string
  kind: TopologyNodeKind
  status: AgentStatus
  observed: boolean
  count?: number
  detail?: string
}

export interface TopologyEdge {
  from: string
  to: string
  label?: string
}

export interface Topology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  updatedAt: Date
}

export interface LogEntry {
  timestamp: Date
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
  endedAt: Date
  metrics: AgentMetrics
  outcome: 'success' | 'failure' | 'cancelled'
}

// Discriminated union for the bridge event stream (future apps/api)
export type AgentEvent =
  | { type: 'agent:registered'; agent: Agent }
  | { type: 'agent:status';     agentId: string; status: AgentStatus }
  | { type: 'agent:log';        agentId: string; entry: LogEntry }
  | { type: 'tool:call';        agentId: string; tool: string; input: unknown }
  | { type: 'tool:result';      agentId: string; tool: string; output: unknown }
  | { type: 'session:end';      agentId: string; summary: SessionSummary }
