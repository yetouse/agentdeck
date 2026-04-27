# AgentDeck — Architecture

## Overview

AgentDeck is a monorepo with a clear separation between the cockpit UI, the bridge server, and the connector layer.

```
┌──────────────────────────────────────────────────────────────┐
│                      Browser (apps/web)                      │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────┐ │
│  │ Agent Grid  │  │  Log Viewer  │  │ Tool Call Inspector │ │
│  └─────────────┘  └──────────────┘  └─────────────────────┘ │
│         ↑ WebSocket (AgentEvent stream)                      │
└─────────┼────────────────────────────────────────────────────┘
          │
┌─────────┼────────────────────────────────────────────────────┐
│         │         Bridge Server (apps/api — planned)         │
│                                                              │
│  ┌───────────────────────────────────────────────────────┐   │
│  │                  Connector Registry                   │   │
│  │                                                       │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │   │
│  │  │  Claude Code │  │  OpenHands   │  │    ...     │  │   │
│  │  │  Connector   │  │  Connector   │  │            │  │   │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │   │
│  └───────────────────────────────────────────────────────┘   │
│                    ↓ reads / subscribes                      │
└──────────────────────────────────────────────────────────────┘
                     │
           Agent Processes / APIs
```

## Packages

### `apps/web` — Cockpit UI

The browser-based cockpit. Built with Vite and TypeScript — no heavy UI framework. Communicates with the bridge server over WebSocket, with SSE as a fallback for read-only deployments.

Key responsibilities:
- Render the agent grid, log streams, and tool call details
- Manage local UI state (filters, selections, panel layout)
- Reconnect automatically when the bridge disconnects

### `apps/api` *(planned)*

A lightweight Node.js bridge server that:
- Maintains a registry of active connectors
- Normalizes agent events into the AgentDeck event schema
- Broadcasts events to connected browser clients via WebSocket
- Persists session data to a local SQLite database (no external service required)

Binds to `localhost` by default.

### `packages/connector-sdk` *(planned)*

TypeScript SDK for building connectors. Defines the `Connector` interface and the normalized event types that all connectors must emit. Connectors are plain Node.js processes or in-process modules — whatever fits the agent's runtime.

### `packages/connectors/*` *(planned)*

First-party connectors:

| Package | Agent |
|---|---|
| `@agentdeck/connector-claude-code` | Reads Claude Code session logs from `~/.claude/` |
| `@agentdeck/connector-openai-assistant` | Subscribes to OpenAI Assistant thread events |
| `@agentdeck/connector-openhands` | OpenHands event stream |

---

## Data Model

### `Agent`

Represents a running or historical agent session.

```typescript
interface Agent {
  id:         string        // unique session identifier
  name:       string        // display name (e.g. "claude-code/feature-branch")
  status:     AgentStatus   // idle | running | waiting | error | done
  task:       string        // current or last task description
  startedAt:  Date | null
  updatedAt:  Date
  logs:       LogEntry[]
  metrics:    AgentMetrics
}
```

### `LogEntry`

A single line of output from an agent.

```typescript
interface LogEntry {
  timestamp: Date
  level:     'info' | 'warn' | 'error' | 'debug'
  message:   string
  source?:   string   // e.g. the tool or module that produced the line
}
```

### `AgentMetrics`

Aggregate usage data for a session.

```typescript
interface AgentMetrics {
  tokensUsed:      number
  toolCallsCount:  number
  filesModified:   string[]
  durationMs:      number
}
```

### `AgentEvent` *(bridge layer)*

The normalized event type emitted by all connectors and broadcast to the UI. Typed as a discriminated union so every consumer can exhaustively handle all cases.

```typescript
type AgentEvent =
  | { type: 'agent:registered'; agent: Agent }
  | { type: 'agent:status';     agentId: string; status: AgentStatus }
  | { type: 'agent:log';        agentId: string; entry: LogEntry }
  | { type: 'tool:call';        agentId: string; tool: string; input: unknown }
  | { type: 'tool:result';      agentId: string; tool: string; output: unknown }
  | { type: 'session:end';      agentId: string; summary: SessionSummary }
```

---

## Real-Time Transport

**WebSocket** is the primary channel between the bridge server and the cockpit. It enables full-duplex communication (the UI can eventually send control commands back to agents).

**Server-Sent Events (SSE)** will be available as a fallback for environments with restrictive proxies or when the cockpit is deployed in a read-only mode.

The cockpit reconnects automatically with exponential backoff.

---

## State Management

The cockpit uses a minimal reactive store (no external state library). The store holds a `Map<string, Agent>` keyed by session ID and notifies subscribers synchronously on every mutation. This keeps the dependency footprint at zero runtime additions.

---

## Security Model

- The bridge server binds to `localhost` by default; remote access requires explicit configuration
- No agent credentials or secrets pass through AgentDeck; it observes but does not authenticate as the agent
- Persisted session data is stored locally and never sent to any external service
- The UI escapes all agent-produced strings before rendering to prevent XSS from malicious log output
