import { useEffect, useMemo, useState } from 'react'
import {
  Search, FileCode2, Terminal, Zap, ChevronDown, ChevronRight, Loader2,
  CircleAlert, Pencil, FilePlus2, Sparkles,
} from 'lucide-react'
import type { AndroEvent, EventKind } from './events'
import type { ChatMessage } from './bridge'
import {
  categoryLabel, narrationFor, narrateBatch, onNarrationStatus,
  type NarrationStatus,
} from './narration'

const iconFor: Record<EventKind, typeof Search> = {
  search: Search,
  read: FileCode2,
  write: FilePlus2,
  modify: Pencil,
  command: Terminal,
  thinking: Zap,
}

/**
 * Chat transcript of agent activity.
 *
 * Deliberately NOT a boxed log table. This renders as a conversation:
 *   - user prompts are right-aligned bubbles (your side of the exchange),
 *   - agent work is left-aligned, borderless, and flows as narration prose,
 *   - tool detail is folded away behind a quiet disclosure so the default read
 *     is "what is happening", not "which syscall ran".
 *
 * Everything is a flex column of rows on a transparent background; the parent
 * provides the surface, so there is no nested card-in-card look.
 */

/** A prompt the user sent, rendered as the right-hand turn in the transcript. */
type UserTurn = { id: string; text: string; timestamp: string }

type Turn =
  | { role: 'user'; at: number; seq: number; data: UserTurn }
  | { role: 'agent'; at: number; seq: number; data: AndroEvent }
  | { role: 'assistant'; at: number; seq: number; data: ChatMessage }

/**
 * Build the transcript in strict chronological order, oldest at the top.
 *
 * Ordering rules that matter here:
 *  - Ascending by timestamp, so reading top-to-bottom follows the session from
 *    its first step to its latest.
 *  - Ties break by arrival sequence, not by sort stability. Tool calls fired in
 *    the same millisecond would otherwise be able to swap places between
 *    renders as their statuses update.
 */
function buildTurns(
  events: AndroEvent[],
  prompts: UserTurn[],
  chat: ChatMessage[],
): Turn[] {
  const turns: Turn[] = [
    ...events.map((e, i) => ({
      role: 'agent' as const,
      at: new Date(e.timestamp).getTime(),
      seq: i,
      data: e,
    })),
    ...prompts.map((p, i) => ({
      role: 'user' as const,
      at: new Date(p.timestamp).getTime(),
      seq: 1_000_000 + i,
      data: p,
    })),
    // ChatGPT's replies are ordered by their position in the page, not by a
    // timestamp — the scraped message carries none. A seq offset places them
    // after local prompts but keeps them in conversation order.
    ...chat.map((m, i) => ({
      role: 'assistant' as const,
      at: Number.MAX_SAFE_INTEGER,
      seq: 2_000_000 + i,
      data: m,
    })),
  ]
  return turns.sort((a, b) => a.at - b.at || a.seq - b.seq)
}

function ToolDetail({ event }: { event: AndroEvent }) {
  const lines = event.output?.replace(/\r/g, '').split('\n').filter(Boolean).slice(-60) || []
  return (
    <div className="turn-detail">
      {event.path && (
        <div className="turn-detail-row">
          <span>file</span>
          <code>{event.path}</code>
        </div>
      )}
      {event.technical && (
        <div className="turn-detail-row">
          <span>call</span>
          <code>{event.technical}</code>
        </div>
      )}
      {(event.additions || event.deletions) && (
        <div className="turn-detail-row">
          <span>diff</span>
          <code className="diff-count"><b>+{event.additions || 0}</b> <i>−{event.deletions || 0}</i></code>
        </div>
      )}
      {lines.length > 0 && <pre className="turn-output">{lines.join('\n')}</pre>}
    </div>
  )
}

function AgentTurn({
  event,
  narration,
  compact,
}: {
  event: AndroEvent
  narration: string
  compact: boolean
}) {
  const [open, setOpen] = useState(false)
  const Icon = iconFor[event.kind] || Zap
  const hasDetail = Boolean(event.path || event.technical || event.output || event.additions)

  return (
    <div className={`turn agent ${event.status}`}>
      <div className="turn-gutter">
        <span className={`turn-icon ${event.status}`}>
          {event.status === 'running' ? <Loader2 size={13} className="spin" /> : <Icon size={13} />}
        </span>
      </div>
      <div className="turn-body">
        <div className="turn-meta">
          <span className="turn-speaker">Andro</span>
          <span className="turn-kind">{categoryLabel(event)}</span>
          {event.durationMs !== undefined && event.status === 'complete' && (
            <span className="turn-duration">{(event.durationMs / 1000).toFixed(1)}s</span>
          )}
          {event.status === 'error' && (
            <span className="turn-error-tag"><CircleAlert size={10} /> failed</span>
          )}
        </div>

        {/* The prose line: what happened, in plain language. */}
        <p className="turn-text">{narration}</p>

        {/* Technical detail stays available but collapsed by default. */}
        {hasDetail && !compact && (
          <>
            <button className="turn-disclosure" type="button" onClick={() => setOpen(v => !v)}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {open ? 'Hide details' : 'Details'}
            </button>
            {open && <ToolDetail event={event} />}
          </>
        )}
      </div>
    </div>
  )
}

function UserTurnRow({ turn }: { turn: UserTurn }) {
  return (
    <div className="turn user">
      <div className="bubble">{turn.text}</div>
    </div>
  )
}

/**
 * A ChatGPT reply, rendered as the assistant's own turn.
 *
 * Visually distinct from tool activity ("Andro" rows): these carry the model's
 * prose, so they read as conversation rather than as a log line. Rendered as
 * plain text by design — the content is arbitrary model output and must not be
 * interpreted as HTML.
 */
function AssistantTurn({ message }: { message: ChatMessage }) {
  return (
    <div className="turn assistant">
      <div className="turn-gutter">
        <span className="turn-icon assistant">
          <Sparkles size={13} />
        </span>
      </div>
      <div className="turn-body">
        <div className="turn-meta">
          <span className="turn-speaker">ChatGPT</span>
        </div>
        {/* An empty reply means it is still being written. Show that rather
            than rendering a blank turn, which looks like a bug. */}
        {message.text ? (
          <div className="turn-answer">{message.text}</div>
        ) : (
          <div className="turn-pending">
            <Loader2 size={11} className="spin" /> ChatGPT is replying…
          </div>
        )}
      </div>
    </div>
  )
}

export function Transcript({
  events,
  prompts,
  chat = [],
  compact = false,
  className = '',
}: {
  events: AndroEvent[]
  prompts: UserTurn[]
  /** Messages scraped from the ChatGPT page, shown as assistant turns. */
  chat?: ChatMessage[]
  compact?: boolean
  className?: string
}) {
  const [narration, setNarration] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<NarrationStatus>({ state: 'idle' })
  const turns = useMemo(() => buildTurns(events, prompts, chat), [events, prompts, chat])

  // Ask Groq to narrate newly arrived events. Failures are non-fatal:
  // fallbackNarration already covers every event, so the transcript never
  // blocks on the network — but the outcome is shown rather than swallowed.
  useEffect(() => {
    if (events.length === 0) return
    const timer = setTimeout(() => {
      void narrateBatch(events.slice(-40)).then(table => setNarration(table))
    }, 400)
    return () => clearTimeout(timer)
  }, [events])

  useEffect(() => onNarrationStatus(setStatus), [])

  if (turns.length === 0) {
    return (
      <div className={`transcript-empty ${className}`}>
        <Sparkles size={18} />
        <p>Ready when you are.</p>
        <small>
          Ask ChatGPT to work on the project. Every search, read and edit shows up here as it
          happens.
        </small>
      </div>
    )
  }

  return (
    <div className={`transcript ${compact ? 'compact' : ''} ${className}`}>
      {turns.map(turn =>
        turn.role === 'user' ? (
          <UserTurnRow key={turn.data.id} turn={turn.data} />
        ) : turn.role === 'assistant' ? (
          <AssistantTurn key={`assistant-${turn.data.id}`} message={turn.data} />
        ) : (
          <AgentTurn
            key={turn.data.id}
            event={turn.data}
            narration={narrationFor(turn.data, narration)}
            compact={compact}
          />
        ),
      )}
      {/*
        Narration provenance. Making this visible matters: without it a missing
        key or a rejected request is indistinguishable from Groq simply being
        quiet, which is how the key silently never being configured went
        unnoticed.
      */}
      {status.state === 'ok' && (
        <div className="transcript-foot">Narration by Groq</div>
      )}
      {status.state === 'pending' && (
        <div className="transcript-foot">Describing with Groq…</div>
      )}
      {status.state === 'off' && (
        <div className="transcript-foot warn" title={status.reason}>
          <CircleAlert size={10} /> Built-in descriptions — {status.reason}
        </div>
      )}
    </div>
  )
}

export type { UserTurn }
