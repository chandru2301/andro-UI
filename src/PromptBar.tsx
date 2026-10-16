import { useEffect, useRef, useState } from 'react'
import { ArrowUp, Paperclip, Square, Loader2, Ban } from 'lucide-react'
import { bridge } from './bridge'

/**
 * Andro-owned prompt bar.
 *
 * This deliberately lives OUTSIDE the native chat rectangle. Because the
 * WebContentsView composites above all HTML, any control placed inside the chat
 * region would be covered and unclickable. Keeping the composer here means we
 * fully own its look, feel, shortcuts and state, while the canonical
 * conversation still lives in the real chatgpt.com page above it.
 *
 * Submission is best-effort by design: ChatGPT's DOM is not a stable API, so a
 * failed submit surfaces an inline reason instead of throwing or silently
 * pretending the message was sent.
 */
export function PromptBar({ disabled, onSent }: { disabled?: boolean; onSent?: (text: string) => void }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const native = Boolean(bridge())

  // Auto-grow the composer up to a sane ceiling, then scroll internally.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 168)}px`
  }, [value])

  const send = async () => {
    const text = value.trim()
    if (!text || busy) return
    const api = bridge()
    setError(null)

    if (!api) {
      setError('Electron shell not running — prompt not delivered.')
      return
    }

    setBusy(true)
    try {
      const result = await api.submitPrompt(text)
      if (result.ok) {
        setValue('')
        // Record it so the transcript shows the user's side of the exchange.
        onSent?.(text)
      } else setError(result.reason || 'Could not reach the ChatGPT composer.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Prompt delivery failed.')
    } finally {
      setBusy(false)
    }
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter inserts a newline. Matches ChatGPT's own muscle memory.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <div className="prompt-bar">
      {error && (
        <div className="prompt-error" role="alert">
          <Ban size={12} />
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}
      <div className={`prompt-shell ${busy ? 'busy' : ''}`}>
        <button className="prompt-attach" type="button" title="Attach project file (phase 2)" disabled>
          <Paperclip size={15} />
        </button>
        <textarea
          ref={textareaRef}
          className="prompt-input"
          rows={1}
          value={value}
          placeholder="Message ChatGPT…"
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={disabled}
        />
        <div className="prompt-actions">
          <span className="prompt-hint">
            <kbd>Enter</kbd> send · <kbd>Shift</kbd>+<kbd>Enter</kbd> newline
          </span>
          <button
            className="prompt-send"
            type="button"
            onClick={() => void send()}
            disabled={!value.trim() || busy || disabled}
            title={native ? 'Send to ChatGPT' : 'Requires the Electron shell'}
          >
            {busy ? <Loader2 size={14} className="spin" /> : <ArrowUp size={15} />}
          </button>
        </div>
      </div>
      <div className="prompt-foot">
        <span className={`prompt-link ${native ? 'live' : ''}`}>
          <span className="prompt-link-dot" />
          {native ? 'Driving chatgpt.com' : 'Standalone preview'}
        </span>
        <span className="prompt-foot-spacer" />
        <span className="prompt-model">ChatGPT web · best-effort DOM bridge</span>
      </div>
    </div>
  )
}

/** Exported for the phase-2 stop control once streaming state is bridged. */
export function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <button className="prompt-send" type="button" onClick={onStop} title="Stop generating">
      <Square size={13} />
    </button>
  )
}
