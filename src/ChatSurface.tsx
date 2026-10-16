import { useEffect, useRef, useState } from 'react'
import { Globe, Loader2, ExternalLink, AlertTriangle, X } from 'lucide-react'
import { bridge, hasNativeBridge, type ChatSurfaceState, type DockRect } from './bridge'

/**
 * Reserved rectangle for the native ChatGPT WebContentsView.
 *
 * IMPORTANT ARCHITECTURAL NOTE
 * ----------------------------
 * The real chatgpt.com view is a native layer composited by the OS *above* the
 * entire HTML document. It cannot be rendered inside this element, and this
 * element's DOM can never paint on top of it. What this component actually does
 * is:
 *
 *   1. Occupy the exact region the native view should cover.
 *   2. Measure that region and hand the rectangle to the main process, which
 *      resizes/repositions the WebContentsView to match.
 *   3. Render a dev-only placeholder so the layout is reviewable in a plain
 *      browser before Electron exists.
 *
 * Consequence to respect when styling: anything drawn in this region is
 * INVISIBLE in the packaged app. Never place Andro controls here. The prompt bar
 * lives *below* this element, outside the native rect, precisely so it stays
 * visible and interactive.
 */
/** Smallest draggable height: enough for the chrome bar plus the drag handle. */
const MIN_SURFACE_HEIGHT = 56
const HEIGHT_KEY = 'andro.chatSurfaceHeight'

function readStoredHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY)
    const value = raw ? Number(raw) : NaN
    if (Number.isFinite(value)) return Math.max(MIN_SURFACE_HEIGHT, Math.round(value))
  } catch {
    /* storage unavailable */
  }
  return 300
}

export function ChatSurface({ hidden, onClose, fill = false }: {
  hidden: boolean
  onClose: () => void
  /** Grow to fill the container instead of using the dragged height. */
  fill?: boolean
}) {
  /** Outer wrapper: chrome bar + surface + resize handle. Not measured. */
  const hostRef = useRef<HTMLDivElement>(null)
  /** The measured rect. This is what the native view is docked over. */
  const surfaceRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<ChatSurfaceState>({ ready: false, loading: false })
  const [height, setHeight] = useState(readStoredHeight)
  // Derived during render: the bridge either exists or it does not, and it does
  // not change over the life of the page.
  const native = hasNativeBridge()

  // Remember the chosen height across restarts.
  useEffect(() => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(height))
    } catch {
      /* storage unavailable */
    }
  }, [height])

  useEffect(() => {
    const api = bridge()
    if (!api) return
    return api.onChatSurfaceState(setState)
  }, [])

  useEffect(() => {
    const api = bridge()
    const host = surfaceRef.current
    if (!api || !host) return

    // While hidden the region has zero height, so there is no valid rect to
    // report. Tell the main process to hide the native view and stop observing;
    // the resize loop below would otherwise fight over a collapsed box.
    if (hidden) {
      api.hideChatSurface()
      return
    }

    const report = () => {
      // Measure the SURFACE, not the outer host: the host also contains the
      // chrome bar and resize handle, which must stay outside the native rect.
      const r = host.getBoundingClientRect()
      const rect: DockRect = {
        x: Math.round(r.left),
        y: Math.round(r.top),
        width: Math.round(r.width),
        height: Math.round(r.height),
      }
      if (rect.width > 0 && rect.height > 0) api.dockChatSurface(rect)
    }

    report()
    // Re-report on the next frame. On mount the element can still measure 0 or
    // 1px, in which case report() correctly skips — but React StrictMode runs
    // effect -> cleanup -> effect, and that cleanup sends hideChatSurface().
    // Without a deferred re-report, the LAST message is the hide, leaving the
    // native view invisible on a page that is visibly showing the surface.
    const raf = requestAnimationFrame(report)

    // The native view does not reflow with CSS, so it must be told about every
    // geometry change: window resize, sidebar toggles, panel drags, zoom.
    const observer = new ResizeObserver(report)
    observer.observe(host)
    window.addEventListener('resize', report)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', report)
      // Hide only when this teardown represents actually going away.
      //
      // This cleanup also runs on ordinary re-renders (the effect re-runs when
      // height or fill changes) and in StrictMode's mount/unmount/mount cycle.
      // Hiding unconditionally there sent a `chat:hide` AFTER the new effect had
      // already docked, so the last message the main process saw was "hide" and
      // the native view stayed invisible on a page that was showing it.
      if (hidden) api.hideChatSurface()
    }
  }, [hidden, height, fill])

  /**
   * Hide the native view when this component truly unmounts.
   *
   * Kept separate from the docking effect on purpose. That effect's cleanup also
   * runs on ordinary re-renders, so hiding there raced with the re-dock and left
   * the view invisible. This effect has an empty dependency list, so its cleanup
   * runs only on real unmount — which is exactly when the native view (which
   * outlives the renderer) must be hidden or it would float over another page.
   */
  useEffect(() => {
    const api = bridge()
    if (!api) return
    return () => api.hideChatSurface()
  }, [])

  /**
   * Drag-to-resize.
   *
   * The floor is 56px, not 0: at true zero the native WebContentsView would be
   * docked to a zero-height rect and the drag handle would be unreachable, so
   * the panel could never be brought back by dragging. 56px keeps the chrome
   * bar and handle on screen. Use the × button or Ctrl+J to collapse fully.
   */
  const startResize = (event: React.PointerEvent) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = height
    const onMove = (e: PointerEvent) => {
      const next = startHeight + (startY - e.clientY)
      const ceiling = Math.round(window.innerHeight * 0.62)
      setHeight(Math.max(MIN_SURFACE_HEIGHT, Math.min(ceiling, next)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div className="chat-surface-host" ref={hostRef}>
      {/*
        The chrome bar sits OUTSIDE the reported rectangle.

        This is deliberate and load-bearing: the native WebContentsView covers
        the measured rect exactly, so any control drawn inside it would be
        invisible and unclickable. Keeping the bar above the rect (and the
        resize handle below it) means its close button always works.
      */}
      <div className="chat-surface-chrome">
        <Globe size={13} />
        <span className="chat-surface-title">ChatGPT</span>
        {native && state.loading && <Loader2 size={12} className="spin" />}
        {native && state.error && (
          <span className="chat-surface-error" title={state.error}>
            <AlertTriangle size={12} /> {state.error}
          </span>
        )}
        <span className="chat-surface-url">{native ? state.url ?? 'chatgpt.com' : 'not docked'}</span>
        {!native && (
          <span className="chat-preview-badge" title="Run inside the Electron shell to dock the real view">
            PREVIEW
          </span>
        )}
        <button
          className="chat-surface-close"
          type="button"
          onClick={onClose}
          title="Close ChatGPT (⌘/Ctrl+J)"
          aria-label="Close ChatGPT panel"
        >
          <X size={13} />
        </button>
      </div>

      {/*
        The measured rect. This element — and ONLY this element — is reported to
        the main process, which docks the native WebContentsView over it. The
        native layer composites above all HTML, so nothing inside this div is
        clickable once docked. Controls must live outside it.
      */}
      <div
        className="chat-surface"
        ref={surfaceRef}
        // On the ChatGPT page the surface fills the workspace, so no
        // explicit height is applied; CSS flex handles it. Elsewhere the
        // dragged height wins.
        style={fill ? undefined : { height }}
      >
        {!native && (
          <div className="chat-surface-body">
            <Globe size={22} />
            <p className="chat-surface-headline">Native ChatGPT surface</p>
            <p className="chat-surface-copy">
              In the packaged app, an Electron <code>WebContentsView</code> is positioned over this
              exact rectangle and loads <code>chatgpt.com</code>. This region is native-owned, so
              nothing rendered here is visible once docked.
            </p>
            <p className="chat-surface-copy subtle">
              Drag the handle below to resize, or close this panel with the × above to reclaim the
              space.
            </p>
            <button className="chat-surface-cta" type="button" disabled>
              <ExternalLink size={12} /> Waiting for Electron shell
            </button>
          </div>
        )}
      </div>

      {/*
        Resize handle. Deliberately OUTSIDE .chat-surface: the native view covers
        the measured rect exactly, so a handle placed inside it would be hidden
        and ungrabbable — which made the panel impossible to shrink.
      */}
      <button
        className="chat-resize"
        type="button"
        aria-label="Resize ChatGPT surface (drag down to minimize)"
        title="Drag down to minimize"
        onPointerDown={startResize}
      />
    </div>
  )
}
