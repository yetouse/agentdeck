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
