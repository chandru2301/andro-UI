/**
 * Typed contract between the Andro renderer (this React app) and the Electron
 * main process that will host the native ChatGPT WebContentsView.
 *
 * Phase 1 (now):  Electron is not installed. `window.andro` is undefined and the
 *                 UI renders in "browser preview" mode against the same contract,
 *                 so the layout can be reviewed before any native code exists.
 * Phase 2 (next): electron/preload.ts satisfies this interface over IPC and the
 *                 placeholder surface is replaced by the real docked view.
 *
 * Keeping this as the single source of truth means the layout work is not
 * throwaway: the component tree does not change when the native layer lands.
 */

/** Rect in CSS pixels, relative to the BrowserWindow's content area. */
export type DockRect = { x: number; y: number; width: number; height: number }

/** A message lifted out of the ChatGPT page. */
export type ChatMessage = {
  id: string
  role: 'assistant' | 'user'
  text: string
}

/** Where the ChatGPT view currently is, and whether it is usable. */
export type ChatSurfaceState = {
  /** False until the chatgpt.com view has finished a successful first load. */
  ready: boolean
  /** True while a navigation/login/Cloudflare challenge is in flight. */
  loading: boolean
  /** Last navigation or load failure, if any. */
  error?: string
  /** Current URL, for display only. */
  url?: string
}

export type AndroBridge = {
  version: 1

  /**
   * Report the rectangle the native view must occupy. The renderer measures its
   * own placeholder element and sends the result here; main process resizes the
   * WebContentsView to match. Called on mount and on every geometry change.
   */
  dockChatSurface: (rect: DockRect) => void

  /** Hide the native view entirely (used when the chat pane is collapsed). */
  hideChatSurface: () => void

  /**
   * Send a prompt into the real chatgpt.com page and submit it.
   *
   * Best-effort by contract: returns ok:false rather than throwing when the
   * page's DOM does not match expectations, because ChatGPT markup is not a
   * stable API and Cloudflare/React changes can break it at any time.
   */
  submitPrompt: (text: string) => Promise<{ ok: boolean; reason?: string }>

  /** Open a TypeScript file from the active project for viewing/editing. */
  readSourceFile: (path: string) => Promise<{ ok: boolean; content?: string; reason?: string }>

  /** Persist edits back to disk. */
  writeSourceFile: (path: string, content: string) => Promise<{ ok: boolean; reason?: string }>

  /**
   * Narrate tool calls in plain English via Groq.
   *
   * Runs in the main process so the API key stays out of the renderer bundle.
   * `items` maps an event id to a compact description of the tool call; the
   * result maps the same ids to short sentences.
   */
  describeActivity: (
    items: Record<string, unknown>,
  ) => Promise<{ ok: boolean; table?: Record<string, string>; reason?: string }>

  /** Subscribe to chat surface state changes. Returns an unsubscribe function. */
  onChatSurfaceState: (listener: (state: ChatSurfaceState) => void) => () => void

  /**
   * Subscribe to messages scraped from the ChatGPT page.
   *
   * This is how the actual assistant replies reach the UI: the chat view's
   * preload relays them out of the page DOM, through the main process, to here.
   * `streaming` is true while a response is still being generated.
   */
  onChatMessages: (
    listener: (payload: { messages: ChatMessage[]; streaming: boolean }) => void,
  ) => () => void
}

declare global {
  interface Window {
    /** Present only when running inside the Electron shell. */
    andro?: AndroBridge
  }
}

/** True when hosted by Electron with a functioning preload bridge. */
export const hasNativeBridge = (): boolean =>
  typeof window !== 'undefined' && typeof window.andro?.dockChatSurface === 'function'

/**
 * Access the bridge, or undefined in browser-preview mode. Components should
 * branch on this rather than assuming the native layer exists.
 */
export const bridge = (): AndroBridge | undefined =>
  hasNativeBridge() ? window.andro : undefined
