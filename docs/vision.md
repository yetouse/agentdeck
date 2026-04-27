# AgentDeck — Vision

## The Problem

AI coding agents are no longer experimental. Tools like Claude Code, Devin, and OpenHands are running real tasks on real codebases — making commits, opening pull requests, executing shell commands, and modifying files on developer machines and CI systems.

But the developer experience of *supervising* these agents is still primitive:

- You watch terminal output scroll by, scanning for errors
- You have no unified view when running more than one agent at a time
- You can't easily compare what two agents did differently on the same task
- You lose full context when a session ends
- You have no visibility into token usage, cost, or tool call patterns across sessions

As agent workloads grow — from one agent per developer to many concurrent agents per project — the absence of an observation layer becomes a real bottleneck.

## The Solution

AgentDeck is a web-based cockpit that brings all of your AI coding agents into a single, structured view.

It is not a new agent. It is not an IDE plugin. It is an **observation and control plane** — the interface you keep open on a second monitor while your agents work.

## Core Principles

1. **Visibility first.** You should always know what your agents are doing right now, not only what they finished.
2. **Non-intrusive.** AgentDeck does not require agents to change how they work. Connectors adapt to agents, not the other way around.
3. **Open and composable.** The connector model is open. Anyone can write a connector for any agent framework.
4. **Lightweight.** No infrastructure required. A developer should be able to run AgentDeck locally in under 30 seconds.
5. **Local by default.** Your agent sessions and code context stay on your machine unless you explicitly opt in to sharing.

## Target Users

- Individual developers using AI coding tools daily who want situational awareness
- Engineering teams running parallel AI agent workloads on shared tasks
- Platform teams building internal AI developer tooling
- Researchers studying AI agent behavior, tool use, and cost patterns

## Milestones

### v0.1 — Foundation *(current)*
- Repository scaffold and monorepo structure
- Core TypeScript type definitions for agents, logs, and events
- Minimal web cockpit shell (Vite + TypeScript, no framework)
- Demo data seeding so the UI is immediately tangible

### v0.2 — Local Agent Watcher
- Claude Code connector: reads session logs from the local filesystem
- Local bridge daemon (Node.js) that watches connector output
- WebSocket channel from the bridge to the browser cockpit
- Live log streaming in the UI

### v0.3 — Dashboard MVP
- Agent card grid with live status indicators
- Log viewer with level and agent filtering
- Tool call inspector panel
- Token usage and estimated cost display per agent

### v0.4 — Multi-Agent Features
- Side-by-side agent task comparison
- Shared task board across agents
- Session replay (scrub through a completed session)

### v1.0 — Connector Ecosystem
- `@agentdeck/connector-sdk` — public interface for writing connectors
- OpenHands connector
- Devin connector (where the API allows)
- Connector registry and documentation

## What AgentDeck Is Not

- **Not an orchestrator.** AgentDeck does not tell agents what to do; it observes what they are doing. For orchestration, see LangGraph, CrewAI, or similar.
- **Not an IDE extension.** Although an IDE panel is a possible future surface, the primary interface is a standalone web app.
- **Not a cloud service.** AgentDeck is self-hosted first. A hosted offering may follow once the local experience is solid.
