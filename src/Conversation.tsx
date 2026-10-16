import { useEffect, useRef, useState } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { bridge, hasNativeBridge, type ChatMessage } from './bridge'

/**
 * The actual ChatGPT conversation, mirrored into Andro's own UI.
 *
 * Messages are scraped from the chatgpt.com page by a DOM observer and relayed
 * through the main process (see electron/chat-relay.cjs). This component only
 * renders them.
 *
 * Rendering is deliberately plain text: the source is arbitrary model output,
 * and injecting it as HTML would be an XSS vector. Paragraph breaks are
 * preserved with whitespace-pre-wrap instead.
 */
export function Conversation({ onMessages }: { onMessages?: (messages: ChatMessage[]) => void }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinnedRef = useRef(true)
  const native = hasNativeBridge()

  useEffect(() => {
    const api = bridge()
    if (!api?.onChatMessages) return
    return api.onChatMessages(payload => {
      setMessages(payload.messages)
      setStreaming(payload.streaming)
      onMessages?.(payload.messages)
    })
    // onMessages is intentionally not a dependency: re-subscribing on every
    // render would drop messages.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Follow the response as it streams, but only while the reader is at the
  // bottom — otherwise scrolling back would keep yanking them forward.
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight
  }, [messages, streaming])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  if (!native) {
    return (
      <div className="conversation-empty">
        <Sparkles size={18} />
        <p>ChatGPT replies appear here</p>
        <small>Run inside the Electron shell to mirror the conversation.</small>
      </div>
    )
  }

  if (messages.length === 0) {
    return (
      <div className="conversation-empty">
        <Sparkles size={18} />
        <p>No messages yet</p>
        <small>Send a prompt and ChatGPT's reply will appear here as it is written.</small>
      </div>
    )
  }

  return (
    <div className="conversation" ref={scrollRef} onScroll={onScroll}>
      <div className="conversation-inner">
        {messages.map(message => (
          <div className={`msg ${message.role}`} key={message.id}>
            <div className="msg-role">
              {message.role === 'assistant' ? 'ChatGPT' : 'You'}
            </div>
            <div className="msg-text">{message.text}</div>
          </div>
        ))}
        {streaming && (
          <div className="msg-status">
            <Loader2 size={11} className="spin" /> ChatGPT is writing…
          </div>
        )}
      </div>
    </div>
  )
}
