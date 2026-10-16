/**
 * Groq narration layer.
 *
 * Turns raw MCP tool events ("grep", "bash", "pwd && ls -la && git status")
 * into one plain sentence a non-engineer can read.
 *
 * Design constraints that shaped this:
 *  - Narration must NEVER block or delay the activity feed. Deterministic
 *    fallback text is stored for every event before the request goes out, so the
 *    transcript is always renderable; Groq only upgrades it.
 *  - The API key must not live in the renderer bundle, so the HTTP call happens
 *    in the main process (see electron/main.ts, the 'narration:describe' IPC
 *    handler). This also sidesteps page CSP, which blocked the old fetch.
 *  - Failures are surfaced through narrationStatus() instead of being swallowed,
 *    so a missing key or a rejected request is visible rather than silent.
 */

import type { AndroEvent } from './events'
import { bridge } from './bridge'

/**
 * Summarise a shell command into a short, human phrase.
 *
 * Raw commands like
 *   pwd && printf '\n--- top-level ---\n' && ls -la && git status --short --branch
 * are unreadable in a chat transcript, so they are reduced to what the command
 * is actually for. This is deliberately conservative: if nothing matches, it
 * says so generically rather than guessing wrong.
 */
function describeCommand(command: string): string {
  const c = command.toLowerCase()
  const parts: string[] = []

  // Longest/most specific patterns first so broad ones do not mask them.
  if (/\bgit\s+status\b/.test(c)) parts.push('checked which files changed')
  else if (/\bgit\s+diff\b/.test(c)) parts.push('reviewed the changes')
  else if (/\bgit\s+log\b/.test(c)) parts.push('reviewed recent commits')
  else if (/\bgit\s+(add|commit)\b/.test(c)) parts.push('saved the changes to git')
  else if (/\bgit\s+(clone|fetch|pull|push)\b/.test(c)) parts.push('synced with the remote repository')

  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b/.test(c) || /\bjest\b|\bvitest\b/.test(c))
    parts.push('ran the tests')
  else if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|compile)\b/.test(c) || /\btsc\b/.test(c))
    parts.push('built the project')
  else if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format)\b/.test(c) || /\beslint\b|\boxlint\b|\bprettier\b/.test(c))
    parts.push('checked code style')
  else if (/\b(npm|pnpm|yarn|bun)\s+(install|add|ci)\b/.test(c)) parts.push('installed dependencies')

  if (/\bls\b|\bfind\b|\btree\b/.test(c)) parts.push('listed the project files')
  else if (/\bcat\b|\bhead\b|\btail\b|\bless\b/.test(c)) parts.push('looked at file contents')
  else if (/\bwc\b/.test(c)) parts.push('counted lines')
  else if (/\b(mkdir|rm|mv|cp|touch)\b/.test(c)) parts.push('reorganised files')
  else if (/\bgrep\b|\brg\b|\bag\b/.test(c)) parts.push('searched the codebase')
  else if (/\bnode\b|\bpython\b|\btsx\b/.test(c)) parts.push('ran a quick script')

  if (/\bpwd\b/.test(c) && parts.length === 0) parts.push('checked the working directory')
  if (/\bwhich\b|\bcommand -v\b/.test(c)) parts.push('checked installed tools')
  if (/\bnode\s+-v|\bnode\s+--version/.test(c)) parts.push('checked the Node version')
  if (/\bcurl\b|\bwget\b/.test(c)) parts.push('fetched something from the network')

  if (parts.length === 0) return 'Ran a command in the project.'

  // Deduplicate while preserving order, then join naturally.
  //
  // No "Andro " prefix here: the transcript already renders an "Andro" speaker
  // label on every activity row, so prefixing the sentence too produced
  // "Andro | Andro checked which files changed" on each line.
  const unique = [...new Set(parts)]
  if (unique.length === 1) return `${capitalise(unique[0])}.`
  return `${capitalise(unique.slice(0, -1).join(', '))} and ${unique.at(-1)}.`
}

/** Sentence-case the first letter without touching the rest. */
function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Summarise what a command's output actually shows.
 *
 * Returns undefined when the output carries no clear signal, so the caller can
 * fall back to describing the action instead of inventing a result.
 */
function describeOutcome(event: AndroEvent): string | undefined {
  const raw = event.output
  if (!raw) return undefined
  const out = raw.replace(/\r/g, '').trim()
  if (!out) return undefined
  const lower = out.toLowerCase()

  // Explicit failure signals win over everything else.
  if (
    event.status === 'error' ||
    /\b(no such file|not found|command not found|permission denied|cannot|fatal:|traceback|error:|failed|failure|exception)\b/.test(lower)
  ) {
    return 'That step failed.'
  }
  if (/\b\d+\s+(failed|failing)\b/.test(lower)) return 'Some tests failed.'
  if (/\b(passed|passing|ok)\b/.test(lower) && /\b\d+\s+(passed|passing)\b/.test(lower)) {
    return 'The tests passed.'
  }
  if (/\b(build|compiled|bundled)\b/.test(lower) && /\b(success|complete|done|built)\b/.test(lower)) {
    return 'The build succeeded.'
  }
  // A diff means existing work was inspected.
  if (/^diff --git/m.test(out) || /^[+-]{3} /m.test(out)) return 'It found changes in the project.'
  // A file listing means structure was inspected.
  if (/^[-dl][rwx-]{9}\s/m.test(out) || /^total \d+/m.test(out)) {
    return 'It listed what is in the project.'
  }
  return undefined
}

/** Deterministic, dependency-free description. Always available. */
export function fallbackNarration(event: AndroEvent): string {
  const name = event.path?.split('/').pop()
  switch (event.kind) {
    case 'search':
      return event.detail ? `Searched the project for “${event.detail}”.` : 'Searched the project.'
    case 'read':
      return name ? `Read ${name} to understand the current code.` : 'Read project files.'
    case 'modify':
      return name ? `Updated ${name}.` : 'Updated a project file.'
    case 'write':
      return name ? `Created ${name}.` : 'Created a new project file.'
    case 'command': {
      // Prefer describing what the command actually returned over what it was.
      const outcome = describeOutcome(event)
      const action = event.detail ? describeCommand(event.detail) : 'Ran a project command.'
      if (!outcome) return action
      // Fold the outcome into the action sentence. No "Andro " prefix — the row
      // already carries an "Andro" speaker label.
      const base = action.replace(/\.$/, '')
      return `${base} — ${outcome.replace(/^That step failed\.$/, 'it failed')}`
    }
    default:
      return 'Worked on the project.'
  }
}

/** One-line category label, used as the transcript's speaker tag. */
export function categoryLabel(event: AndroEvent): string {
  switch (event.kind) {
    case 'search': return 'Searching'
    case 'read': return 'Reading'
    case 'modify': return 'Editing'
    case 'write': return 'Writing'
    case 'command': return 'Running'
    default: return 'Thinking'
  }
}

type Cache = Map<string, string>

const cache: Cache = new Map()

/** Last Groq outcome, surfaced in the UI so failures are not silent. */
export type NarrationStatus =
  | { state: 'idle' }
  | { state: 'pending' }
  | { state: 'ok'; count: number }
  | { state: 'off'; reason: string }

let lastStatus: NarrationStatus = { state: 'idle' }
const statusListeners = new Set<(s: NarrationStatus) => void>()

function setStatus(status: NarrationStatus) {
  lastStatus = status
  for (const listener of statusListeners) listener(status)
}

export function narrationStatus(): NarrationStatus {
  return lastStatus
}

export function onNarrationStatus(listener: (s: NarrationStatus) => void): () => void {
  statusListeners.add(listener)
  listener(lastStatus)
  return () => statusListeners.delete(listener)
}

/** Tail of captured output, enough for the model to judge the outcome. */
function outputExcerpt(output: string | undefined, limit = 900): string | undefined {
  if (!output) return undefined
  const cleaned = output.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trim()
  if (!cleaned) return undefined
  // Keep the END of the output: errors and final results appear last, and the
  // beginning is usually echoed command text.
  return cleaned.length > limit ? `…${cleaned.slice(-limit)}` : cleaned
}

/**
 * Compact description of a tool call, sent to Groq.
 *
 * Includes the command's ACTUAL OUTPUT, not just the command text. Without it
 * the model can only guess at the result from the invocation, which produces
 * narration like "ran the tests" when the tests in fact failed. The raw command
 * is passed as context only; the model is instructed never to echo it.
 */
function describe(event: AndroEvent) {
  const excerpt = outputExcerpt(event.output)
  return {
    action: event.kind,
    tool: event.tool,
    status: event.status,
    file: event.path,
    command: event.kind === 'command' ? event.detail?.slice(0, 200) : undefined,
    summary: event.kind === 'command' ? undefined : event.detail?.slice(0, 200),
    // What the command/tool actually produced, or the error it raised.
    error: event.status === 'error' ? event.detail?.slice(0, 300) : undefined,
    output: excerpt,
    outputType: excerpt ? event.outputType : undefined,
  }
}

/**
 * Fingerprint of everything that affects narration for an event.
 *
 * An event is re-narrated when this changes — which is what makes a command's
 * description update once its output arrives. Previously an event was narrated
 * exactly once and then cached forever, so a "started" event was described as
 * though its result were already known and never corrected.
 */
function narrationKey(event: AndroEvent): string {
  return [
    event.status,
    event.output ? event.output.length : 0,
    event.output ? event.output.slice(-64) : '',
    event.status === 'error' ? event.detail ?? '' : '',
  ].join('|')
}

/** Last fingerprint narrated per event id. */
const narratedAt = new Map<string, string>()

/**
 * Narrate a batch of events. Returns a map of event id -> sentence.
 *
 * Fallback text is stored for every event BEFORE the request goes out, so the
 * transcript is always renderable and never waits on the network. Groq merely
 * upgrades that text when it answers.
 */
export async function narrateBatch(events: AndroEvent[]): Promise<Record<string, string>> {
  // Re-narrate when an event's outcome data changes; skip when nothing has.
  const pending = events.filter(e => narratedAt.get(e.id) !== narrationKey(e))
  if (pending.length === 0) return Object.fromEntries(cache)

  // Seed deterministic fallbacks first, keyed by current state.
  for (const event of pending) {
    cache.set(event.id, fallbackNarration(event))
    narratedAt.set(event.id, narrationKey(event))
  }

  const api = bridge()
  if (!api?.describeActivity) {
    setStatus({ state: 'off', reason: 'Electron shell not running — using built-in descriptions.' })
    return Object.fromEntries(cache)
  }

  setStatus({ state: 'pending' })
  try {
    const items = Object.fromEntries(pending.map(e => [e.id, describe(e)]))
    const result = await api.describeActivity(items)

    if (!result.ok || !result.table) {
      setStatus({ state: 'off', reason: result.reason || 'Groq request failed.' })
      return Object.fromEntries(cache)
    }

    let applied = 0
    for (const [id, text] of Object.entries(result.table)) {
      if (typeof text === 'string' && text.trim()) {
        cache.set(id, text.trim())
        applied++
      }
    }
    setStatus({ state: 'ok', count: applied })
  } catch (error) {
    setStatus({
      state: 'off',
      reason: error instanceof Error ? error.message : 'Groq request failed.',
    })
  }

  return Object.fromEntries(cache)
}

/** Read narration for an id, falling back if Groq has not answered yet. */
export function narrationFor(event: AndroEvent, table: Record<string, string>): string {
  return table[event.id] || cache.get(event.id) || fallbackNarration(event)
}
