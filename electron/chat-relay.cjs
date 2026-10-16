/**
 * Preload for the ChatGPT WebContentsView.
 *
 * PURPOSE
 * -------
 * The DOM observer in main.ts runs inside the chatgpt.com page, which lives in
 * an isolated world with no access to Electron IPC. A preload script runs in a
 * privileged context attached to the same window, so it can receive the scraped
 * messages and forward them to the main process.
 *
 * SECURITY
 * --------
 * This is the only privileged code running alongside third-party page content,
 * so it deliberately exposes ONE function that forwards message text. It never
 * exposes `require`, `ipcRenderer`, or any other capability to page scripts, and
 * it validates the payload shape before forwarding.
 */
const { ipcRenderer, contextBridge } = require('electron')

const MAX_MESSAGES = 200
const MAX_TEXT = 20000

/** Coerce the scraped payload into a minimal, trusted shape. */
function sanitize(payload) {
  if (!payload || typeof payload !== 'object') return null
  const list = Array.isArray(payload.messages) ? payload.messages : null
  if (!list) return null

  const messages = []
  for (const item of list.slice(-MAX_MESSAGES)) {
    if (!item || typeof item !== 'object') continue
    const role = item.role === 'assistant' || item.role === 'user' ? item.role : null
    // An empty string is a legitimate value here: a reply that is still
    // streaming has no text yet, and the UI needs the turn to show progress.
    // Only reject a non-string.
    const text = typeof item.text === 'string' ? item.text.slice(0, MAX_TEXT) : null
    if (!role || text === null) continue
    messages.push({
      id: typeof item.id === 'string' ? item.id.slice(0, 200) : `${role}:${messages.length}`,
      role,
      text,
    })
  }
  return { messages, streaming: payload.streaming === true }
}

/**
 * Exposed via contextBridge, NOT by assigning to window directly.
 *
 * With contextIsolation on, this preload runs in an isolated world: assigning
 * to `window` here would be invisible to the page and to executeJavaScript,
 * which both run in the main world. That mismatch silently discarded every
 * scraped message. contextBridge is the supported bridge between the two.
 */
contextBridge.exposeInMainWorld('__androRelay', payload => {
  const safe = sanitize(payload)
  if (safe) ipcRenderer.send('chat:messages', safe)
})

/**
 * Error channel for the in-page observer.
 *
 * The observer's emit loop runs in a timer; without this, a throw inside it
 * would be invisible and look identical to "the page has no messages".
 */
contextBridge.exposeInMainWorld('__androRelayError', message => {
  ipcRenderer.send('chat:relay-error', String(message).slice(0, 300))
})
