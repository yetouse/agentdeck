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
│         ↑ SSE (AgentEvent stream)                            │
└─────────┼────────────────────────────────────────────────────┘
          │
┌─────────┼────────────────────────────────────────────────────┐
│         │         Bridge Server (apps/api)                   │
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

The browser-based cockpit. Built with Vite and TypeScript — no heavy UI framework. It loads initial agent snapshots from the local bridge (`GET /api/agents`) and subscribes to live updates over Server-Sent Events (`GET /api/events`). When the bridge is unavailable, it falls back to demo data so the UI remains usable.

Key responsibilities:
- Render the agent grid, log streams, and tool call details
- Manage local UI state (filters, selections, panel layout)
- Reconnect automatically when the bridge disconnects

### `apps/api` — Local Bridge

A lightweight Node.js bridge server that currently:
- Serves `GET /health`, `GET /api/agents`, `GET /api/agents/:id`
- Broadcasts normalized `AgentEvent` objects over `GET /api/events` using SSE
- Replays the current agent snapshot to each newly connected browser
- Ships with a demo event generator that simulates Claude Code logs and tool calls

It binds to `127.0.0.1` by default and keeps all state in memory for the initial MVP. SQLite persistence and additional first-party connectors are planned next.

**Control-plane endpoint — `POST /api/agents/launch`**

Accepts a JSON body with `task` (required, ≤ 2 000 chars), `name` (optional display label), and `cwd` (optional working directory). It:

1. Validates the request and resolves `cwd` via `fs.stat` — rejects non-existent paths with `400`.
2. Confirms tmux is available (`tmux -V`) — returns `503` if missing.
3. Derives a stable session name: `agentdeck-<slug>-<base36-timestamp>`.
4. Runs `tmux new-session -d -s <name> -c <cwd> "claude '<task>'"` via `execFile` (no shell injection path for the outer args; the task string is single-quoted inside the shell command).
5. Returns JSON with `sessionName`, `target`, `commandSummary`, `cwd`, `message`, and an optional `warning` when `AGENTDECK_CONNECTOR=tmux` is not set.

The new tmux session is automatically discovered on the connector's next 2-second poll when the bridge runs with `AGENTDECK_CONNECTOR=tmux`. Sessions can also be launched while the demo connector is active — they will appear the next time the bridge is restarted in tmux mode.

**Connector selection** is opt-in via the `AGENTDECK_CONNECTOR` environment variable:

| Value | Connector | Source |
|---|---|---|
| *(unset)* | `demo` | Synthetic Claude Code-style events (default) |
| `tmux` | `apps/api/src/tmux.ts` | Live tmux panes via `tmux list-panes` + `tmux capture-pane` |

In tmux mode the bridge polls `tmux list-panes -a` every 2 s. Each pane becomes one `Agent`. New output lines from `tmux capture-pane -p -S -` are emitted as `agent:log` events; already-seen lines are never re-emitted. Panes that disappear receive a final `agent:status` event with `status: 'done'`. If tmux is unavailable or has no sessions, the bridge registers a single informational agent instead of crashing.

### `packages/connector-sdk` *(planned)*

TypeScript SDK for building connectors. Defines the `Connector` interface and the normalized event types that all connectors must emit. Connectors are plain Node.js processes or in-process modules — whatever fits the agent's runtime.

### `packages/connectors/*` *(planned)*

First-party connectors:

| Package | Agent |
|---|---|
| `@agentdeck/connector-claude-code` | Reads Claude Code session logs from `~/.claude/` |
| `@agentdeck/connector-openai-assistant` | Subscribes to OpenAI Assistant thread events |
| `@agentdeck/connector-openhands` | OpenHands event stream |

The built-in tmux connector (`apps/api/src/tmux.ts`) ships inside the bridge itself and requires no extra package. It uses only Node.js built-ins (`child_process`, `util`) and the `tmux` CLI.

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

**Server-Sent Events (SSE)** is the current transport between the bridge server and the cockpit. It is a good fit for the MVP because the cockpit only needs a read-only stream of normalized `AgentEvent` objects from the local bridge.

**WebSocket** may be added later when the UI needs full-duplex control commands, for example to pause, resume, or send input to an agent process.

The cockpit reconnects automatically when the SSE connection drops.

---

## State Management

The cockpit uses a minimal reactive store (no external state library). The store holds a `Map<string, Agent>` keyed by session ID and notifies subscribers synchronously on every mutation. This keeps the dependency footprint at zero runtime additions.

---

## Security Model

- The bridge server binds to `localhost` by default; remote access requires explicit configuration
- No agent credentials or secrets pass through AgentDeck; it observes but does not authenticate as the agent
- Persisted session data is stored locally and never sent to any external service
- The UI escapes all agent-produced strings before rendering to prevent XSS from malicious log output
- `POST /api/agents/launch` uses `execFile` (not `exec`) so outer tmux arguments are never interpreted by a shell; user-supplied task text is single-quoted for the inner shell command. The `cwd` field is validated via `fs.stat` before use. The local smoke-test `command` override is rejected unless `AGENTDECK_ALLOW_COMMAND_OVERRIDE=1` is explicitly set. Authentication is not yet implemented — the localhost-only binding is the current trust boundary.
