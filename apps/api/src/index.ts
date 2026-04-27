import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { state, nextLogEvent, nextToolCallEvent, nextToolResultEvent } from './demo.js'
import { startTmuxConnector } from './tmux.js'
import type { AgentEvent } from './types.js'

const HOST = '127.0.0.1'
const PORT = Number(process.env['PORT'] ?? 4000)
const ALLOWED_ORIGIN = process.env['ALLOWED_ORIGIN'] ?? 'http://localhost:3000'

// Active SSE clients.
const clients = new Set<ServerResponse>()

function broadcast(event: AgentEvent): void {
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const client of clients) {
    client.write(chunk)
  }
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Vary', 'Origin')
}

function json(res: ServerResponse, status: number, body: unknown): void {
  setCors(res)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { status: 'ok', agents: state.size, clients: clients.size })
}

function handleAgents(_req: IncomingMessage, res: ServerResponse): void {
  json(res, 200, { agents: [...state.values()] })
}

function handleAgent(_req: IncomingMessage, res: ServerResponse, id: string): void {
  const agent = state.get(id)
  if (!agent) { json(res, 404, { error: 'Agent not found' }); return }
  json(res, 200, { agent })
}

function handleEvents(req: IncomingMessage, res: ServerResponse): void {
  setCors(res)
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',  // disable nginx buffering if proxied
  })
  res.write(':\n\n')  // initial flush

  clients.add(res)

  // Replay current agent snapshot to this client immediately.
  for (const agent of state.values()) {
    res.write(`data: ${JSON.stringify({ type: 'agent:registered', agent })}\n\n`)
  }

  req.on('close', () => { clients.delete(res) })
}

function router(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'OPTIONS') {
    setCors(res)
    res.writeHead(204)
    res.end()
    return
  }

  const path = new URL(req.url ?? '/', 'http://localhost').pathname

  if (req.method === 'GET' && path === '/health') {
    handleHealth(req, res)
  } else if (req.method === 'GET' && path === '/api/agents') {
    handleAgents(req, res)
  } else if (req.method === 'GET' && path.startsWith('/api/agents/')) {
    handleAgent(req, res, path.slice('/api/agents/'.length))
  } else if (req.method === 'GET' && path === '/api/events') {
    handleEvents(req, res)
  } else {
    json(res, 404, { error: 'Not found' })
  }
}

function startDemoLoop(): void {
  // Emit a log entry every 2.5 s.
  setInterval(() => { broadcast(nextLogEvent()) }, 2500)
  // Emit a tool call and its result every 5 s (result follows 800 ms later).
  setInterval(() => {
    broadcast(nextToolCallEvent())
    setTimeout(() => { broadcast(nextToolResultEvent()) }, 800)
  }, 5000)
}

const server = createServer(router)

server.listen(PORT, HOST, () => {
  const connector = process.env['AGENTDECK_CONNECTOR']
  console.log(`AgentDeck API  →  http://${HOST}:${PORT}`)
  console.log('  GET /health       health check')
  console.log('  GET /api/agents   list agents (JSON)')
  console.log('  GET /api/events   SSE event stream')
  if (connector === 'tmux') {
    console.log('  Connector: tmux   (polls every 2 s, set AGENTDECK_CONNECTOR=tmux)')
    state.clear()
    startTmuxConnector(state, broadcast)
  } else {
    console.log('  Connector: demo   (synthetic events, set AGENTDECK_CONNECTOR=tmux for real data)')
    startDemoLoop()
  }
})

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Set PORT= to override.`)
    process.exit(1)
  }
  throw err
})
