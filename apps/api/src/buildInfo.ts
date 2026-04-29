export interface BuildInfo {
  name: 'AgentDeck'
  version: string
  commit: string | null
  label: string
}

const DEFAULT_VERSION = '0.2.0'

function cleanVersion(version: string | undefined): string {
  const value = version?.trim()
  return value && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?$/.test(value) ? value : DEFAULT_VERSION
}

function cleanCommit(commit: string | null | undefined): string | null {
  const value = commit?.trim()
  if (!value) return null
  const match = /^[a-f0-9]{7,40}$/i.exec(value)
  return match ? value.slice(0, 7) : null
}

export function formatBuildLabel(version: string, commit: string | null | undefined): string {
  const clean = cleanCommit(commit)
  return clean ? `v${cleanVersion(version)} · ${clean}` : `v${cleanVersion(version)}`
}

export function getBuildInfo(
  version = process.env['AGENTDECK_VERSION'],
  commit = process.env['AGENTDECK_COMMIT'] ?? null,
): BuildInfo {
  const safeVersion = cleanVersion(version)
  const safeCommit = cleanCommit(commit)
  return {
    name: 'AgentDeck',
    version: safeVersion,
    commit: safeCommit,
    label: formatBuildLabel(safeVersion, safeCommit),
  }
}
