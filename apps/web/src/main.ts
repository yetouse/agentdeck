import './styles.css'
import type { Agent, AgentStatus, LogEntry, Topology, TopologyEdge, TopologyNode } from './types/agent'

// ── Config ───────────────────────────────────────────────────────────────────

const API_BASE = import.meta.env.VITE_AGENTDECK_API_URL ?? ''
const CONNECT_RETRY_MS = 15_000
const SSE_RETRY_MS = 10_000
const CLOCK_RENDER_MS = 15_000

// ── State ────────────────────────────────────────────────────────────────────

type LogStreamEntry = { agentId: string; agentName: string; entry: LogEntry }
type TabId = 'topology' | 'activity' | 'files' | 'control'
type DashboardView = 'now' | 'system' | 'history'
type Locale = 'fr' | 'en'

const translations: Record<Locale, Record<string, string>> = {
  fr: {
    'topbar.language': 'Langue',
    'hero.eyebrow': 'Cockpit local d’opérations IA',
    'hero.title': 'Supervision des agents',
    'hero.subtitle': 'Surveiller, orienter et coordonner les agents de code IA en temps réel',
    'hero.active': 'Actifs',
    'hero.system': 'Système',
    'hero.signals': 'Signaux',
    'panel.agents': 'Agents',
    'nav.now': 'Maintenant',
    'nav.system': 'Système',
    'nav.history': 'Historique',
    'stream.listening': 'écoute',
    'status.live': '● direct',
    'status.reconnecting': '● reconnexion…',
    'status.demo': '○ démo',
    'status.waiting': 'en attente',
    'status.error': 'erreur',
    'status.errors': 'erreurs',
    'empty.now': 'Aucun travail projet actif pour l’instant. Demande à Hermès de continuer pour alimenter cette vue.',
    'empty.system': 'Aucun processus système enregistré.',
    'empty.history': 'Aucun agent inactif ou terminé pour l’instant.',
    'card.openDetails': 'Ouvrir le détail de',
    'card.modifiedFile': 'fichier modifié',
    'card.modifiedFiles': 'fichiers modifiés',
    'card.liveTrail': 'Fil direct',
    'metric.tokens': 'Tokens',
    'metric.tools': 'Outils',
    'metric.files': 'Fichiers',
    'control.inputPlaceholder': 'Envoyer une instruction à l’agent…',
    'control.enter': 'Entrée',
    'control.send': 'Envoyer',
    'control.stop': 'Stop',
    'pressure.unknown': 'Pression inconnue',
    'pressure.offline': 'hors ligne',
    'pressure.telemetryMissing': 'La télémétrie locale du throttle n’est pas encore disponible.',
    'pressure.paused': 'Lancements en pause',
    'pressure.cooldown': 'Cooldown actif',
    'pressure.prefix': 'Pression',
    'pressure.launches': 'Lancements 1h',
    'pressure.waits': 'Attentes',
    'pressure.caps': 'Caps appliqués',
    'pressure.cooldownMetric': 'Cooldown',
    'pressure.none': 'Aucun lancement récent observé.',
    'pressure.updated': 'Mis à jour',
    'pressure.source': 'source locale sanitisée',
    'claude.controlUnavailable': 'Contrôle Claude Code indisponible.',
    'claude.mode': 'Mode',
    'claude.pauseMin': 'pause min.',
    'claude.launchesSuspended': 'lancements suspendus',
    'claude.launchesAllowed': 'lancements autorisés',
    'claude.resume': 'Reprendre',
    'claude.pauseAi': 'Pause IA',
    'claude.auditLabel': 'Derniers changements Claude Code',
    'claude.rateLimitNote': '429 = limite fournisseur atteinte. AgentDeck ne relance pas : on attend la fenêtre suivante, avec mode Économie/Strict si besoin.',
    'runtime.unknown': 'fenêtre inconnue',
    'runtime.paused': 'pause active',
    'runtime.nextWindow': 'prochaine fenêtre dans',
    'runtime.ready': 'prêt maintenant',
    'runtime.noLastStart': 'dernier lancement non observé',
    'runtime.allowedAt': 'autorisé à',
    'runtime.openSince': 'fenêtre ouverte depuis',
    'pressure.calm': 'calme',
    'pressure.elevated': 'élevée',
    'pressure.high': 'haute',
    'activity.now': 'Activité maintenant',
    'activity.waiting': 'En attente d’un signal frais — demande à Hermès de continuer et l’activité apparaîtra ici.',
    'activity.recentSignal': 'signal récent',
    'activity.recentSignals': 'signaux récents',
    'activity.openHint': 'ouvrir un agent pour le flux complet',
    'event.waiting': 'En attente du premier signal…',
    'topology.title': 'Topologie de l’agent',
    'topology.node': 'nœud',
    'topology.nodes': 'nœuds',
    'topology.link': 'lien',
    'topology.links': 'liens',
    'topology.refreshed': 'rafraîchi',
    'topology.waiting': 'En attente d’activité Hermès…',
    'topology.observed': 'observé',
    'topology.inferred': 'inféré',
    'topology.graphLabel': 'Graphe de topologie agent',
    'topology.placeholder': 'La topologie apparaîtra dès qu’Hermès émettra une activité outil.',
    'topology.agent': 'Agent',
    'topology.workstreams': 'Flux de travail',
    'topology.observedTier': 'Outils · Fichiers · Événements',
    'topology.noWorkstreams': 'Aucun flux inféré pour l’instant.',
    'topology.noObserved': 'Aucune activité observée pour l’instant.',
    'topology.live': 'ACTIF',
    'topology.idle': 'INACTIF',
    'topology.awaitingActivity': 'En attente d’activité',
    'topology.signals': 'signaux',
    'topology.signal': 'signal',
    'topology.standingBy': 'En veille',
    'topology.idleActivity': 'Inactif',
    'topology.touched': 'Touché',
    'topology.awaiting': 'En attente',
    'activity.title': 'Flux d’événements',
    'activity.scope': 'Périmètre',
    'activity.thisAgent': 'Cet agent',
    'activity.allAgents': 'Tous les agents',
    'activity.noEvents': 'Aucun événement capturé pour l’instant.',
    'files.title': 'Fichiers modifiés',
    'files.touched': 'touché(s) dans cette session.',
    'files.none': 'Aucun fichier modifié pour l’instant.',
    'control.title': 'Contrôle',
    'control.help': 'Envoyer des instructions ou terminer la session tmux.',
    'control.sendEnter': 'Envoyer Entrée',
    'control.stopSession': 'Arrêter la session',
    'control.inactive': 'Cette session n’est plus active.',
    'tabs.label': 'Sections de l’inspecteur agent',
    'inspector.eyebrow': 'Inspecteur agent',
    'inspector.live': 'ACTIF',
    'inspector.lastUpdate': 'mise à jour',
    'inspector.close': 'Fermer le détail agent',
    'inspector.duration': 'Durée',
    'inspector.updated': 'Actualisé',
    'inspector.toolCalls': 'Appels outils',
    'inspector.mode': 'Mode',
    'time.justNow': 'à l’instant',
    'time.secondsAgo': 'il y a {n}s',
    'time.minutesAgo': 'il y a {n}min',
    'time.hoursAgo': 'il y a {n}h',
    'tab.topology': 'Topologie',
    'tab.activity': 'Flux',
    'tab.files': 'Fichiers',
    'tab.control': 'Contrôle',
  },
  en: {
    'topbar.language': 'Language',
    'hero.eyebrow': 'Local AI operations deck',
    'hero.title': 'Agent supervision',
    'hero.subtitle': 'Monitor, direct, and coordinate your AI coding agents in real time',
    'hero.active': 'Active',
    'hero.system': 'System',
    'hero.signals': 'Signals',
    'panel.agents': 'Agents',
    'nav.now': 'Now',
    'nav.system': 'System',
    'nav.history': 'History',
    'stream.listening': 'listening',
    'status.live': '● live',
    'status.reconnecting': '● reconnecting…',
    'status.demo': '○ demo',
    'status.waiting': 'waiting',
    'status.error': 'error',
    'status.errors': 'errors',
    'empty.now': 'No active project work right now. Ask Hermes to continue development to populate this view.',
    'empty.system': 'No system processes registered.',
    'empty.history': 'No idle or completed agents yet.',
    'card.openDetails': 'Open details for',
    'card.modifiedFile': 'modified file',
    'card.modifiedFiles': 'modified files',
    'card.liveTrail': 'Live trail',
    'metric.tokens': 'Tokens',
    'metric.tools': 'Tools',
    'metric.files': 'Files',
    'control.inputPlaceholder': 'Send input to agent…',
    'control.enter': 'Enter',
    'control.send': 'Send',
    'control.stop': 'Stop',
    'pressure.unknown': 'Unknown pressure',
    'pressure.offline': 'offline',
    'pressure.telemetryMissing': 'Local throttle telemetry is not available yet.',
    'pressure.paused': 'Launches paused',
    'pressure.cooldown': 'Cooldown active',
    'pressure.prefix': 'Pressure',
    'pressure.launches': 'Launches 1h',
    'pressure.waits': 'Waits',
    'pressure.caps': 'Caps applied',
    'pressure.cooldownMetric': 'Cooldown',
    'pressure.none': 'No recent launch observed.',
    'pressure.updated': 'Updated',
    'pressure.source': 'sanitized local source',
    'claude.controlUnavailable': 'Claude Code control unavailable.',
    'claude.mode': 'Mode',
    'claude.pauseMin': 'min. pause',
    'claude.launchesSuspended': 'launches suspended',
    'claude.launchesAllowed': 'launches allowed',
    'claude.resume': 'Resume',
    'claude.pauseAi': 'Pause AI',
    'claude.auditLabel': 'Latest Claude Code changes',
    'claude.rateLimitNote': '429 = provider usage limit reached. AgentDeck does not retry: wait for the next window, with Economy/Strict mode if needed.',
    'runtime.unknown': 'unknown window',
    'runtime.paused': 'pause active',
    'runtime.nextWindow': 'next window in',
    'runtime.ready': 'ready now',
    'runtime.noLastStart': 'last launch not observed',
    'runtime.allowedAt': 'allowed at',
    'runtime.openSince': 'window open since',
    'pressure.calm': 'calm',
    'pressure.elevated': 'elevated',
    'pressure.high': 'high',
    'activity.now': 'Activity Now',
    'activity.waiting': 'Waiting for a fresh signal — ask Hermes to continue and live activity will appear here.',
    'activity.recentSignal': 'recent signal',
    'activity.recentSignals': 'recent signals',
    'activity.openHint': 'open an agent for the full event stream',
    'event.waiting': 'Waiting for the first signal…',
    'topology.title': 'Agent topology',
    'topology.node': 'node',
    'topology.nodes': 'nodes',
    'topology.link': 'link',
    'topology.links': 'links',
    'topology.refreshed': 'refreshed',
    'topology.waiting': 'Waiting for activity from Hermes…',
    'topology.observed': 'observed',
    'topology.inferred': 'inferred',
    'topology.graphLabel': 'Agent topology graph',
    'topology.placeholder': 'Topology will appear once Hermes emits tool activity.',
    'topology.agent': 'Agent',
    'topology.workstreams': 'Workstreams',
    'topology.observedTier': 'Tools · Files · Events',
    'topology.noWorkstreams': 'No inferred workstreams yet.',
    'topology.noObserved': 'No observed activity yet.',
    'topology.live': 'LIVE',
    'topology.idle': 'IDLE',
    'topology.awaitingActivity': 'Awaiting activity',
    'topology.signals': 'signals',
    'topology.signal': 'signal',
    'topology.standingBy': 'Standing by',
    'topology.idleActivity': 'Idle',
    'topology.touched': 'Touched',
    'topology.awaiting': 'Awaiting',
    'activity.title': 'Event stream',
    'activity.scope': 'Scope',
    'activity.thisAgent': 'This agent',
    'activity.allAgents': 'All agents',
    'activity.noEvents': 'No events captured yet.',
    'files.title': 'Modified files',
    'files.touched': 'touched in this session.',
    'files.none': 'No files modified yet.',
    'control.title': 'Control',
    'control.help': 'Send instructions or terminate the tmux session.',
    'control.sendEnter': 'Send Enter',
    'control.stopSession': 'Stop session',
    'control.inactive': 'This session is no longer active.',
    'tabs.label': 'Agent inspector sections',
    'inspector.eyebrow': 'Agent inspector',
    'inspector.live': 'LIVE',
    'inspector.lastUpdate': 'last update',
    'inspector.close': 'Close agent detail',
    'inspector.duration': 'Duration',
    'inspector.updated': 'Updated',
    'inspector.toolCalls': 'Tool calls',
    'inspector.mode': 'Mode',
    'time.justNow': 'just now',
    'time.secondsAgo': '{n}s ago',
    'time.minutesAgo': '{n}m ago',
    'time.hoursAgo': '{n}h ago',
    'tab.topology': 'Topology',
    'tab.activity': 'Event Stream',
    'tab.files': 'Files',
    'tab.control': 'Control',
  },
}

let locale: Locale = loadLocale()

function loadLocale(): Locale {
  return localStorage.getItem('agentdeck-locale') === 'en' ? 'en' : 'fr'
}

function setLocale(next: Locale): void {
  locale = next
  localStorage.setItem('agentdeck-locale', next)
  document.documentElement.lang = next
  render()
}

function tr(key: string): string {
  return translations[locale][key] ?? translations.en[key] ?? key
}

function trn(key: string, n: number): string {
  return tr(key).replace('{n}', String(n))
}

let agents: Agent[] = []
let liveLogs: LogStreamEntry[] = []
let claudeTelemetry: ClaudeTelemetry | null = null
let claudeControl: ClaudeControl | null = null
let buildInfo: BuildInfo = { name: 'AgentDeck', version: '0.2.0', commit: null, label: 'v0.2.0' }
let mode: 'live' | 'demo' | 'reconnecting' = 'demo'
let selectedAgentId: string | null = null
let selectedTab: TabId = 'topology'
let activityScope: 'this' | 'all' = 'this'
let dashboardView: DashboardView = 'now'

// ── Wire types (ISO strings from JSON) ───────────────────────────────────────

interface WireLogEntry {
  timestamp: string
  level: LogEntry['level']
  message: string
  source?: string
}

interface WireTopology {
  nodes: TopologyNode[]
  edges: TopologyEdge[]
  updatedAt: string
}

interface WireAgent {
  id: string
  name: string
  status: AgentStatus
  task: string
  startedAt: string | null
  updatedAt: string
  logs: WireLogEntry[]
  metrics: { tokensUsed: number; toolCallsCount: number; filesModified: string[]; durationMs: number }
  topology?: WireTopology
}

interface BuildInfo {
  name: 'AgentDeck'
  version: string
  commit: string | null
  label: string
}

interface ClaudeTelemetryEvent {
  timestamp: string
  type: 'start' | 'wait' | 'blocked'
  printMode?: boolean
  cap?: number
  cappedOrAdded?: boolean
  argc?: number
  waitSeconds?: number
  reason?: string
  mode?: string
}

interface ClaudeTelemetry {
  source: string
  updatedAt: string
  launches1h: number
  waits1h: number
  capped1h: number
  totalWaitSeconds1h: number
  pressure: 'calm' | 'elevated' | 'high'
  recentEvents: ClaudeTelemetryEvent[]
}

interface ClaudeRuntime {
  status: 'ready' | 'cooling' | 'paused'
  lastStartAt: string | null
  nextAllowedAt: string | null
  cooldownRemainingSeconds: number
}

interface ClaudeControlAuditEntry {
  timestamp: string
  mode: 'normal' | 'economy' | 'strict'
  paused: boolean
  maxTurnsCap: number
  minStartIntervalSeconds: number
  changes: Array<'mode' | 'paused'>
}

interface ClaudeControl {
  mode: 'normal' | 'economy' | 'strict'
  paused: boolean
  maxTurnsCap: number
  minStartIntervalSeconds: number
  updatedAt: string
  runtime?: ClaudeRuntime
  audit?: ClaudeControlAuditEntry[]
}

type WireEvent =
  | { type: 'agent:registered'; agent: WireAgent }
  | { type: 'agent:status';     agentId: string; status: AgentStatus }
  | { type: 'agent:log';        agentId: string; entry: WireLogEntry }
  | { type: 'tool:call';        agentId: string; tool: string; input: unknown }
  | { type: 'tool:result';      agentId: string; tool: string; output: unknown }
  | { type: 'session:end';      agentId: string; summary: { outcome: string } }

// ── Conversion ───────────────────────────────────────────────────────────────

function fromWireEntry(w: WireLogEntry): LogEntry {
  return { ...w, timestamp: new Date(w.timestamp) }
}

function fromWireTopology(w: WireTopology): Topology {
  return {
    nodes: w.nodes,
    edges: w.edges,
    updatedAt: new Date(w.updatedAt),
  }
}

function fromWireAgent(w: WireAgent): Agent {
  return {
    ...w,
    startedAt: w.startedAt ? new Date(w.startedAt) : null,
    updatedAt: new Date(w.updatedAt),
    logs: w.logs.map(fromWireEntry),
    topology: w.topology ? fromWireTopology(w.topology) : undefined,
  }
}

// ── Bridge ───────────────────────────────────────────────────────────────────

function isBuildInfo(value: unknown): value is BuildInfo {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<BuildInfo>
  return candidate.name === 'AgentDeck'
    && typeof candidate.version === 'string'
    && (typeof candidate.commit === 'string' || candidate.commit === null)
    && typeof candidate.label === 'string'
}

async function fetchBuildInfo(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/meta`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { build?: unknown }
    if (!isBuildInfo(data.build)) throw new Error('Invalid build metadata')
    buildInfo = data.build
  } catch {
    buildInfo = { name: 'AgentDeck', version: '0.2.0', commit: null, label: 'v0.2.0' }
  }
  renderBuildInfo()
}

async function fetchClaudeTelemetry(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/claude/telemetry`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { telemetry: ClaudeTelemetry }
    claudeTelemetry = data.telemetry
  } catch {
    claudeTelemetry = null
  }
}

async function fetchClaudeControl(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/claude/control`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { control: ClaudeControl }
    claudeControl = data.control
  } catch {
    claudeControl = null
  }
}

async function updateClaudeControl(patch: Partial<Pick<ClaudeControl, 'mode' | 'paused'>>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/claude/control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json() as { control: ClaudeControl }
  claudeControl = data.control
}

async function connect(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/agents`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as { agents: WireAgent[] }
    agents = data.agents.map(fromWireAgent)
    await Promise.all([fetchBuildInfo(), fetchClaudeTelemetry(), fetchClaudeControl()])
    liveLogs = []
    mode = 'live'
    render()
    listenSSE()
  } catch {
    if (mode !== 'demo') {
      agents = makeDemoAgents()
      mode = 'demo'
      render()
    }
    setTimeout(connect, CONNECT_RETRY_MS)
  }
}

function listenSSE(): void {
  const es = new EventSource(`${API_BASE}/api/events`)

  es.onmessage = (e: MessageEvent<string>) => {
    const ev = JSON.parse(e.data) as WireEvent
    applyEvent(ev)
    render()
  }

  es.onerror = () => {
    es.close()
    mode = 'reconnecting'
    render()
    setTimeout(connect, SSE_RETRY_MS)
  }
}

function pushLog(agentId: string, agentName: string, entry: LogEntry): void {
  liveLogs.push({ agentId, agentName, entry })
  if (liveLogs.length > 500) liveLogs = liveLogs.slice(-500)
}

function logSignature(agentId: string, entry: LogEntry): string {
  return `${agentId}|${entry.timestamp.getTime()}|${entry.level}|${entry.message}`
}

function redactPreviewText(raw: string): string {
  return raw
    .replace(/(?:Bearer|Authorization|api[_-]?key|password|passwd|secret|token)\s*[=:]\s*\S+/gi, '[REDACTED]')
    .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/\b(?:sk|ghp|gho|ghu|ghs|ghr)-[A-Za-z0-9_-]{10,}/g, '[REDACTED]')
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[REDACTED]')
}

function safeJSONPreview(value: unknown, max = 160): string {
  let s: string
  try { s = JSON.stringify(value) ?? '' }
  catch { return '[unserializable]' }
  s = redactPreviewText(s)
  if (s.length <= max) return s
  return s.slice(0, Math.max(1, max - 1)) + '…'
}

function applyEvent(ev: WireEvent): void {
  switch (ev.type) {
    case 'agent:registered': {
      const agent = fromWireAgent(ev.agent)
      const i = agents.findIndex(a => a.id === agent.id)
      const prevSigs = i >= 0
        ? new Set(agents[i]!.logs.map(e => logSignature(agent.id, e)))
        : new Set<string>()
      if (i >= 0) agents[i] = agent
      else agents.push(agent)
      // Hermes broadcasts updated snapshots rather than per-line agent:log events,
      // so diff against the previous snapshot and surface new entries in liveLogs.
      for (const entry of agent.logs) {
        if (!prevSigs.has(logSignature(agent.id, entry))) {
          pushLog(agent.id, agent.name, entry)
        }
      }
      break
    }
    case 'agent:status': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) { agent.status = ev.status; agent.updatedAt = new Date() }
      break
    }
    case 'agent:log': {
      const agent = agents.find(a => a.id === ev.agentId)
      const entry = fromWireEntry(ev.entry)
      if (agent) agent.logs.push(entry)
      pushLog(ev.agentId, agent?.name ?? ev.agentId, entry)
      break
    }
    case 'tool:call': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) { agent.metrics.toolCallsCount++; agent.updatedAt = new Date() }
      pushLog(ev.agentId, agent?.name ?? ev.agentId, {
        timestamp: new Date(),
        level: 'debug',
        message: `${ev.tool}(${safeJSONPreview(ev.input)})`,
        source: 'tool:call',
      })
      break
    }
    case 'tool:result': {
      const agent = agents.find(a => a.id === ev.agentId)
      pushLog(ev.agentId, agent?.name ?? ev.agentId, {
        timestamp: new Date(),
        level: 'debug',
        message: `  ↳ ${ev.tool} → ${safeJSONPreview(ev.output)}`,
        source: 'tool:result',
      })
      break
    }
    case 'session:end': {
      const agent = agents.find(a => a.id === ev.agentId)
      if (agent) {
        agent.status = ev.summary.outcome === 'success' ? 'done' : 'error'
        agent.updatedAt = new Date()
      }
      break
    }
  }
}

// ── Demo fallback ─────────────────────────────────────────────────────────────

function makeDemoAgents(): Agent[] {
  const START = Date.now() - 18 * 60 * 1000
  return [
    {
      id: 'claude-dev',
      name: 'Claude Dev',
      status: 'running',
      task: 'Implement the tmux session bridge',
      startedAt: new Date(START),
      updatedAt: new Date(),
      logs: [],
      metrics: {
        tokensUsed: 18420,
        toolCallsCount: 27,
        filesModified: ['apps/web/src/main.ts', 'docs/architecture.md'],
        durationMs: 18 * 60 * 1000,
      },
      topology: makeDemoTopology('claude-dev', 'Claude Dev'),
    },
    {
      id: 'reviewer',
      name: 'Review Agent',
      status: 'waiting',
      task: 'Waiting for the next diff to review',
      startedAt: null,
      updatedAt: new Date(),
      logs: [],
      metrics: { tokensUsed: 0, toolCallsCount: 0, filesModified: [], durationMs: 0 },
    },
    {
      id: 'tests',
      name: 'Test Runner',
      status: 'done',
      task: 'Run typecheck and smoke tests',
      startedAt: new Date(START),
      updatedAt: new Date(),
      logs: [],
      metrics: { tokensUsed: 1420, toolCallsCount: 5, filesModified: [], durationMs: 18 * 60 * 1000 },
    },
  ]
}

function makeDemoTopology(rootId: string, rootLabel: string): Topology {
  return {
    updatedAt: new Date(),
    nodes: [
      { id: rootId, label: rootLabel, kind: 'agent', status: 'running', observed: true, count: 27 },
      { id: 'ws:implementation', label: 'Implementation', kind: 'workstream', status: 'running', observed: false, count: 12, detail: 'patches in flight' },
      { id: 'ws:verification', label: 'Verification', kind: 'workstream', status: 'running', observed: false, count: 8, detail: 'typecheck pending' },
      { id: 'ws:deployment', label: 'Deployment', kind: 'workstream', status: 'idle', observed: false, count: 3, detail: 'queued' },
      { id: 'tool:implementation:patch', label: 'patch', kind: 'tool', status: 'running', observed: true, count: 5, detail: 'apply diff' },
      { id: 'tool:verification:npm', label: 'npm', kind: 'tool', status: 'idle', observed: true, count: 4, detail: 'run typecheck' },
      { id: 'file:apps/web/src/main.ts', label: 'apps/web/src/main.ts', kind: 'file', status: 'running', observed: true, detail: 'edited' },
    ],
    edges: [
      { from: rootId, to: 'ws:implementation' },
      { from: rootId, to: 'ws:verification' },
      { from: rootId, to: 'ws:deployment' },
      { from: 'ws:implementation', to: 'tool:implementation:patch' },
      { from: 'ws:verification', to: 'tool:verification:npm' },
      { from: 'ws:implementation', to: 'file:apps/web/src/main.ts' },
    ],
  }
}

const DEMO_LOGS: Array<{ agentId: string; agentName: string; entry: Omit<LogEntry, 'timestamp'> }> = [
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'info',  message: 'Session attached to tmux pane claude-dev:0.0' } },
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'debug', message: 'Read apps/web/src/types/agent.ts' } },
  { agentId: 'claude-dev', agentName: 'Claude Dev',   entry: { level: 'info',  message: 'Planning bridge event schema' } },
  { agentId: 'tests',      agentName: 'Test Runner',  entry: { level: 'info',  message: 'npm run typecheck completed successfully' } },
  { agentId: 'reviewer',   agentName: 'Review Agent', entry: { level: 'warn',  message: 'No active diff yet — standing by' } },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`
  return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime()
  if (diff < 10_000) return tr('time.justNow')
  if (diff < 60_000) return trn('time.secondsAgo', Math.floor(diff / 1000))
  if (diff < 3_600_000) return trn('time.minutesAgo', Math.floor(diff / 60_000))
  return trn('time.hoursAgo', Math.floor(diff / 3_600_000))
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000)    return `${(n / 1000).toFixed(1)}k`
  return n.toLocaleString()
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, Math.max(1, n - 1)) + '…'
}

function isInactive(status: AgentStatus): boolean {
  return status === 'done' || status === 'error'
}

function canControlAgent(agent: Agent): boolean {
  return mode === 'live' && agent.id.startsWith('tmux:')
}

function visibleLogStream(): LogStreamEntry[] {
  if (mode === 'live' || mode === 'reconnecting') return liveLogs
  const now = new Date()
  return DEMO_LOGS.map(d => ({ agentId: d.agentId, agentName: d.agentName, entry: { ...d.entry, timestamp: now } }))
}

// ── Agent classification ─────────────────────────────────────────────────────

const SYSTEM_AGENT_IDS = new Set([
  'hermes-gateway',
  'hermes-dashboard',
  'hermes-sessions',
  'hermes-error',
])

const TMUX_SENTINEL_IDS = new Set([
  'tmux:no-sessions',
  'tmux:error',
])

const RECENT_ACTIVITY_WINDOW_MS = 10 * 60 * 1000
const ACTIVITY_NOW_WINDOW_MS = 30 * 60 * 1000

function isSystemAgent(agent: Agent): boolean {
  if (SYSTEM_AGENT_IDS.has(agent.id)) return true
  if (TMUX_SENTINEL_IDS.has(agent.id)) return true
  return false
}

function isProjectAgent(agent: Agent): boolean {
  if (isSystemAgent(agent)) return false
  if (agent.id === 'hermes-development') return true
  if (agent.id.startsWith('hermes-session-') || agent.id.startsWith('hermes-session:')) return true
  if (agent.id.startsWith('tmux:')) return true
  // Anything not classified as system is treated as project work by default.
  return true
}

function isRecentlyActive(agent: Agent): boolean {
  if (agent.status === 'running' || agent.status === 'waiting') return true
  return Date.now() - agent.updatedAt.getTime() < RECENT_ACTIVITY_WINDOW_MS
}

function latestAgentSignal(agent: Agent): LogEntry | undefined {
  return agent.logs.length ? agent.logs[agent.logs.length - 1] : undefined
}

function recentAgentSignals(agent: Agent, max = 4): LogEntry[] {
  return agent.logs.slice(-max).reverse()
}

function hasFreshDevelopmentSignal(agent: Agent): boolean {
  if (!isProjectAgent(agent)) return false
  const latest = latestAgentSignal(agent)
  if (!latest) return agent.status === 'running'
  return agent.status === 'running' && Date.now() - latest.timestamp.getTime() < 2 * 60 * 1000
}

function visibleAgents(view: DashboardView): Agent[] {
  switch (view) {
    case 'now':
      return agents
        .filter(a => isProjectAgent(a) && isRecentlyActive(a))
        .sort(byActivityDesc)
    case 'system':
      return agents
        .filter(isSystemAgent)
        .sort((a, b) => a.name.localeCompare(b.name))
    case 'history':
      return agents
        .filter(a => !isSystemAgent(a) && !(isProjectAgent(a) && isRecentlyActive(a)))
        .sort(byActivityDesc)
  }
}

function byActivityDesc(a: Agent, b: Agent): number {
  // Running first, then most recently updated
  const aRun = a.status === 'running' ? 1 : 0
  const bRun = b.status === 'running' ? 1 : 0
  if (aRun !== bRun) return bRun - aRun
  return b.updatedAt.getTime() - a.updatedAt.getTime()
}

// ── Activity merge ───────────────────────────────────────────────────────────

function mergedRecentActivity(): LogStreamEntry[] {
  if (mode === 'demo') return visibleLogStream().slice().reverse()

  const seen = new Set<string>()
  const all: LogStreamEntry[] = []

  for (const agent of agents) {
    if (!agent.logs.length) continue
    // Take the tail of agent.logs to bound work on large snapshots.
    const tail = agent.logs.length > 60 ? agent.logs.slice(-60) : agent.logs
    for (const entry of tail) {
      const key = logSignature(agent.id, entry)
      if (seen.has(key)) continue
      seen.add(key)
      all.push({ agentId: agent.id, agentName: agent.name, entry })
    }
  }

  for (const log of liveLogs) {
    const key = logSignature(log.agentId, log.entry)
    if (seen.has(key)) continue
    seen.add(key)
    all.push(log)
  }

  return all.sort((a, b) => b.entry.timestamp.getTime() - a.entry.timestamp.getTime())
}

function getActivityNowLogs(agents: Agent[]): LogStreamEntry[] {
  const cutoff = Date.now() - ACTIVITY_NOW_WINDOW_MS
  return mergedRecentActivity()
    .filter(l => {
      const agent = agents.find(a => a.id === l.agentId)
      return (!agent || isProjectAgent(agent)) && l.entry.timestamp.getTime() >= cutoff
    })
    .sort((a, b) => b.entry.timestamp.getTime() - a.entry.timestamp.getTime())
}

// ── Render ───────────────────────────────────────────────────────────────────

function preserveInputs(): Map<string, string> {
  const saved = new Map<string, string>()
  document.querySelectorAll<HTMLTextAreaElement>('.agent-controls__input').forEach(ta => {
    const card = ta.closest<HTMLElement>('[data-agent-id]')
    const id = card?.dataset['agentId']
    if (id) saved.set(id, ta.value)
  })
  return saved
}

function restoreInputs(saved: Map<string, string>): void {
  document.querySelectorAll<HTMLTextAreaElement>('.agent-controls__input').forEach(ta => {
    const card = ta.closest<HTMLElement>('[data-agent-id]')
    const id = card?.dataset['agentId']
    if (id) {
      const val = saved.get(id)
      if (val !== undefined) ta.value = val
    }
  })
}

function renderBuildInfo(): void {
  const version = document.querySelector<HTMLElement>('#agentdeck-version')
  if (!version) return
  version.textContent = buildInfo.label
  version.title = buildInfo.commit ? `AgentDeck ${buildInfo.version} (${buildInfo.commit})` : `AgentDeck ${buildInfo.version}`
}

function renderStaticLabels(): void {
  document.documentElement.lang = locale
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset['i18n']
    if (key) el.textContent = tr(key)
  })

  const textTargets: Array<[string, string]> = [
    ['#language-switch-label', 'topbar.language'],
    ['#hero-eyebrow', 'hero.eyebrow'],
    ['#hero-title', 'hero.title'],
    ['#hero-subtitle', 'hero.subtitle'],
    ['#hero-active-label', 'hero.active'],
    ['#hero-system-label', 'hero.system'],
    ['#hero-signals-label', 'hero.signals'],
    ['#agents-panel-title', 'panel.agents'],
    ['#stream-indicator-label', 'stream.listening'],
  ]
  for (const [selector, key] of textTargets) {
    const el = document.querySelector<HTMLElement>(selector)
    if (el) el.textContent = tr(key)
  }

  const switcher = document.querySelector<HTMLSelectElement>('#language-switch')
  if (switcher) switcher.value = locale
}

function render(): void {
  const grid      = document.querySelector<HTMLDivElement>('#agent-grid')
  const count     = document.querySelector<HTMLSpanElement>('#agent-count')
  const statusBar = document.querySelector<HTMLDivElement>('#status-bar')
  if (!grid || !count || !statusBar) return

  renderBuildInfo()
  renderStaticLabels()
  const waiting = agents.filter(a => a.status === 'waiting').length
  const errors  = agents.filter(a => a.status === 'error').length

  const nowAgents     = visibleAgents('now')
  const systemAgents  = visibleAgents('system')
  const historyAgents = visibleAgents('history')
  const activeRunning = nowAgents.filter(a => a.status === 'running').length
  const recentSignals = getActivityNowLogs(agents).length

  const heroActive  = document.querySelector<HTMLElement>('#hero-active')
  const heroSystem  = document.querySelector<HTMLElement>('#hero-system')
  const heroSignals = document.querySelector<HTMLElement>('#hero-signals')
  if (heroActive)  heroActive.textContent  = String(nowAgents.length || activeRunning)
  if (heroSystem)  heroSystem.textContent  = String(systemAgents.length)
  if (heroSignals) heroSignals.textContent = String(recentSignals)

  const connBadge =
    mode === 'live'         ? `<span class="conn-badge conn-badge--live">${tr('status.live')}</span>` :
    mode === 'reconnecting' ? `<span class="conn-badge conn-badge--offline">${tr('status.reconnecting')}</span>` :
                              `<span class="conn-badge conn-badge--demo">${tr('status.demo')}</span>`

  statusBar.innerHTML =
    connBadge +
    (waiting ? `<span class="status-count"><strong>${waiting}</strong> ${tr('status.waiting')}</span>` : '') +
    (errors  ? `<span class="status-count status-count--error"><strong>${errors}</strong> ${tr(errors > 1 ? 'status.errors' : 'status.error')}</span>` : '')

  // Dashboard nav state and counts
  const navCounts: Record<DashboardView, number> = {
    now: nowAgents.length,
    system: systemAgents.length,
    history: historyAgents.length,
  }
  for (const view of ['now', 'system', 'history'] as const) {
    const btn = document.querySelector<HTMLButtonElement>(`#dashboard-view-${view}`)
    if (!btn) continue
    btn.classList.toggle('dashboard-nav__btn--active', dashboardView === view)
    btn.setAttribute('aria-selected', dashboardView === view ? 'true' : 'false')
    const c = btn.querySelector<HTMLElement>('em')
    if (c) c.textContent = String(navCounts[view])
  }

  const visible = visibleAgents(dashboardView)
  count.textContent = String(visible.length)

  const saved = preserveInputs()
  grid.innerHTML = visible.length
    ? visible.map(renderAgentCard).join('')
    : `<p class="agent-grid__empty">${esc(emptyDashboardMessage(dashboardView))}</p>`
  restoreInputs(saved)

  renderActivityNow()
  renderClaudePressure()
  renderEventTicker()

  if (selectedAgentId && !agents.some(a => a.id === selectedAgentId)) {
    selectedAgentId = null
  }
  renderAgentDetail()
}

function emptyDashboardMessage(view: DashboardView): string {
  switch (view) {
    case 'now':     return tr('empty.now')
    case 'system':  return tr('empty.system')
    case 'history': return tr('empty.history')
  }
}

function renderAgentCard(agent: Agent): string {
  const durationMs = agent.startedAt
    ? Date.now() - agent.startedAt.getTime()
    : agent.metrics.durationMs

  const pulseDot = agent.status === 'running'
    ? '<span class="agent-pulse" aria-hidden="true"></span>'
    : ''

  const controls = canControlAgent(agent) ? renderAgentControls(agent) : ''

  const filesSection = agent.metrics.filesModified.length > 0
    ? `<details>
        <summary>${agent.metrics.filesModified.length} ${tr(agent.metrics.filesModified.length === 1 ? 'card.modifiedFile' : 'card.modifiedFiles')}</summary>
        <ul>${agent.metrics.filesModified.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
      </details>`
    : ''

  const recentSignals = recentAgentSignals(agent)
  const latestSection = recentSignals.length > 0
    ? `<div class="agent-card__latest">
        <span>${tr('card.liveTrail')}</span>
        <ol class="agent-card__trail">
          ${recentSignals.map(entry => `
            <li class="agent-card__trail-line agent-card__trail-line--${entry.level}">
              <time>${entry.timestamp.toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              <span>${esc(truncate(entry.message, 120))}</span>
            </li>`).join('')}
        </ol>
      </div>`
    : ''

  const activeSignalClass = hasFreshDevelopmentSignal(agent) ? ' agent-card--activity-signal' : ''

  return `
    <article class="agent-card agent-card--${agent.status}${selectedAgentId === agent.id ? ' agent-card--selected' : ''}${activeSignalClass}" data-agent-id="${esc(agent.id)}" data-agent-name="${esc(agent.name)}" role="button" tabindex="0" aria-label="${tr('card.openDetails')} ${esc(agent.name)}">
      <div class="agent-card__header">
        <h3>${esc(agent.name)}</h3>
        <span class="status status--${agent.status}">${pulseDot}${agent.status}</span>
      </div>
      <div class="agent-card__id">${esc(agent.id)}</div>
      <p class="agent-card__task">${esc(agent.task)}</p>
      <dl class="metrics">
        <div><dt>${tr('metric.tokens')}</dt><dd>${fmtTokens(agent.metrics.tokensUsed)}</dd></div>
        <div><dt>${tr('metric.tools')}</dt><dd>${agent.metrics.toolCallsCount}</dd></div>
        <div><dt>${tr('metric.files')}</dt><dd>${agent.metrics.filesModified.length}</dd></div>
      </dl>
      ${latestSection}
      <div class="agent-card__footer">
        <span class="agent-card__meta">${durationMs > 0 ? formatDuration(durationMs) : '—'}</span>
        <span class="agent-card__meta">${timeAgo(agent.updatedAt)}</span>
      </div>
      ${filesSection}
      ${controls}
    </article>
  `
}

function renderAgentControls(agent: Agent): string {
  const dis = isInactive(agent.status) ? ' disabled' : ''
  return `
    <div class="agent-controls">
      <textarea class="agent-controls__input" rows="2" placeholder="${tr('control.inputPlaceholder')}"${dis}></textarea>
      <div class="agent-controls__row">
        <label><input type="checkbox" class="agent-controls__enter" checked> ${tr('control.enter')}</label>
        <button class="agent-control-send" data-id="${esc(agent.id)}"${dis}>${tr('control.send')}</button>
        <button class="agent-control-stop" data-id="${esc(agent.id)}"${dis}>${tr('control.stop')}</button>
      </div>
    </div>
  `
}

// ── Claude Code pressure ─────────────────────────────────────────────────────

function pressureLabel(pressure: ClaudeTelemetry['pressure']): string {
  switch (pressure) {
    case 'calm':     return tr('pressure.calm')
    case 'elevated': return tr('pressure.elevated')
    case 'high':     return tr('pressure.high')
  }
}

function renderClaudeEvent(event: ClaudeTelemetryEvent): string {
  const time = new Date(event.timestamp).toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const body = event.type === 'wait'
    ? `attente ${event.waitSeconds ?? 0}s · ${event.reason ?? 'cooldown'}`
    : event.type === 'blocked'
      ? `bloqué · ${event.mode ?? 'pause'} · ${event.reason ?? 'agentdeck_pause'}`
      : `lancement · cap ${event.cap ?? '—'}${event.cappedOrAdded ? ' · cap appliqué' : ''}`
  return `<li><time>${time}</time><span>${esc(body)}</span></li>`
}

function claudeModeLabel(modeName: ClaudeControl['mode']): string {
  switch (modeName) {
    case 'normal':  return 'Normal'
    case 'economy': return 'Économie'
    case 'strict':  return 'Strict'
  }
}

function claudeRuntimeLabel(runtime: ClaudeRuntime | undefined): string {
  if (!runtime) return tr('runtime.unknown')
  if (runtime.status === 'paused') return tr('runtime.paused')
  if (runtime.status === 'cooling') return `${tr('runtime.nextWindow')} ${formatDuration(runtime.cooldownRemainingSeconds * 1000)}`
  return tr('runtime.ready')
}

function claudeRuntimeDetail(runtime: ClaudeRuntime | undefined): string {
  if (!runtime?.nextAllowedAt) return tr('runtime.noLastStart')
  const next = new Date(runtime.nextAllowedAt).toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return runtime.status === 'cooling' ? `${tr('runtime.allowedAt')} ${next}` : `${tr('runtime.openSince')} ${next}`
}

function claudeAuditChangeLabel(entry: ClaudeControlAuditEntry): string {
  if (entry.changes.includes('mode') && entry.changes.includes('paused')) return 'mode + pause'
  if (entry.changes.includes('mode')) return 'mode'
  return 'pause'
}

function renderClaudeControlAudit(audit: ClaudeControlAuditEntry[] | undefined): string {
  const entries = (audit ?? []).slice(-3).reverse()
  if (entries.length === 0) return ''
  return `
    <ol class="claude-control__audit" aria-label="${tr('claude.auditLabel')}">
      ${entries.map(entry => {
        const time = new Date(entry.timestamp).toLocaleTimeString('en', {
          hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
        })
        const state = `${claudeModeLabel(entry.mode)} · ${entry.paused ? 'pause' : 'actif'} · cap ${entry.maxTurnsCap}`
        return `<li><time>${time}</time><span>${esc(claudeAuditChangeLabel(entry))}</span><strong>${esc(state)}</strong></li>`
      }).join('')}
    </ol>`
}

function renderClaudeControls(): string {
  if (!claudeControl) {
    return `<p class="claude-pressure__note">${tr('claude.controlUnavailable')}</p>`
  }

  const c = claudeControl
  const runtime = c.runtime
  const modes: ClaudeControl['mode'][] = ['normal', 'economy', 'strict']
  return `
    <div class="claude-control" aria-label="Contrôle Claude Code">
      <div class="claude-control__summary">
        <span>${tr('claude.mode')} ${claudeModeLabel(c.mode)}</span>
        <span>max-turns ≤ ${c.maxTurnsCap}</span>
        <span>${tr('claude.pauseMin')} ${formatDuration(c.minStartIntervalSeconds * 1000)}</span>
        <span>${c.paused ? tr('claude.launchesSuspended') : tr('claude.launchesAllowed')}</span>
      </div>
      <div class="claude-control__runtime" data-runtime-status="${runtime?.status ?? 'unknown'}">
        <strong>${claudeRuntimeLabel(runtime)}</strong>
        <span>${claudeRuntimeDetail(runtime)}</span>
      </div>
      <div class="claude-control__actions">
        ${modes.map(m => `
          <button type="button" class="claude-control__btn${m === c.mode ? ' claude-control__btn--active' : ''}" data-claude-mode="${m}" ${m === c.mode ? 'aria-pressed="true"' : 'aria-pressed="false"'}>${claudeModeLabel(m)}</button>`).join('')}
        <button type="button" class="claude-control__btn claude-control__btn--pause${c.paused ? ' claude-control__btn--active' : ''}" data-claude-paused="${c.paused ? '0' : '1'}">${c.paused ? tr('claude.resume') : tr('claude.pauseAi')}</button>
      </div>
      ${renderClaudeControlAudit(c.audit)}
    </div>`
}

function renderClaudePressure(): void {
  const panel = document.querySelector<HTMLDivElement>('#claude-pressure')
  if (!panel) return

  if (!claudeTelemetry) {
    panel.innerHTML = `
      <div class="claude-pressure__head">
        <div><span class="claude-pressure__eyebrow">Claude Code</span><strong>${tr('pressure.unknown')}</strong></div>
        <span class="pressure-pill pressure-pill--unknown">${tr('pressure.offline')}</span>
      </div>
      ${renderClaudeControls()}
      <p class="claude-pressure__note">${tr('pressure.telemetryMissing')}</p>
      <p class="claude-pressure__note">${tr('claude.rateLimitNote')}</p>`
    return
  }

  const t = claudeTelemetry
  const events = t.recentEvents.slice(0, 4)
  const runtime = claudeControl?.runtime
  const statusText = claudeControl?.paused
    ? tr('pressure.paused')
    : runtime?.status === 'cooling'
      ? tr('pressure.cooldown')
      : `${tr('pressure.prefix')} ${pressureLabel(t.pressure)}`
  panel.innerHTML = `
    <div class="claude-pressure__head">
      <div>
        <span class="claude-pressure__eyebrow">Claude Code</span>
        <strong>${statusText}</strong>
      </div>
      <span class="pressure-pill pressure-pill--${claudeControl?.paused ? 'unknown' : t.pressure}">${claudeControl?.paused ? tr('runtime.paused') : pressureLabel(t.pressure)}</span>
    </div>
    ${renderClaudeControls()}
    <dl class="claude-pressure__metrics">
      <div><dt>${tr('pressure.launches')}</dt><dd>${t.launches1h}</dd></div>
      <div><dt>${tr('pressure.waits')}</dt><dd>${t.waits1h}</dd></div>
      <div><dt>${tr('pressure.caps')}</dt><dd>${t.capped1h}</dd></div>
      <div><dt>${tr('pressure.cooldownMetric')}</dt><dd>${formatDuration(t.totalWaitSeconds1h * 1000)}</dd></div>
    </dl>
    ${events.length ? `<ol class="claude-pressure__events">${events.map(renderClaudeEvent).join('')}</ol>` : `<p class="claude-pressure__note">${tr('pressure.none')}</p>`}
    <p class="claude-pressure__note">${tr('claude.rateLimitNote')}</p>
    <p class="claude-pressure__note">${tr('pressure.updated')} ${timeAgo(new Date(t.updatedAt))} · ${tr('pressure.source')}</p>`
}

// ── Activity Now (primary live signals strip) ────────────────────────────────

function renderActivityNow(): void {
  const feed = document.querySelector<HTMLDivElement>('#activity-now-feed')
  if (!feed) return

  const recent = getActivityNowLogs(agents).slice(0, 8)

  if (recent.length === 0) {
    feed.innerHTML = `
      <div class="activity-now__head">
        <span class="activity-now__label">${tr('activity.now')}</span>
        <span class="activity-now__hint">${tr('activity.waiting')}</span>
      </div>`
    return
  }

  feed.innerHTML = `
    <div class="activity-now__head">
      <span class="activity-now__label">
        <span class="activity-now__dot" aria-hidden="true"></span>
        ${tr('activity.now')}
      </span>
      <span class="activity-now__hint">${recent.length} ${tr(recent.length === 1 ? 'activity.recentSignal' : 'activity.recentSignals')} · ${tr('activity.openHint')}</span>
    </div>
    <ul class="activity-now__list" role="log" aria-live="polite">
      ${recent.map(renderActivityNowLine).join('')}
    </ul>`
}

function renderActivityNowLine(l: LogStreamEntry): string {
  const time = l.entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  return `
    <li>
      <button type="button" class="activity-now__item activity-now__item--${l.entry.level}" data-agent-id="${esc(l.agentId)}">
        <span class="activity-now__time">${time}</span>
        <span class="activity-now__agent">${esc(l.agentName)}</span>
        <span class="activity-now__msg">${esc(truncate(l.entry.message, 160))}</span>
      </button>
    </li>`
}

// ── Event ticker (compact dashboard strip) ───────────────────────────────────

function renderEventTicker(): void {
  const feed = document.querySelector<HTMLDivElement>('#event-ticker-feed')
  if (!feed) return

  const stream = visibleLogStream()
  const recent = stream.slice(-6).reverse()

  if (recent.length === 0) {
    feed.innerHTML = `<span class="event-ticker__empty">${tr('event.waiting')}</span>`
    return
  }

  feed.innerHTML = recent.map(({ agentId, agentName, entry }) => {
    const time = entry.timestamp.toLocaleTimeString('en', {
      hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    return `
      <button type="button" class="event-ticker__line event-ticker__line--${entry.level}" data-agent-id="${esc(agentId)}">
        <span class="event-ticker__time">${time}</span>
        <span class="event-ticker__agent">${esc(agentName)}</span>
        <span class="event-ticker__msg">${esc(truncate(entry.message, 140))}</span>
      </button>`
  }).join('')
}

// ── Agent inspector (full-screen, tabbed) ────────────────────────────────────

function renderAgentDetail(): void {
  const shell = document.querySelector<HTMLElement>('#agent-detail-shell')
  const content = document.querySelector<HTMLElement>('#agent-detail-content')
  if (!shell || !content) return

  const agent = selectedAgentId ? agents.find(a => a.id === selectedAgentId) : null
  if (!agent) {
    shell.classList.remove('agent-detail-shell--open')
    shell.setAttribute('aria-hidden', 'true')
    content.innerHTML = ''
    return
  }

  const tabs: TabId[] = ['topology', 'activity', 'files']
  if (canControlAgent(agent)) tabs.push('control')
  const activeTab: TabId = tabs.includes(selectedTab) ? selectedTab : 'topology'

  shell.classList.add('agent-detail-shell--open')
  shell.setAttribute('aria-hidden', 'false')

  const saved = preserveInputs()
  content.innerHTML = `
    ${renderInspectorHeader(agent)}
    ${renderInspectorMetrics(agent)}
    ${renderInspectorTabs(tabs, activeTab, agent)}
    <div class="inspector__body">
      ${renderInspectorTabContent(activeTab, agent)}
    </div>
  `
  restoreInputs(saved)
}

function renderInspectorHeader(agent: Agent): string {
  const pulseDot = agent.status === 'running' ? '<span class="agent-pulse" aria-hidden="true"></span>' : ''
  const liveTag = agent.status === 'running'
    ? `<span class="inspector__live"><span class="inspector__live-dot" aria-hidden="true"></span>${tr('inspector.live')}</span>`
    : ''
  return `
    <header class="inspector__header">
      <div class="inspector__title-block">
        <span class="inspector__eyebrow">${tr('inspector.eyebrow')}</span>
        <div class="inspector__title-row">
          <h2 id="agent-detail-title">${esc(agent.name)}</h2>
          ${liveTag}
        </div>
        <div class="inspector__meta">
          <span class="status status--${agent.status}">${pulseDot}${agent.status}</span>
          <code title="${esc(agent.id)}">${esc(agent.id)}</code>
          <span class="inspector__meta-time">${tr('inspector.lastUpdate')} ${timeAgo(agent.updatedAt)}</span>
        </div>
        <p class="inspector__mission">${esc(agent.task)}</p>
      </div>
      <button class="inspector__close agent-detail__close" type="button" aria-label="${tr('inspector.close')}">×</button>
    </header>`
}

function renderInspectorMetrics(agent: Agent): string {
  const durationMs = agent.startedAt ? Date.now() - agent.startedAt.getTime() : agent.metrics.durationMs
  const tiles: Array<[string, string, boolean]> = [
    [tr('inspector.duration'), durationMs > 0 ? formatDuration(durationMs) : '—', agent.status === 'running'],
    [tr('inspector.updated'), timeAgo(agent.updatedAt), false],
    [tr('metric.tokens'), fmtTokens(agent.metrics.tokensUsed), false],
    [tr('inspector.toolCalls'), String(agent.metrics.toolCallsCount), false],
    [tr('metric.files'), String(agent.metrics.filesModified.length), false],
    [tr('inspector.mode'), mode, mode === 'live'],
  ]
  return `
    <section class="inspector__metrics">
      ${tiles.map(([label, value, live]) => `
        <div class="inspector__metric${live ? ' inspector__metric--live' : ''}">
          <span>${esc(label)}</span>
          <strong>${esc(value)}</strong>
        </div>
      `).join('')}
    </section>`
}

function renderInspectorTabs(tabs: TabId[], active: TabId, agent: Agent): string {
  const labels: Record<TabId, string> = {
    topology: tr('tab.topology'),
    activity: tr('tab.activity'),
    files: tr('tab.files'),
    control: tr('tab.control'),
  }
  const counts: Partial<Record<TabId, number>> = {
    activity: agent.logs.length,
    files: agent.metrics.filesModified.length,
  }
  return `
    <nav class="inspector__tabs" role="tablist" aria-label="${tr('tabs.label')}">
      ${tabs.map(tab => {
        const c = counts[tab]
        return `
          <button class="inspector__tab${tab === active ? ' inspector__tab--active' : ''}"
            role="tab" aria-selected="${tab === active}"
            data-tab="${tab}" type="button">
            <span>${labels[tab]}</span>
            ${typeof c === 'number' ? `<em>${c}</em>` : ''}
          </button>`
      }).join('')}
    </nav>`
}

function renderInspectorTabContent(tab: TabId, agent: Agent): string {
  switch (tab) {
    case 'topology': return renderTopologyTab(agent)
    case 'activity': return renderActivityTab(agent)
    case 'files':    return renderFilesTab(agent)
    case 'control':  return renderControlTab(agent)
  }
}

function renderTopologyTab(agent: Agent): string {
  return `
    <section class="inspector__panel inspector__panel--topology">
      <div class="inspector__panel-head">
        <div>
          <h3>${tr('topology.title')}</h3>
          <p>${agent.topology
              ? `${agent.topology.nodes.length} ${tr(agent.topology.nodes.length === 1 ? 'topology.node' : 'topology.nodes')} · ${agent.topology.edges.length} ${tr(agent.topology.edges.length === 1 ? 'topology.link' : 'topology.links')} · ${tr('topology.refreshed')} ${timeAgo(agent.topology.updatedAt)}`
              : tr('topology.waiting')}}</p>
        </div>
        <div class="inspector__legend">
          <span><i class="legend-dot legend-dot--observed"></i> ${tr('topology.observed')}</span>
          <span><i class="legend-dot legend-dot--inferred"></i> ${tr('topology.inferred')}</span>
        </div>
      </div>
      ${renderTopologyGraph(agent)}
    </section>`
}

function renderActivityTab(agent: Agent): string {
  const stream = visibleLogStream()
  const filtered = activityScope === 'all'
    ? stream
    : stream.filter(l => l.agentId === agent.id)
  const visible = filtered.slice(-200)

  return `
    <section class="inspector__panel inspector__panel--activity">
      <div class="inspector__panel-head">
        <div>
          <h3>${tr('activity.title')}</h3>
          <p>${visible.length} of ${filtered.length} event${filtered.length === 1 ? '' : 's'}${activityScope === 'all' ? ' across all agents' : ` from ${esc(agent.name)}`}</p>
        </div>
        <div class="inspector__panel-controls">
          <select id="activity-scope" class="panel__select" aria-label="${tr('activity.scope')}">
            <option value="this"${activityScope === 'this' ? ' selected' : ''}>${tr('activity.thisAgent')}</option>
            <option value="all"${activityScope === 'all' ? ' selected' : ''}>${tr('activity.allAgents')}</option>
          </select>
        </div>
      </div>
      <div class="inspector__log-feed" role="log" aria-live="polite">
        ${visible.length
          ? visible.map(l => renderActivityLogLine(l, agent.id)).join('')
          : `<p class="agent-detail__empty">${tr('activity.noEvents')}</p>`}
      </div>
    </section>`
}

function renderActivityLogLine(l: LogStreamEntry, currentAgentId: string): string {
  const time = l.entry.timestamp.toLocaleTimeString('en', {
    hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const own = l.agentId === currentAgentId ? ' inspector__log--own' : ''
  return `
    <div class="inspector__log inspector__log--${l.entry.level}${own}">
      <time>${time}</time>
      <span class="inspector__log-agent">${esc(l.agentName)}</span>
      <span class="inspector__log-level">${l.entry.level}</span>
      <p class="inspector__log-msg">${esc(l.entry.message)}</p>
    </div>`
}

function renderFilesTab(agent: Agent): string {
  const files = agent.metrics.filesModified
  return `
    <section class="inspector__panel inspector__panel--files">
      <div class="inspector__panel-head">
        <div>
          <h3>${tr('files.title')}</h3>
          <p>${files.length} ${tr(files.length === 1 ? 'metric.files' : 'metric.files')} ${tr('files.touched')}</p>
        </div>
      </div>
      ${files.length
        ? `<ul class="inspector__files">${files.map(f => `<li><span class="inspector__file-icon" aria-hidden="true"></span><code>${esc(f)}</code></li>`).join('')}</ul>`
        : `<p class="agent-detail__empty">${tr('files.none')}</p>`}
    </section>`
}

function renderControlTab(agent: Agent): string {
  const inactive = isInactive(agent.status)
  const dis = inactive ? ' disabled' : ''
  return `
    <section class="inspector__panel inspector__panel--control">
      <div class="inspector__panel-head">
        <div>
          <h3>${tr('control.title')}</h3>
          <p>${tr('control.help')}</p>
        </div>
      </div>
      <div class="inspector__control" data-agent-id="${esc(agent.id)}" data-agent-name="${esc(agent.name)}">
        <textarea class="agent-controls__input" rows="6" placeholder="${tr('control.inputPlaceholder')}"${dis}></textarea>
        <div class="agent-controls__row">
          <label><input type="checkbox" class="agent-controls__enter" checked> ${tr('control.sendEnter')}</label>
          <button class="agent-control-send" data-id="${esc(agent.id)}"${dis}>${tr('control.send')}</button>
          <button class="agent-control-stop" data-id="${esc(agent.id)}"${dis}>${tr('control.stopSession')}</button>
        </div>
        ${inactive ? `<p class="agent-detail__empty">${tr('control.inactive')}</p>` : ''}
      </div>
    </section>`
}

// ── Topology graph (dynamic, alive) ──────────────────────────────────────────

function deriveNodeActivity(node: TopologyNode, agent: Agent): string {
  if (node.detail) return truncate(node.detail, 56)
  if (node.kind === 'agent') {
    const last = agent.logs.length ? agent.logs[agent.logs.length - 1] : undefined
    if (last) return truncate(last.message, 56)
    if (agent.task) return truncate(agent.task, 56)
    return tr('topology.awaitingActivity')
  }
  if (typeof node.count === 'number' && node.count > 0) {
    return `${node.count} ${tr(node.count === 1 ? 'topology.signal' : 'topology.signals')}`
  }
  if (node.kind === 'workstream') return tr('topology.standingBy')
  if (node.kind === 'tool')       return tr('topology.idleActivity')
  if (node.kind === 'file')       return tr('topology.touched')
  return tr('topology.awaiting')
}

function renderTopologyGraph(agent: Agent): string {
  const topology = agent.topology
  if (!topology || topology.nodes.length === 0) {
    return `
      <div class="topology-canvas topology-canvas--empty">
        <div class="topology-canvas__placeholder">
          <span class="agent-pulse" aria-hidden="true"></span>
          ${tr('topology.placeholder')}
        </div>
      </div>`
  }

  const root = topology.nodes.find(n => n.kind === 'agent') ?? topology.nodes[0]
  const workstreams = topology.nodes.filter(n => n.kind === 'workstream')
  const observed = topology.nodes.filter(n => n.kind === 'tool' || n.kind === 'file' || n.kind === 'event').slice(0, 18)

  const edgesByTarget = new Map<string, TopologyEdge[]>()
  for (const e of topology.edges) {
    const list = edgesByTarget.get(e.to) ?? []
    list.push(e)
    edgesByTarget.set(e.to, list)
  }

  const renderNode = (node: TopologyNode): string => {
    const live = node.status === 'running'
    const observedClass = node.observed ? ' t-node--observed' : ' t-node--inferred'
    const linked = edgesByTarget.has(node.id) ? ' t-node--linked' : ''
    const liveLabel = live ? tr('topology.live') : (node.status === 'idle' || node.status === 'waiting' ? tr('topology.idle') : node.status.toUpperCase())
    const activity = deriveNodeActivity(node, agent)
    const counter = typeof node.count === 'number'
      ? `<span class="t-node__counter" title="signals"><span class="t-node__counter-dot" aria-hidden="true"></span>${node.count}</span>`
      : ''

    return `
      <div class="t-node t-node--${node.kind} t-node--${node.status}${observedClass}${linked}" data-node-id="${esc(node.id)}">
        <div class="t-node__top">
          <span class="t-node__kind">${esc(node.kind)}</span>
          <span class="t-node__live${live ? '' : ' t-node__live--idle'}">
            ${live ? '<span class="t-node__dot" aria-hidden="true"></span>' : ''}${liveLabel}
          </span>
        </div>
        <strong class="t-node__label" title="${esc(node.label)}">${esc(node.label)}</strong>
        <small class="t-node__activity">${esc(activity)}</small>
        <div class="t-node__foot">
          <span class="t-node__badge">${node.observed ? tr('topology.observed') : tr('topology.inferred')}</span>
          ${counter}
        </div>
      </div>`
  }

  return `
    <div class="topology-canvas" aria-label="${tr('topology.graphLabel')}">
      <div class="topology-canvas__board">
        <div class="topology-canvas__beam" aria-hidden="true"></div>
        <div class="topology-canvas__grid">
          <div class="topology-tier topology-tier--root">
            <span class="topology-tier__label">${tr('topology.agent')}</span>
            <div class="topology-tier__body">
              ${root ? renderNode(root) : ''}
            </div>
          </div>
          <div class="topology-tier topology-tier--workstreams">
            <span class="topology-tier__label">${tr('topology.workstreams')}</span>
            <div class="topology-tier__body">
              ${workstreams.length
                ? workstreams.map(renderNode).join('')
                : `<p class="topology-tier__empty">${tr('topology.noWorkstreams')}</p>`}
            </div>
          </div>
          <div class="topology-tier topology-tier--observed">
            <span class="topology-tier__label">${tr('topology.observedTier')}</span>
            <div class="topology-tier__body">
              ${observed.length
                ? observed.map(renderNode).join('')
                : `<p class="topology-tier__empty">${tr('topology.noObserved')}</p>`}
            </div>
          </div>
        </div>
      </div>
    </div>`
}

function shouldIgnoreCardOpen(target: HTMLElement): boolean {
  return Boolean(target.closest('.agent-controls, button, input, textarea, select, details, summary, a'))
}

function openAgentDetail(agentId: string, tab?: TabId): void {
  if (!agentId) return
  selectedAgentId = agentId
  if (tab) selectedTab = tab
  render()
}

function closeAgentDetail(): void {
  if (!selectedAgentId) return
  selectedAgentId = null
  render()
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ── Click delegation ─────────────────────────────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  const target = e.target as HTMLElement

  if (target.closest('#agent-detail-backdrop, .agent-detail__close, .inspector__close')) {
    closeAgentDetail()
    return
  }

  const tabBtn = target.closest<HTMLButtonElement>('.inspector__tab')
  if (tabBtn) {
    const tab = tabBtn.dataset['tab'] as TabId | undefined
    if (tab && tab !== selectedTab) {
      selectedTab = tab
      renderAgentDetail()
    }
    return
  }

  const tickerLine = target.closest<HTMLButtonElement>('.event-ticker__line')
  if (tickerLine) {
    const id = tickerLine.dataset['agentId'] ?? ''
    if (id) openAgentDetail(id, 'activity')
    return
  }

  const activityItem = target.closest<HTMLButtonElement>('.activity-now__item')
  if (activityItem) {
    const id = activityItem.dataset['agentId'] ?? ''
    if (id) openAgentDetail(id, 'activity')
    return
  }

  const navBtn = target.closest<HTMLButtonElement>('.dashboard-nav__btn')
  if (navBtn) {
    const view = navBtn.dataset['view'] as DashboardView | undefined
    if (view && view !== dashboardView) {
      dashboardView = view
      render()
    }
    return
  }

  const claudeModeBtn = target.closest<HTMLButtonElement>('button[data-claude-mode]')
  if (claudeModeBtn) {
    const nextMode = claudeModeBtn.dataset['claudeMode'] as ClaudeControl['mode'] | undefined
    if (!nextMode || claudeModeBtn.disabled) return
    claudeModeBtn.disabled = true
    updateClaudeControl({ mode: nextMode })
      .then(renderClaudePressure)
      .catch(() => { /* keep current safe state */ })
      .finally(() => { claudeModeBtn.disabled = false })
    return
  }

  const claudePauseBtn = target.closest<HTMLButtonElement>('button[data-claude-paused]')
  if (claudePauseBtn) {
    if (claudePauseBtn.disabled) return
    const paused = claudePauseBtn.dataset['claudePaused'] === '1'
    claudePauseBtn.disabled = true
    updateClaudeControl({ paused })
      .then(renderClaudePressure)
      .catch(() => { /* keep current safe state */ })
      .finally(() => { claudePauseBtn.disabled = false })
    return
  }

  const ctlBtn = target.closest<HTMLButtonElement>('button.agent-control-send, button.agent-control-stop')
  if (ctlBtn) {
    if (ctlBtn.disabled) return

    const card = ctlBtn.closest<HTMLElement>('[data-agent-id]')
    if (!card) return
    const agentId = card.dataset['agentId'] ?? ''

    if (ctlBtn.classList.contains('agent-control-send')) {
      const textarea = card.querySelector<HTMLTextAreaElement>('.agent-controls__input')
      const enterCb  = card.querySelector<HTMLInputElement>('.agent-controls__enter')
      const text = textarea?.value ?? ''
      if (!text.trim()) return

      ctlBtn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, enter: enterCb?.checked ?? true }),
        signal: AbortSignal.timeout(5000),
      })
        .then(res => { if (res.ok && textarea) textarea.value = '' })
        .catch(() => { /* network error — user can retry */ })
        .finally(() => { ctlBtn.disabled = false })

    } else if (ctlBtn.classList.contains('agent-control-stop')) {
      const agentName = card.dataset['agentName'] ?? agentId
      if (!confirm(`Stop "${agentName}"?\n\nThis will kill the tmux session.`)) return

      ctlBtn.disabled = true
      fetch(`${API_BASE}/api/agents/${agentId}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(5000),
      })
        .catch(() => { /* network error */ })
        .finally(() => { ctlBtn.disabled = false })
    }
    return
  }

  const card = target.closest<HTMLElement>('#agent-grid [data-agent-id]')
  if (card && !shouldIgnoreCardOpen(target)) {
    openAgentDetail(card.dataset['agentId'] ?? '')
  }
})

document.querySelector<HTMLDivElement>('#agent-grid')?.addEventListener('keydown', (e: KeyboardEvent) => {
  const target = e.target as HTMLElement
  const card = target.closest<HTMLElement>('[data-agent-id]')
  if (!card || shouldIgnoreCardOpen(target)) return
  if (e.key !== 'Enter' && e.key !== ' ') return

  e.preventDefault()
  openAgentDetail(card.dataset['agentId'] ?? '')
})

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeAgentDetail()
})

document.addEventListener('change', (e: Event) => {
  const target = e.target as HTMLElement
  if (target.id === 'language-switch' && target instanceof HTMLSelectElement) {
    setLocale(target.value === 'en' ? 'en' : 'fr')
    return
  }
  if (target.id === 'activity-scope' && target instanceof HTMLSelectElement) {
    activityScope = target.value === 'all' ? 'all' : 'this'
    renderAgentDetail()
  }
})

// ── Init ─────────────────────────────────────────────────────────────────────

agents = makeDemoAgents()
render()
connect()

// Keep "time ago" / duration tickers and local Claude pressure fresh.
setInterval(() => {
  if (mode === 'live') {
    Promise.all([fetchClaudeTelemetry(), fetchClaudeControl()])
      .then(renderClaudePressure)
      .catch(() => { /* already handled in fetch helpers */ })
  }
  if (selectedAgentId) renderAgentDetail()
}, CLOCK_RENDER_MS)
