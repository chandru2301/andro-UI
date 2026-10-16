/**
 * The activity event model, mirrored from the andro MCP server's activity bus
 * (browser-agent-mcp/src/activity-bus.ts) so the UI and the server agree on the
 * wire format.
 */

export type EventStatus = 'running' | 'complete' | 'error' | 'awaiting-approval'
export type EventKind = 'search' | 'read' | 'write' | 'modify' | 'command' | 'thinking'

export type AndroEvent = {
  id: string
  kind: EventKind
  status: EventStatus
  title: string
  detail?: string
  path?: string
  timestamp: string
  durationMs?: number
  additions?: number
  deletions?: number
  changeType?: 'M' | 'A' | 'D'
  output?: string
  outputType?: 'stdout' | 'stderr' | 'info'
  progress?: number
  tool?: string
  technical?: string
  approval?: { status: string; summary: string; expiresAt?: number }
}

export type ChangedFile = {
  path: string
  type: 'M' | 'A' | 'D'
  additions: number
  deletions: number
}

/** Raw shape emitted by the server (status uses 'ok', not 'complete'). */
export type RawActivityEvent = {
  id?: string
  ts?: number
  tool?: string
  status?: string
  argsSummary?: string
  paths?: string[]
  durationMs?: number
  error?: string
  additions?: number
  deletions?: number
  output?: string
  outputType?: 'stdout' | 'stderr' | 'info'
  progress?: number
  args?: Record<string, unknown>
  approval?: { status: string; summary: string; expiresAt?: number }
}

export function kindOf(tool: string): EventKind {
  const lower = tool.toLowerCase()
  if (lower === 'grep' || lower === 'glob' || lower.includes('search')) return 'search'
  if (lower === 'read') return 'read'
  if (lower === 'write') return 'write'
  if (lower === 'edit' || lower === 'multiedit') return 'modify'
  if (lower === 'bash' || lower === 'shell') return 'command'
  return 'thinking'
}

/**
 * Map the server's status vocabulary onto the UI's.
 *
 * The server emits started | progress | ok | error | awaiting-approval. Note
 * 'ok' — not 'complete' — which is the value the UI displays as finished.
 */
export function statusOf(raw: string | undefined): EventStatus {
  if (raw === 'started' || raw === 'progress') return 'running'
  if (raw === 'error') return 'error'
  if (raw === 'awaiting-approval') return 'awaiting-approval'
  return 'complete'
}

/** Short human title, kept technical-free for the transcript. */
export function humanTitle(tool: string, raw: RawActivityEvent, status: EventStatus): string {
  const args = raw.args || {}
  const pattern = typeof args.pattern === 'string' ? args.pattern : ''
  const resolved = raw.paths?.[0] || (typeof args.path === 'string' ? args.path : '')
  if (status === 'error') return `${tool} could not finish`
  switch (tool.toLowerCase()) {
    case 'grep': return pattern ? `Searching for “${pattern}”` : 'Searching the project'
    case 'glob': return pattern ? 'Finding relevant project files' : 'Finding project files'
    case 'read': return resolved ? 'Reviewing a project file' : 'Reviewing project information'
    case 'edit': case 'multiedit': return resolved ? 'Updating a project file' : 'Updating the project'
    case 'write': return resolved ? 'Creating a project file' : 'Creating project content'
    case 'bash': return 'Running a project command'
    default: return 'Working on the project'
  }
}

export function normalizeEvent(raw: RawActivityEvent): AndroEvent {
  const tool = String(raw.tool || 'Operation')
  const status = statusOf(raw.status)
  const args = raw.args || {}
  const command = typeof args.command === 'string' ? args.command : undefined
  const additions = typeof args.additions === 'number' ? args.additions : raw.additions
  const deletions = typeof args.deletions === 'number' ? args.deletions : raw.deletions
  const detail = raw.error || (tool.toLowerCase() === 'bash' ? command : raw.argsSummary)

  return {
    id: String(raw.id || crypto.randomUUID()),
    kind: kindOf(tool),
    status,
    title: humanTitle(tool, raw, status),
    detail,
    path: raw.paths?.[0],
    durationMs: raw.durationMs,
    additions,
    deletions,
    output: raw.output,
    outputType: raw.outputType,
    progress: raw.progress,
    tool,
    technical: raw.argsSummary,
    approval: raw.approval,
    timestamp: raw.ts ? new Date(raw.ts).toISOString() : new Date().toISOString(),
  }
}
