import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity, ChevronDown, ChevronRight, CircleAlert, FileCode2, FolderGit2,
  GitBranch, Globe, History, XCircle, Plus, Minimize2, Maximize2,
} from 'lucide-react'
import './App.css'
import { ChatSurface } from './ChatSurface'
import { PromptBar } from './PromptBar'
import { SourcePanel } from './SourcePanel'
import { Transcript, type UserTurn } from './Transcript'
import { bridge, type ChatMessage } from './bridge'
import { normalizeEvent, type AndroEvent, type ChangedFile, type RawActivityEvent } from './events'

/**
 * Content width preference.
 *
 * "wide" removes the 1060px cap so the transcript and source panel fill the
 * window — useful on wide displays where the default column wastes space. The
 * choice persists across restarts.
 */
const WIDE_KEY = 'andro.contentWide'
const STANDARD_WIDTH = 1060
const WIDE_WIDTH = 1800

function readStoredWide(): boolean {
  try {
    return localStorage.getItem(WIDE_KEY) === 'true'
  } catch {
    return false
  }
}

function App() {
  const [events, setEvents] = useState<AndroEvent[]>([])
  const [prompts, setPrompts] = useState<UserTurn[]>([])
  const [connected, setConnected] = useState(false)
  const [selected, setSelected] = useState('activity')
  const [project] = useState('andromedia')
  const [files, setFiles] = useState<ChangedFile[]>([])
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [wide, setWide] = useState(readStoredWide)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const endpoint =
      (import.meta.env.VITE_ANDRO_EVENTS_URL as string | undefined) ||
      'http://127.0.0.1:8787/activity/events-ui'
    const source = new EventSource(endpoint)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    source.onmessage = message => {
      try {
        const raw = JSON.parse(message.data) as RawActivityEvent & { type?: string }
        if (raw.type === 'ready') return
        const event = normalizeEvent(raw)
        setEvents(current => {
          const index = current.findIndex(item => item.id === event.id)
          // Update in place when the event already exists. Removing and
          // re-appending would move a turn to the bottom of the transcript
          // every time its status changed (started -> ok), which made the
          // chat appear to reorder itself.
          if (index !== -1) {
            const existing = current[index]
            const output =
              existing.output && event.output
                ? `${existing.output}${event.output}`.slice(-30000)
                : event.output || existing.output
            const next = [...current]
            next[index] = { ...existing, ...event, output }
            return next
          }
          return [...current, event].slice(-500)
        })
        if (event.path && (event.kind === 'modify' || event.kind === 'write')) {
          setFiles(current => {
            const type = event.changeType || (event.kind === 'write' ? 'A' : 'M')
            const next = {
              path: event.path!,
              type,
              additions: event.additions || 0,
              deletions: event.deletions || 0,
            }
            return [...current.filter(file => file.path !== next.path), next]
          })
        }
      } catch {
        /* ignore malformed events */
      }
    }
    return () => source.close()
  }, [])

  // Test hook: lets the Electron smoke test inject synthetic activity so the
  // transcript can be verified without a running MCP server.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<RawActivityEvent[]>).detail
      if (!Array.isArray(detail)) return
      setEvents(detail.map(normalizeEvent))
      setPrompts([{ id: 'p-smoke', text: 'Add auth to the login flow', timestamp: new Date(Date.now() - 12000).toISOString() }])
    }
    window.addEventListener('andro:smoke-events', handler)
    return () => window.removeEventListener('andro:smoke-events', handler)
  }, [])

  // Apply and persist the width preference. Setting the CSS variable on the
  // root element keeps the layout rule in CSS and the choice in React.
  useEffect(() => {
    const width = wide ? WIDE_WIDTH : STANDARD_WIDTH
    document.documentElement.style.setProperty('--andro-content-width', `${width}px`)
    try {
      localStorage.setItem(WIDE_KEY, String(wide))
    } catch {
      /* storage unavailable */
    }
  }, [wide])

  // Mirror ChatGPT's actual replies into the local transcript. These come from
  // the chat view's DOM via the relay preload, so they are authoritative.
  useEffect(() => {
    const api = bridge()
    if (!api?.onChatMessages) return
    return api.onChatMessages(payload => setChat(payload.messages))
  }, [])

  // Keep the newest turn in view, like a chat.
  // Follow new turns downward, but only when the reader is already at the
  // bottom. Scrolling unconditionally would yank the view away from anyone
  // reading earlier steps, and made the transcript feel like it was running
  // bottom-to-top.
  const pinnedRef = useRef(true)
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    pinnedRef.current = distance < 80
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [events.length, prompts.length])

  // Switch to/from the ChatGPT page with Cmd/Ctrl+J. Skipped while typing in the
  // composer so the shortcut never swallows a keystroke meant for the prompt.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'j') return
      const target = e.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      e.preventDefault()
      setSelected(current => (current === 'chat' ? 'activity' : 'chat'))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** Record a prompt locally so it appears as the user's turn in the transcript. */
  const recordPrompt = useCallback((text: string) => {
    setPrompts(current => [
      ...current,
      { id: crypto.randomUUID(), text, timestamp: new Date().toISOString() },
    ])
  }, [])

  const running = events.some(e => e.status === 'running')
  const sessions = useMemo(() => {
    const ordered = [...events].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    )
    const groups: AndroEvent[][] = []
    for (const event of ordered) {
      const last = groups.at(-1)
      const previous = last?.at(-1)
      const gap = previous
        ? new Date(event.timestamp).getTime() - new Date(previous.timestamp).getTime()
        : Infinity
      if (!last || !previous || gap > 5 * 60 * 1000) groups.push([event])
      else last.push(event)
    }
    return groups.reverse()
  }, [events])

  const changedCount = events.filter(e => e.kind === 'modify' || e.kind === 'write').length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>Andro</span>
          <span className="beta">LIVE</span>
        </div>
        <div className="side-label">PROJECT</div>
        <button className="project-switcher">
          <FolderGit2 size={15} />
          <span>{project}</span>
          <ChevronDown size={13} />
        </button>
        <nav className="side-nav">
          <button
            className={selected === 'activity' ? 'active' : ''}
            onClick={() => setSelected('activity')}
          >
            <Activity size={15} /> Session
          </button>
          {/*
            ChatGPT has its own page so the native view can fill the workspace.
            Keeping it on the Session page forced a choice between a cramped
            chat panel and a cramped transcript; separating them gives each the
            full height.
          */}
          <button
            className={selected === 'chat' ? 'active' : ''}
            onClick={() => setSelected('chat')}
          >
            <Globe size={15} /> ChatGPT
          </button>
          <button
            className={selected === 'files' ? 'active' : ''}
            onClick={() => setSelected('files')}
          >
            <FileCode2 size={15} /> Changed files <span>{files.length}</span>
          </button>
          <button
            className={selected === 'history' ? 'active' : ''}
            onClick={() => setSelected('history')}
          >
            <History size={15} /> Sessions <span>{sessions.length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection">
            <span className={`connection-dot ${connected ? 'online' : ''}`} />
            <span>{connected ? 'Live connection' : 'Waiting for Andro'}</span>
          </div>
          <div className="side-meta">
            <GitBranch size={13} /> main
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="crumb">ANDRO</span>
            <ChevronRight size={13} />
            <span>{project}</span>
          </div>
          <div className="top-status">
            {/*
              Content width control. `wide` lets the transcript and source panel
              use the full window, which matters on ultrawide displays where the
              default 1060px column wastes most of the screen.
            */}
            <div className="width-control" role="group" aria-label="Content width">
              <button
                type="button"
                className={wide ? '' : 'active'}
                onClick={() => setWide(false)}
                title="Standard width"
                aria-pressed={!wide}
              >
                <Minimize2 size={12} />
              </button>
              <button
                type="button"
                className={wide ? 'active' : ''}
                onClick={() => setWide(true)}
                title="Full width"
                aria-pressed={wide}
              >
                <Maximize2 size={12} />
              </button>
            </div>
            <button
              className="top-toggle"
              type="button"
              onClick={() => setSelected(selected === 'chat' ? 'activity' : 'chat')}
              title={selected === 'chat' ? 'Back to session (⌘/Ctrl+J)' : 'Open ChatGPT page (⌘/Ctrl+J)'}
            >
              {selected === 'chat' ? <Activity size={13} /> : <Globe size={13} />}
              {selected === 'chat' ? 'Session' : 'ChatGPT'}
            </button>
            <span className={`pulse ${running ? 'running' : ''}`} />
            {running ? 'Working now' : 'Ready'}
          </div>
        </header>

        {/*
          ChatGPT page: the native view fills the workspace.

          The surface unmounts when navigating away — see ChatSurface's effect
          cleanup, which calls hideChatSurface(). Without that the native
          WebContentsView would stay docked and float over whichever page you
          switched to, since it is not part of the DOM.
        */}
        {selected === 'chat' && (
          <div className="chat-page">
            <ChatSurface fill hidden={false} onClose={() => setSelected('activity')} />
            <PromptBar onSent={recordPrompt} />
          </div>
        )}

        {selected !== 'chat' && (
        <div className="content">
          <section className="session-header">
            <div>
              <div className="eyebrow">AGENT SESSION</div>
              <h1>
                {running
                  ? 'Andro is working'
                  : events.length
                    ? 'Session complete'
                    : 'Ready for work'}
              </h1>
              <p>
                {running
                  ? 'Working through your request. Each step appears below as it happens.'
                  : events.length
                    ? `${events.length} steps · ${changedCount} file changes`
                    : 'Your conversation with the agent appears here.'}
              </p>
            </div>
            <div className="session-id">
              <span>SESSION</span>
              <code>{events.length ? `${events.length} steps` : '—'}</code>
            </div>
          </section>

          <div className="layout">
            {selected === 'activity' && (
              <section className="chat-column">
                <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
                  <Transcript events={events} prompts={prompts} chat={chat} />
                </div>
              </section>
            )}

            {selected === 'files' && (
              <section className="list-column">
                {files.length ? (
                  files.map(f => (
                    <div className="file-row" key={f.path}>
                      <span className={`file-type ${f.type}`}>{f.type}</span>
                      <FileCode2 size={14} />
                      <code>{f.path}</code>
                      <span className="file-diff">
                        +{f.additions} −{f.deletions}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <FileCode2 size={20} />
                    <span>No files changed yet.</span>
                  </div>
                )}
              </section>
            )}

            {selected === 'history' && (
              <section className="list-column">
                {sessions.length ? (
                  sessions.map((session, index) => (
                    <div className="session-card" key={session[0].id}>
                      <div className="session-card-head">
                        <History size={13} />
                        <span>Session {sessions.length - index}</span>
                        <em>{session.length} steps</em>
                      </div>
                      <div className="session-card-meta">
                        <span>{new Date(session[0].timestamp).toLocaleString()}</span>
                        <span>
                          {session.filter(e => e.kind === 'modify' || e.kind === 'write').length}{' '}
                          changes
                        </span>
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="empty-state">
                    <History size={20} />
                    <span>No sessions yet.</span>
                  </div>
                )}
              </section>
            )}

            <SourcePanel files={files} />
          </div>

          {/*
            The composer also lives on the Session page, so a prompt can be sent
            without switching pages. It only appears on the transcript view:
            sending a prompt while looking at a file list would be surprising.
          */}
          {selected === 'activity' && (
            <div className="session-composer">
              <PromptBar onSent={recordPrompt} />
            </div>
          )}
        </div>
        )}

        <footer className="statusbar">
          <span>
            <span className={`status-green ${connected ? '' : 'offline'}`} /> MCP bridge
          </span>
          <span>Live execution protocol</span>
          <span className="status-spacer" />
          <span>{events.filter(e => e.status === 'complete').length} completed</span>
          {events.some(e => e.status === 'error') && (
            <span className="error-text">
              <CircleAlert size={12} /> errors
            </span>
          )}
          <span className="status-stat">
            <Plus size={10} /> {changedCount}
          </span>
          <XCircle size={13} />
        </footer>
      </main>
    </div>
  )
}

export default App
