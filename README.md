# AgentDeck

**A real-time web cockpit for supervising AI coding agents.**

AgentDeck gives engineering teams a unified dashboard to observe, manage, and coordinate AI coding agents — across tasks, sessions, and tools — from a single browser tab.

## Why AgentDeck?

AI coding agents are becoming a core part of the development workflow. But today each agent runs in isolation: you watch a terminal scroll, check a log file elsewhere, and lose track of concurrent sessions. AgentDeck brings all of your agents into one place.

## Features (planned)

- **Live agent feed** — real-time log streaming and status per agent
- **Task timeline** — visual history of what each agent did and when
- **Tool call inspector** — every invocation, its inputs, and outputs
- **Multi-agent view** — run and compare multiple agents side by side
- **Cost and token tracking** — usage metrics per agent, per session
- **Alerts** — be notified when an agent stalls, errors, or completes
- **Connector ecosystem** — plug in Claude Code, Devin, OpenHands, and more

## Quick Start

> **Prerequisites:** Node.js ≥ 20, npm ≥ 10

```bash
git clone https://github.com/yetouse/agentdeck.git
cd agentdeck
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without the local bridge, the web app runs with demo data.

To run the live demo bridge and the web cockpit together:

```bash
npm run dev:all
```

Or in two terminals:

```bash
npm run dev:api   # http://127.0.0.1:4000
npm run dev:web   # http://localhost:3000
```

The web app reads `VITE_AGENTDECK_API_URL` when you want to point it at another bridge URL. The API bridge binds to `127.0.0.1` by default.

## Local Bridge API

The first bridge implementation is intentionally lightweight: no database, no secrets, and localhost-only by default.

| Endpoint | Description |
|---|---|
| `GET /health` | Health check with agent/client counts |
| `GET /api/agents` | Current agent snapshots |
| `GET /api/agents/:id` | Single agent snapshot |
| `GET /api/events` | Server-Sent Events stream of normalized `AgentEvent` objects |
| `POST /api/agents/launch` | Launch a new Claude Code session in a detached tmux window |

### Launching a Claude Code session

`POST /api/agents/launch` starts a detached tmux session running `claude <task>` and returns the session coordinates. The new session appears automatically in the cockpit when the bridge runs in tmux connector mode.

```bash
curl -s -X POST http://127.0.0.1:4000/api/agents/launch \
  -H 'Content-Type: application/json' \
  -d '{"task":"Fix the failing tests in apps/api","name":"test-fixer","cwd":"/path/to/project"}'
```

**Request body** (JSON):

| Field | Type | Required | Description |
|---|---|---|---|
| `task` | string | yes | Task description passed to Claude as its initial prompt (max 2000 chars) |
| `name` | string | no | Display/session label — slugified for the tmux session name |
| `cwd` | string | no | Working directory; defaults to the bridge process's `cwd`. Rejected if it does not exist. |

**Response** (200 OK):

```json
{
  "sessionName": "agentdeck-test-fixer-abc123",
  "target": "agentdeck-test-fixer-abc123:0.0",
  "commandSummary": "claude 'Fix the failing tests in apps/api'",
  "cwd": "/path/to/project",
  "message": "Claude session launched as tmux session \"agentdeck-test-fixer-abc123\". Attach with: tmux attach -t agentdeck-test-fixer-abc123",
  "warning": "AGENTDECK_CONNECTOR=tmux is not set — restart the bridge with that variable to observe this session automatically."
}
```

Error responses: `400` for invalid input, `403` if the local-only smoke-test command override is disabled, `503` if tmux is not installed, `500` for unexpected errors.

> **Safety note:** The endpoint binds to `127.0.0.1` and is intended for local development only. Do not expose it to a network without adding authentication. The undocumented `command` request field is reserved for smoke tests and is ignored unless `AGENTDECK_ALLOW_COMMAND_OVERRIDE=1` is set.

## Connectors

AgentDeck selects a data source via the `AGENTDECK_CONNECTOR` environment variable.

### Demo (default)

No configuration needed. The bridge generates synthetic Claude Code-style events so the UI is always usable without any external tools.

### tmux

Observe real tmux sessions as agents in the cockpit. Each tmux pane becomes one agent card.

```bash
# Start the bridge in tmux mode
AGENTDECK_CONNECTOR=tmux npm run dev:api

# Open the cockpit in a second terminal
npm run dev:web
```

Or in a single command:

```bash
AGENTDECK_CONNECTOR=tmux npm run dev:all
```

**What the tmux connector does:**

- Calls `tmux list-panes -a` every 2 s and registers one agent per pane
- Captures pane output with `tmux capture-pane` and streams new lines as `agent:log` events — no duplicates
- Assigns stable, URL-safe IDs: `tmux:<session>:<window>.<pane>` (e.g. `tmux:main:0.1`)
- Maps shell panes (bash / zsh / fish / …) to `idle` status; active processes (claude / npm / node / …) to `running`
- Marks panes that close as `done`
- Surfaces a helpful `idle` or `error` agent if tmux has no sessions or is not installed

**Example — observe Claude Code in a tmux session:**

```bash
# Terminal 1: start a tmux session and run Claude Code inside it
tmux new-session -s dev
claude

# Terminal 2: start the bridge and cockpit
AGENTDECK_CONNECTOR=tmux npm run dev:all
```

Open [http://localhost:3000](http://localhost:3000) to see your tmux panes as live agent cards.

> **Prerequisite:** tmux ≥ 2.6 must be installed and at least one session must be running.

## Repository Structure

```
agentdeck/
├── apps/
│   ├── api/            # Local bridge server (Node.js + TypeScript + SSE)
│   └── web/            # Browser cockpit (Vite + TypeScript, no framework)
├── packages/           # Shared libraries — connectors, SDK, types (planned)
├── docs/
│   ├── vision.md       # Product vision and roadmap
│   └── architecture.md # System design
├── package.json        # Workspace root
└── LICENSE
```

## Documentation

- [Vision and Roadmap](docs/vision.md)
- [Architecture](docs/architecture.md)

## Contributing

Contributions are welcome. Open an issue first to discuss significant changes. A `CONTRIBUTING.md` is coming.

## License

MIT © 2026 [Yannick CAISE](https://github.com/yetouse)
