import { Globe, CornerUpLeft } from 'lucide-react'

/**
 * Reopen affordance for the closed ChatGPT panel.
 *
 * When the panel is closed the whole chat region unmounts, so the space above
 * the status bar goes back to the transcript. That leaves nothing on screen to
 * click, which is a dead end unless you remember the topbar toggle — so this
 * slim bar takes its place and is the obvious way back.
 *
 * It deliberately occupies a small fixed strip rather than floating over the
 * transcript, keeping the layout simple and the transcript fully readable.
 */
export function ChatReopenBar({ onOpen }: { onOpen: () => void }) {
  return (
    <button className="chat-reopen" type="button" onClick={onOpen} title="Open ChatGPT (⌘/Ctrl+J)">
      <Globe size={13} />
      <span>ChatGPT closed</span>
      <span className="chat-reopen-hint">
        <CornerUpLeft size={11} /> Open
      </span>
      <kbd>⌘/Ctrl J</kbd>
    </button>
  )
}
