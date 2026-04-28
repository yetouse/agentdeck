import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { state, nextLogEvent, nextToolCallEvent, nextToolResultEvent } from './demo.js'
import { startTmuxConnector } from './tmux.js'
import { launchClaude } from './launch.js'
import { sendAgentInput, stopAgent } from './control.js'
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
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

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 16_384) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(raw)) }
      catch { reject(Object.assign(new Error('Invalid JSON body'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

async function handleLaunch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status
      : 400
    const message = err instanceof Error ? err.message : 'Invalid JSON body'
    json(res, status, { error: message })
    return
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    json(res, 400, { error: 'Request body must be a JSON object' })
    return
  }

  const b = body as Record<string, unknown>
  try {
    const result = await launchClaude({
      task:    typeof b['task']    === 'string' ? b['task']    : '',
      name:    typeof b['name']    === 'string' ? b['name']    : undefined,
      cwd:     typeof b['cwd']     === 'string' ? b['cwd']     : undefined,
      command: typeof b['command'] === 'string' ? b['command'] : undefined,
    })
    json(res, 200, result)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status
      : 500
    const message = err instanceof Error ? err.message : 'Internal server error'
    json(res, status, { error: message })
  }
}

async function handleAgentInput(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status : 400
    json(res, status, { error: err instanceof Error ? err.message : 'Invalid request' })
    return
  }
  try {
    const result = await sendAgentInput(state, id, body)
    json(res, 200, result)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status : 500
    json(res, status, { error: err instanceof Error ? err.message : 'Internal server error' })
  }
}

async function handleAgentStop(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let body: unknown
  try {
    body = await readBody(req)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status : 400
    json(res, status, { error: err instanceof Error ? err.message : 'Invalid request' })
    return
  }
  try {
    const result = await stopAgent(state, id, body)
    json(res, 200, result)
  } catch (err: unknown) {
    const status = (err instanceof Error && typeof (err as Error & { status?: number }).status === 'number')
      ? (err as Error & { status: number }).status : 500
    json(res, status, { error: err instanceof Error ? err.message : 'Internal server error' })
  }
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
  } else if (req.method === 'POST' && path === '/api/agents/launch') {
    handleLaunch(req, res).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Internal server error'
      json(res, 500, { error: msg })
    })
  } else if (req.method === 'POST' && path.startsWith('/api/agents/') && path.endsWith('/input')) {
    const id = path.slice('/api/agents/'.length, -'/input'.length)
    handleAgentInput(req, res, id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Internal server error'
      json(res, 500, { error: msg })
    })
  } else if (req.method === 'POST' && path.startsWith('/api/agents/') && path.endsWith('/stop')) {
    const id = path.slice('/api/agents/'.length, -'/stop'.length)
    handleAgentStop(req, res, id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : 'Internal server error'
      json(res, 500, { error: msg })
    })
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
  console.log('  GET  /health                       health check')
  console.log('  GET  /api/agents                   list agents (JSON)')
  console.log('  GET  /api/events                   SSE event stream')
  console.log('  POST /api/agents/launch             launch a new Claude Code tmux session')
  console.log('  POST /api/agents/:id/input          send text to a tmux agent pane')
  console.log('  POST /api/agents/:id/stop           stop or kill a tmux agent session')
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
