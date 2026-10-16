/**
 * Andro Electron main process.
 *
 * Responsibilities:
 *   1. Create the BrowserWindow that hosts the Andro React UI.
 *   2. Create a native WebContentsView that loads chatgpt.com and dock it over
 *      the rectangle the renderer reports.
 *   3. Drive that page's composer on behalf of the Andro prompt bar.
 *
 * Layout note (important): a WebContentsView is a native layer that composites
 * ABOVE the window's HTML. It is positioned purely by rectangle. It cannot be
 * placed "inside" a DOM element and nothing in the page can paint over it. So
 * the renderer reserves a region, measures it, and sends the rect here; we move
 * the native view to match. The Andro prompt bar deliberately sits below that
 * region so it stays visible and clickable.
 */
import { app, BrowserWindow, WebContentsView, ipcMain, session, shell } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import http from 'node:http'
import { createReadStream } from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** Project root: this file is bundled to electron/dist/main.mjs, so up two. */
const ROOT = path.resolve(__dirname, '..', '..')
const DEV_URL = process.env.ANDRO_DEV_URL || ''
const isDev = Boolean(DEV_URL)

/**
 * Production loads the renderer over http://127.0.0.1 instead of file://.
 *
 * This matters for a non-obvious reason: the andro MCP activity stream guards
 * its /events-ui route with a loopback-Origin check. A file:// page sends
 * `Origin: null`, which that guard rejects with 403 — the packaged app would
 * show no activity at all. Serving from loopback gives a real
 * `http://127.0.0.1:<port>` Origin, which the guard accepts, and keeps the
 * renderer origin-isolated from the chatgpt.com partition.
 */
const STATIC_PORT = Number(process.env.ANDRO_STATIC_PORT || 8791)
let staticServer: http.Server | null = null

/** Persistent partition so the ChatGPT login survives app restarts. */
const CHAT_PARTITION = 'persist:andro-chatgpt'

/**
 * Groq model used for activity narration.
 *
 * Overridable via GROQ_MODEL because Groq retires models on its own schedule —
 * the previous default (llama-3.1-8b-instant) disappeared from the catalog
 * entirely, which would otherwise turn every narration call into a 404 that
 * looks like a generic failure. Confirm availability with:
 *   curl -H "Authorization: Bearer $GROQ_API_KEY" \
 *     https://api.groq.com/openai/v1/models
 */
const GROQ_MODEL = process.env.GROQ_MODEL || 'qwen/qwen3.8-27b'

let win: BrowserWindow | null = null
let chatView: WebContentsView | null = null
let lastRect: { x: number; y: number; width: number; height: number } | null = null

/** Mirror the page's load state to the renderer's chrome. */
function pushState(patch: Record<string, unknown>) {
  if (win && !win.isDestroyed()) win.webContents.send('chat:state', patch)
}

/** Minimal static file server for the built renderer, bound to loopback only. */
async function startStaticServer(): Promise<string> {
  const dist = path.join(ROOT, 'dist')
  const types: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
  }

  staticServer = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${STATIC_PORT}`)
    // Resolve inside dist and verify containment to block path traversal.
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    let target = path.resolve(dist, rel || 'index.html')
    if (!target.startsWith(dist)) {
      res.writeHead(403).end('Forbidden')
      return
    }
    // SPA fallback: unknown paths serve index.html.
    if (!rel || rel.endsWith('/')) target = path.join(dist, 'index.html')

    const stream = createReadStream(target)
    stream.once('open', () => {
      res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream' })
      stream.pipe(res)
    })
    stream.once('error', () => {
      const fallback = createReadStream(path.join(dist, 'index.html'))
      fallback.once('open', () => {
        res.writeHead(200, { 'Content-Type': types['.html'] })
        fallback.pipe(res)
      })
      fallback.once('error', () => res.writeHead(404).end('Not found'))
    })
  })

  await new Promise<void>((resolve, reject) => {
    staticServer!.once('error', reject)
    // 127.0.0.1 only: never expose the renderer to the network.
    staticServer!.listen(STATIC_PORT, '127.0.0.1', resolve)
  })
  return `http://127.0.0.1:${STATIC_PORT}/`
}

/**
 * Identity providers and OAuth hops that must stay inside the app.
 *
 * These hosts actively refuse to complete a sign-in if they cannot open a
 * window with access to the shared session, so they are allowed to spawn real
 * Electron windows on the chat partition rather than being sent to the system
 * browser.
 */
const AUTH_HOSTS = [
  'accounts.google.com',
  'accounts.youtube.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'github.com',
  'auth0.com',
  'okta.com',
  'facebook.com',
  'auth.openai.com',
  'login.openai.com',
]

function isAuthUrl(rawUrl: string): boolean {
  try {
    const { hostname, protocol } = new URL(rawUrl)
    if (protocol !== 'https:' && protocol !== 'http:') return false
    return AUTH_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`))
  } catch {
    return false
  }
}

/**
 * Preload for the ChatGPT view.
 *
 * The page's own JavaScript runs in an isolated world that cannot reach Electron
 * IPC. A preload script does run in a privileged context on the same window, so
 * the DOM observer injected by installMessageRelay can hand messages across via
 * window.__androRelay.
 *
 * This runs with Node integration available, so it must remain a tiny, fixed
 * surface: it forwards message text and nothing else, and never exposes the
 * ipcRenderer object to page scripts.
 */
function installRelayPreload() {
  // The relay preload is authored as .cjs in electron/ and copied next to the
  // bundled main by electron/build.mjs, so resolve it relative to this bundle.
  // registerPreloadScript replaces the deprecated setPreloads.
  session.fromPartition(CHAT_PARTITION).registerPreloadScript({
    type: 'frame',
    filePath: path.join(__dirname, 'chat-relay.cjs'),
  })
}

function createChatView() {
  const view = new WebContentsView({
    webPreferences: {
      partition: CHAT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      // Sandbox MUST be off for the relay preload to work. A sandboxed preload
      // cannot `require('electron')`, so the script throws on its first line and
      // window.__androRelay is never defined — which silently discarded every
      // scraped message. contextIsolation stays on, and the preload exposes only
      // a single message-forwarding function.
      sandbox: false,
    },
  })

  const wc = view.webContents
  wc.setUserAgent(
    // Present as an ordinary desktop Chrome so ChatGPT serves its normal UI.
    wc.getUserAgent().replace(/Electron\/[\d.]+ /, '').replace(/andro-ui\/[\d.]+ /, ''),
  )

  wc.on('did-start-loading', () => pushState({ loading: true, error: undefined }))
  wc.on('did-stop-loading', () => {
    pushState({ loading: false, ready: true, url: wc.getURL() })
    // Install the message relay once the document exists. The injected script
    // guards against double-install, so calling it on every settle is safe.
    void installMessageRelay(wc).then(status => {
      if (status !== 'already-installed') console.log('[chat-relay]', status)
    })
  })
  wc.on('did-navigate', () => pushState({ url: wc.getURL() }))
  wc.on('did-navigate-in-page', () => pushState({ url: wc.getURL() }))
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return // -3 = aborted, benign
    pushState({ loading: false, error: `${desc}`, url })
  })

  /**
   * Popup handling — this is what makes "Continue with Google" work.
   *
   * Google's OAuth flow runs in a POPUP, not an in-page navigation. Denying all
   * popups (or shunting them to the system browser) breaks it in a subtle way:
   * the sign-in succeeds in a browser that shares no session with this app, so
   * the cookie never reaches ChatGPT here and the user stays logged out.
   *
   * So: auth popups open as a real Electron window on the SAME partition, which
   * means the resulting cookies land in the chat session where they belong.
   * Ordinary links still go to the system browser.
   */
  wc.setWindowOpenHandler(({ url }) => {
    if (isAuthUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: {
            // Same partition as the chat view: this is what shares the login.
            partition: CHAT_PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      }
    }
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Identity providers frequently open further popups or redirect through
  // intermediate hosts; apply the same rule to every webContents we spawn.
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isAuthUrl(url)) return { action: 'allow' }
      void shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  void wc.loadURL('https://chatgpt.com/')
  return view
}

/**
 * Whether the native view should currently be on screen.
 *
 * This exists because applyRect() is re-run on window resize/maximize, and it
 * used to force setVisible(true) every time. That meant resizing the window
 * while the panel was closed would resurrect the ChatGPT view on top of the UI.
 * Visibility is now owned by this flag; applyRect only ever moves the view.
 */
let chatVisible = false

/** Show the view, docked to the last known rectangle. Used on explicit dock. */
function showChatView(rect?: { x: number; y: number; width: number; height: number }) {
  if (!chatView) return
  chatVisible = true
  const target = rect ?? lastRect
  if (target) {
    chatView.setBounds({
      x: Math.round(target.x),
      y: Math.round(target.y),
      width: Math.round(target.width),
      height: Math.round(target.height),
    })
    lastRect = target
  }
  chatView.setVisible(true)
}

function hideChatView() {
  chatVisible = false
  chatView?.setVisible(false)
}

function applyRect(rect: { x: number; y: number; width: number; height: number }) {
  if (!win || !chatView) return
  lastRect = rect
  // DIP-aware: Electron expects integer device-independent pixels here.
  chatView.setBounds({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  })
  // Only reveal if the panel is actually open. Never force-show here.
  if (chatVisible) chatView.setVisible(true)
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0a',
    title: 'Andro',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  chatView = createChatView()
  win.contentView.addChildView(chatView)
  // Start hidden; the renderer reports a rect as soon as it measures one.
  hideChatView()

  // Smoke-test hook: verify the shell boots and the bridge is reachable without
  // a human at the keyboard. Registered BEFORE the load so the event is not
  // missed. Used by `npm run electron:smoke`.
  if (process.env.ANDRO_SMOKE) {
    win.webContents.once('did-finish-load', async () => {
      try {
        // Let React mount, the dock effect report its rectangle, and the
        // chatgpt.com navigation commit (login redirect included).
        await new Promise(r => setTimeout(r, 6000))
        const probe = await win!.webContents.executeJavaScript(
          `({
             bridge: typeof window.andro,
             dock: typeof window.andro?.dockChatSurface,
             submit: typeof window.andro?.submitPrompt,
             chatSurface: !!document.querySelector('.chat-surface'),
             promptBar: !!document.querySelector('.prompt-bar'),
             sourcePanel: !!document.querySelector('.source-panel'),
             innerSize: { w: window.innerWidth, h: window.innerHeight },
             outerSize: { w: window.outerWidth, h: window.outerHeight },
             screenOrigin: { x: window.screenX, y: window.screenY },
             chatRect: (() => { const r = document.querySelector('.chat-surface')?.getBoundingClientRect();
                                return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })(),
             promptRect: (() => { const r = document.querySelector('.prompt-bar')?.getBoundingClientRect();
                                  return r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null })(),
             overlap: (() => {
               const a = document.querySelector('.chat-surface')?.getBoundingClientRect();
               const b = document.querySelector('.prompt-bar')?.getBoundingClientRect();
               if (!a || !b) return null;
               return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
             })()
           })`,
          true,
        )
        console.log('[smoke] renderer probe:', JSON.stringify(probe, null, 2))
        const bounds = chatView?.getBounds()
        const content = win!.getContentBounds()
        console.log('[smoke] native view bounds:', JSON.stringify(bounds))
        console.log('[smoke] window content bounds:', JSON.stringify(content))
        console.log('[smoke] window bounds:', JSON.stringify(win!.getBounds()))
        console.log('[smoke] native visible:', chatView?.getVisible())
        console.log('[smoke] chat url:', chatView?.webContents.getURL())
        console.log('[smoke] chat loading:', chatView?.webContents.isLoading())
        console.log('[smoke] chat title:', chatView?.webContents.getTitle())

        // What can the message relay actually see in the chat page? This
        // separates "no reply rendered" from "extraction is broken".
        if (chatView) {
          const relay = await probeRelay(chatView.webContents)
          console.log('[smoke] relay state:', JSON.stringify(relay))
        }

        // (resize-handle geometry is checked below, while the chat page is open)

        // Feed the transcript synthetic events and verify the chat UI renders
        // them. This checks the redesign without needing a live MCP server.
        const sample = [
          { id: 's1', ts: Date.now() - 9000, tool: 'grep', status: 'ok', argsSummary: 'auth handler', paths: [], durationMs: 120 },
          { id: 's2', ts: Date.now() - 7000, tool: 'read', status: 'ok', argsSummary: 'src/auth.ts', paths: ['src/auth.ts'], durationMs: 40 },
          { id: 's3', ts: Date.now() - 4000, tool: 'edit', status: 'ok', argsSummary: 'src/auth.ts', paths: ['src/auth.ts'], durationMs: 90, additions: 12, deletions: 3 },
          {
            id: 's4',
            ts: Date.now() - 1500,
            tool: 'bash',
            status: 'ok',
            argsSummary: 'npm test',
            paths: [],
            args: { command: 'npm test' },
            // Real captured output, so narration can be verified as
            // outcome-based rather than command-based.
            output: 'FAIL src/auth.test.ts\n  ● login rejects a bad password\nTests: 2 failed, 10 passed',
            outputType: 'stdout',
          },
        ]
        await win!.webContents.executeJavaScript(
          `window.dispatchEvent(new CustomEvent('andro:smoke-events', { detail: ${JSON.stringify(sample)} })); true`,
          true,
        )
        await new Promise(r => setTimeout(r, 900))
        const chat = await win!.webContents.executeJavaScript(
          `({
             turns: document.querySelectorAll('.turn.agent').length,
             bubbles: document.querySelectorAll('.turn.user').length,
             running: document.querySelectorAll('.turn.agent.running').length,
             firstText: document.querySelector('.turn-text')?.textContent?.trim() ?? null,
             detailsFolded: document.querySelectorAll('.turn-detail').length,
             disclosureButtons: document.querySelectorAll('.turn-disclosure').length,
             bareContainer: !!document.querySelector('.chat-column') &&
                            getComputedStyle(document.querySelector('.chat-column')).borderTopWidth === '0px' &&
                            getComputedStyle(document.querySelector('.chat-column')).backgroundColor === 'rgba(0, 0, 0, 0)',
             // DOM order of every turn, to prove top-to-bottom chronological.
             order: [...document.querySelectorAll('.turn')].map(el =>
               el.classList.contains('user') ? 'user' : 'agent'),
             narrationOrder: [...document.querySelectorAll('.turn-text')].map(el => el.textContent.trim()),
             bubbleText: document.querySelector('.turn.user .bubble')?.textContent?.trim() ?? null,
             // Reading order: first turn must sit above the last in the viewport.
             firstTop: Math.round(document.querySelector('.turn')?.getBoundingClientRect().top ?? -1),
             lastTop: Math.round([...document.querySelectorAll('.turn')].at(-1)?.getBoundingClientRect().top ?? -1)
           })`,
          true,
        )
        console.log('[smoke] transcript render:', JSON.stringify(chat, null, 2))
        console.log('[smoke] chronological:', chat.firstTop < chat.lastTop ? 'PASS (top to bottom)' : 'FAIL (reversed)')
        console.log('[smoke] prompt shown:', chat.bubbles > 0 ? 'PASS' : 'FAIL (no user bubble)')

        // Every activity row already renders an "Andro" speaker label, so the
        // narration sentence must NOT repeat the name.
        const duped = await win!.webContents.executeJavaScript(
          `[...document.querySelectorAll('.turn.agent')].map(row => {
             const speaker = row.querySelector('.turn-speaker')?.textContent?.trim() || '';
             const text = row.querySelector('.turn-text')?.textContent?.trim() || '';
             return { speaker, text, duplicates: !!speaker && text.toLowerCase().startsWith(speaker.toLowerCase()) };
           })`,
          true,
        )
        const anyDupes = Array.isArray(duped) && duped.some(d => d.duplicates)
        console.log('[smoke] activity rows:', JSON.stringify(duped))
        console.log(
          '[smoke] no repeated "Andro" per line:',
          anyDupes ? 'FAIL (name repeated)' : 'PASS',
        )

        // The raw shell command must never reach the transcript verbatim.
        const leaked = await win!.webContents.executeJavaScript(
          `[...document.querySelectorAll('.turn-text')]
             .some(el => /&&|\\|\\||\\$\\{/.test(el.textContent || ''))`,
          true,
        )
        console.log('[smoke] raw command leaked into prose:', leaked ? 'FAIL' : 'PASS (none)')

        // Narration provenance must be reported rather than silently absent.
        const narr = await win!.webContents.executeJavaScript(
          `document.querySelector('.transcript-foot')?.textContent?.trim() ?? null`,
          true,
        )
        console.log('[smoke] narration status line:', JSON.stringify(narr))

        // Content width toggle must actually change the rendered column width.
        const widths = await win!.webContents.executeJavaScript(
          `(async () => {
             const read = () => Math.round(document.querySelector('.content').getBoundingClientRect().width);
             const buttons = [...document.querySelectorAll('.width-control button')];
             if (buttons.length < 2) return { error: 'width control missing' };
             const standard = read();
             buttons[1].click();
             await new Promise(r => setTimeout(r, 300));
             const wideNow = read();
             const applied = getComputedStyle(document.documentElement)
               .getPropertyValue('--andro-content-width').trim();
             buttons[0].click();
             await new Promise(r => setTimeout(r, 300));
             const back = read();
             return { standard, wideNow, back, applied, buttons: buttons.length };
           })()`,
          true,
        )
        console.log('[smoke] content width:', JSON.stringify(widths))
        console.log(
          '[smoke] width toggle:',
          widths.wideNow > widths.standard && widths.back === widths.standard ? 'PASS' : 'FAIL',
        )

        // Navigating away from the ChatGPT page MUST hide the native view.
        // It is not part of the DOM, so if it stays docked it floats over
        // whichever page you switched to.
        //
        // Visibility is sampled from the MAIN process, so it must be read while
        // the renderer is still on each page — hence the split into separate
        // steps rather than one script that navigates both ways.
        const goto = (label: string) =>
          win!.webContents.executeJavaScript(
            `[...document.querySelectorAll('.side-nav button')].find(x => x.textContent.trim().startsWith(${JSON.stringify(label)}))?.click(); true`,
            true,
          )

        await goto('ChatGPT')
        await new Promise(r => setTimeout(r, 1200))
        const chatSnap = await win!.webContents.executeJavaScript(
          `(() => {
             const el = document.querySelector('.chat-surface');
             const r = el ? el.getBoundingClientRect() : null;
             return {
               chatPage: !!document.querySelector('.chat-page'),
               surface: !!el,
               promptBar: !!document.querySelector('.prompt-bar'),
               rect: r ? { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width) } : null
             };
           })()`,
          true,
        )
        const visibleOnChat = chatView?.getVisible()
        console.log('[smoke] nav — on chat page:', JSON.stringify(chatSnap))
        console.log('[smoke] nav — native visible on chat page:', visibleOnChat)

        await goto('Session')
        await new Promise(r => setTimeout(r, 1200))
        const sessionSnap = await win!.webContents.executeJavaScript(
          `({
             chatPage: !!document.querySelector('.chat-page'),
             surface: !!document.querySelector('.chat-surface'),
             promptBar: !!document.querySelector('.prompt-bar')
           })`,
          true,
        )
        const visibleOnSession = chatView?.getVisible()
        console.log('[smoke] nav — on session page:', JSON.stringify(sessionSnap))
        console.log('[smoke] nav — native visible on session page:', visibleOnSession)

        console.log(
          '[smoke] chat page:',
          chatSnap.chatPage && visibleOnChat && !sessionSnap.chatPage && !visibleOnSession
            ? 'PASS'
            : 'FAIL (page switch or native hide incorrect)',
        )
        console.log(
          '[smoke] prompt bar on both pages:',
          chatSnap.promptBar && sessionSnap.promptBar ? 'PASS' : 'FAIL',
        )
        // Return to the chat page so the resize assertions run against it.
        await win!.webContents.executeJavaScript(
          `[...document.querySelectorAll('.side-nav button')].find(x => x.textContent.trim().startsWith('ChatGPT'))?.click(); true`,
          true,
        )
        await new Promise(r => setTimeout(r, 900))

        // Does the resize handle sit OUTSIDE the native rect? If it overlaps,
        // the native view covers it and the panel cannot be shrunk. Must run
        // while the chat page is open, since that is where the surface exists.
        const handleGeom = await win!.webContents.executeJavaScript(
          `(() => {
             const h = document.querySelector('.chat-resize');
             const s = document.querySelector('.chat-surface');
             if (!h || !s) return { error: 'missing elements', surface: !!s, handle: !!h };
             const hr = h.getBoundingClientRect();
             const sr = s.getBoundingClientRect();
             const overlap = Math.max(0, Math.min(hr.bottom, sr.bottom) - Math.max(hr.top, sr.top));
             return {
               handleTop: Math.round(hr.top),
               surfaceBottom: Math.round(sr.bottom),
               overlap: Math.round(overlap),
               handleClickable: document.elementFromPoint(hr.left + hr.width / 2, hr.top + hr.height / 2) === h
             };
           })()`,
          true,
        )
        console.log('[smoke] resize handle:', JSON.stringify(handleGeom))
        console.log(
          '[smoke] handle grabbable:',
          handleGeom.overlap === 0 && handleGeom.handleClickable ? 'PASS' : 'FAIL (covered by native rect)',
        )

        // On the ChatGPT page the surface FILLS the workspace, so dragging the
        // handle must not shrink it — the handle is only meaningful on the
        // compact layout. Assert the fill contract instead of a drag result.
        const fillCheck = await win!.webContents.executeJavaScript(
          `(() => {
             const el = document.querySelector('.chat-surface');
             const page = document.querySelector('.chat-page');
             if (!el || !page) return { error: 'not on chat page' };
             const inlineHeight = el.style.height;
             return {
               inlineHeight: inlineHeight || '(none)',
               surfaceH: Math.round(el.getBoundingClientRect().height),
               pageH: Math.round(page.getBoundingClientRect().height),
               // Fill means the surface occupies essentially the whole page
               // (minus the prompt bar and chrome).
               fills: el.getBoundingClientRect().height > page.getBoundingClientRect().height * 0.7
             };
           })()`,
          true,
        )
        console.log('[smoke] chat page fill:', JSON.stringify(fillCheck))
        console.log(
          '[smoke] surface fills chat page:',
          fillCheck.fills && fillCheck.inlineHeight === '(none)' ? 'PASS' : 'FAIL',
        )

        // Close/reopen cycle. The requirement is that closing HIDES the panel
        // while the DOM stays mounted and functional (state preserved, no
        // unmount), the native view is hidden, and the reopen bar appears.
        const cycle = async () => {
          const state = () =>
            win!.webContents.executeJavaScript(
              `(() => {
                 const region = document.querySelector('.chat-region');
                 const surface = document.querySelector('.chat-surface');
                 const bar = document.querySelector('.chat-reopen');
                 // NOTE: getClientRects().length reports LAYOUT boxes, not
                 // visibility — a visibility:hidden element still has them. So
                 // check computed visibility explicitly.
                 const regionStyle = region ? getComputedStyle(region) : null;
                 return {
                   surfaceInDom: !!surface,
                   regionHeight: region ? Math.round(region.getBoundingClientRect().height) : -1,
                   regionVisibility: regionStyle ? regionStyle.visibility : null,
                   regionOverflow: regionStyle ? regionStyle.overflow : null,
                   reopenBar: !!bar && bar.getClientRects().length > 0,
                   promptInDom: !!document.querySelector('.prompt-bar')
                 };
               })()`,
              true,
            )

          // Type a draft first, to prove composer state survives a close/reopen.
          await win!.webContents.executeJavaScript(
            `(() => {
               const ta = document.querySelector('.prompt-input');
               const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
               setter.call(ta, 'draft survives');
               ta.dispatchEvent(new Event('input', { bubbles: true }));
               return true;
             })()`,
            true,
          )
          await new Promise(r => setTimeout(r, 200))

          const before = await state()
          await win!.webContents.executeJavaScript(
            `document.querySelector('.chat-surface-close').click(); true`,
            true,
          )
          await new Promise(r => setTimeout(r, 700))
          const closed = await state()
          const hiddenWhileClosed = chatView?.getVisible()

          await win!.webContents.executeJavaScript(
            `document.querySelector('.chat-reopen').click(); true`,
            true,
          )
          await new Promise(r => setTimeout(r, 900))
          const reopened = await state()
          const visibleAfter = chatView?.getVisible()
          const draftKept = await win!.webContents.executeJavaScript(
            `document.querySelector('.prompt-input')?.value ?? null`,
            true,
          )
          const boundsAfter = chatView?.getBounds()

          console.log('[smoke] close/open — before:', JSON.stringify(before))
          console.log('[smoke] close/open — closed:', JSON.stringify(closed))
          console.log('[smoke] close/open — native visible while closed:', hiddenWhileClosed)
          console.log('[smoke] close/open — reopened:', JSON.stringify(reopened))
          console.log('[smoke] close/open — draft kept:', JSON.stringify(draftKept))
          console.log('[smoke] close/open — bounds after reopen:', JSON.stringify(boundsAfter))
          console.log('[smoke] close/open — native visible after reopen:', visibleAfter)

          const pass =
            before.regionHeight > 0 &&
            // DOM survives the close — still mounted, just collapsed and hidden.
            closed.surfaceInDom &&
            closed.promptInDom &&
            closed.regionHeight === 0 &&
            closed.regionVisibility === 'hidden' &&
            closed.reopenBar &&
            // Native layer actually hidden, or ChatGPT floats over the UI.
            !hiddenWhileClosed &&
            reopened.regionHeight > 0 &&
            reopened.regionVisibility === 'visible' &&
            !reopened.reopenBar &&
            visibleAfter &&
            draftKept === 'draft survives'
          console.log('[smoke] close/open:', pass ? 'PASS' : 'FAIL')
        }
        await cycle()
      } catch (error) {
        console.error('[smoke] probe failed:', error)
      } finally {
        app.quit()
      }
    })
  }

  if (isDev) {
    await win.loadURL(DEV_URL)
  } else {
    // Loopback HTTP rather than file:// — see STATIC_PORT comment for why.
    await win.loadURL(await startStaticServer())
  }


  win.on('closed', () => {
    win = null
    chatView = null
  })

  // Re-apply the last known rect on window geometry changes so the native view
  // tracks the DOM region instead of drifting.
  const reflow = () => {
    if (lastRect && chatView && win) applyRect(lastRect)
  }
  win.on('resize', reflow)
  win.on('maximize', reflow)
  win.on('unmaximize', reflow)

  win.webContents.on('did-finish-load', () => pushState({ url: chatView?.webContents.getURL() }))
}

/* ── IPC ───────────────────────────────────────────────────────────────── */

ipcMain.on('chat:dock', (_event, rect) => {
  if (!rect || typeof rect.width !== 'number') return
  // A dock request is an explicit "show me here" from the renderer.
  showChatView(rect)
})

ipcMain.on('chat:hide', () => {
  hideChatView()
})

/**
 * Messages scraped from the chat page, relayed from the chat view's preload.
 *
 * They are forwarded straight to the Andro renderer, which merges them into the
 * transcript. Only the assistant/user text crosses this boundary.
 */
ipcMain.on('chat:messages', (_event, payload: { messages: unknown[]; streaming: boolean }) => {
  if (process.env.ANDRO_TRACE_CHAT) {
    const list = Array.isArray(payload?.messages) ? payload.messages : []
    console.log(
      '[chat-msg] forwarding',
      list.length,
      'message(s), streaming:',
      payload?.streaming,
      'roles:',
      JSON.stringify(list.map(m => (m as { role?: string })?.role)),
    )
  }
  if (win && !win.isDestroyed()) win.webContents.send('chat:messages', payload)
})

/** Observer failures in the chat page, surfaced for diagnosis. */
ipcMain.on('chat:relay-error', (_event, message: string) => {
  console.error('[chat-relay] observer error:', message)
})

/**
 * Type text into ChatGPT's composer and submit it.
 *
 * Written against the composer's ACTUAL structure, verified by probing the live
 * page (electron/probe-composer.mjs):
 *
 *   - The composer is `div#prompt-textarea.ProseMirror[contenteditable=true]`,
 *     NOT a textarea. The only `textarea` on the page is a hidden fallback with
 *     zero size, so selecting by tag picks the wrong element entirely.
 *   - ProseMirror ignores a synthetic ClipboardEvent paste and ignores direct
 *     textContent writes. `document.execCommand('insertText')` produces the
 *     beforeinput/input pair the editor actually listens for, and is what makes
 *     the text land.
 *   - `button[data-testid="send-button"]` exists and becomes enabled once the
 *     composer has content. Clicking it is the reliable submit; a synthetic
 *     Enter keypress is not, because ProseMirror handles it internally.
 *
 * Every step is verified in-page and reported, so a failure says which step
 * broke instead of silently claiming success.
 */
ipcMain.handle('chat:submit', async (_event, text: string) => {
  const wc = chatView?.webContents
  if (!wc) return { ok: false, reason: 'Chat surface is not available.' }
  if (typeof text !== 'string' || !text.trim()) return { ok: false, reason: 'Empty prompt.' }

  try {
    const result = await wc.executeJavaScript(
      `(async () => {
        const prompt = ${JSON.stringify(text)};
        const wait = ms => new Promise(r => setTimeout(r, ms));

        // Prefer the contenteditable composer explicitly. A bare 'textarea'
        // selector resolves to ChatGPT's hidden fallback node.
        const composer =
          document.querySelector('#prompt-textarea') ||
          document.querySelector('div.ProseMirror[contenteditable="true"]') ||
          document.querySelector('div[contenteditable="true"][role="textbox"]');

        if (!composer) {
          return { ok: false, reason: 'Composer not found — is ChatGPT signed in and fully loaded?' };
        }
        if (composer.getClientRects().length === 0) {
          return { ok: false, reason: 'Composer is present but not visible.' };
        }

        composer.focus();
        await wait(80);

        // Clear anything already typed, so a stale draft is not sent along.
        if (composer.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(composer, '');
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          const selection = window.getSelection();
          const range = document.createRange();
          range.selectNodeContents(composer);
          selection.removeAllRanges();
          selection.addRange(range);
          document.execCommand('delete', false);
        }
        await wait(60);

        // Insert. execCommand is what ProseMirror honours for contenteditable.
        if (composer.tagName === 'TEXTAREA') {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(composer, prompt);
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('insertText', false, prompt);
        }
        await wait(250);

        // Verify the text actually landed before attempting to send.
        const landed = composer.tagName === 'TEXTAREA'
          ? composer.value
          : composer.textContent || '';
        if (!landed.includes(prompt.slice(0, 24))) {
          return {
            ok: false,
            reason: 'Text did not reach the composer (got: ' + JSON.stringify(landed.slice(0, 60)) + ')'
          };
        }

        // The send button only becomes enabled once content exists, so query it
        // after inserting rather than before.
        let button = null;
        for (let attempt = 0; attempt < 20 && !button; attempt++) {
          const candidate = document.querySelector('button[data-testid="send-button"]');
          if (candidate && !candidate.disabled) button = candidate;
          else await wait(100);
        }
        if (!button) {
          return { ok: false, reason: 'Send button never became enabled after typing.' };
        }

        button.click();
        await wait(400);

        // Confirm the composer cleared, which indicates the send was accepted.
        const after = composer.tagName === 'TEXTAREA'
          ? composer.value
          : composer.textContent || '';
        return { ok: true, cleared: after.trim().length === 0 };
      })()`,
      true,
    )
    return result ?? { ok: false, reason: 'No response from the chat page.' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Injection failed.' }
  }
})

/**
 * Read assistant replies out of ChatGPT's page and forward them to the UI.
 *
 * Selectors verified against the live page: each turn carries
 * `[data-message-author-role="assistant"]`, and the rendered prose lives in a
 * `.markdown` descendant. `data-message-id` gives a stable key so the same
 * message can be updated in place while it streams instead of being appended
 * repeatedly.
 *
 * A MutationObserver is installed once per page load. Re-installing on every
 * navigation would stack observers and duplicate messages, so the install is
 * guarded by a flag on the window object.
 */
async function installMessageRelay(wc: Electron.WebContents) {
  const script = `
    (() => {
      if (window.__androRelayInstalled) return 'already-installed';
      window.__androRelayInstalled = true;

      const seen = new Map();

      /**
       * Read text from a turn node.
       *
       * innerText is preferred because it reflects what the user sees and skips
       * hidden UI chrome — but it returns an EMPTY STRING for any element that is
       * not currently laid out, which happens when the view is collapsed or not
       * yet painted. Falling back to textContent captures the reply regardless.
       */
      const readText = (el) => {
        const inner = (el.innerText || '').trim();
        if (inner) return inner;
        return (el.textContent || '').trim();
      };

      const extract = () => {
        const nodes = [...document.querySelectorAll('[data-message-author-role]')];
        const messages = [];
        for (const node of nodes) {
          const role = node.getAttribute('data-message-author-role');
          if (role !== 'assistant' && role !== 'user') continue;

          // The markdown container holds rendered prose and excludes UI chrome
          // (copy/regenerate buttons) that lives on the turn wrapper. It may not
          // exist yet while a reply streams, so fall back to the turn node.
          const body = node.querySelector('.markdown')
            || node.querySelector('[class*="markdown"]')
            || node;

          // Emit the turn even when empty: a streaming reply legitimately has no
          // text yet. Dropping empty turns made in-flight replies invisible, and
          // a reply that never rendered invisible entirely.
          messages.push({
            id: node.getAttribute('data-message-id') || (role + ':' + messages.length),
            role,
            text: readText(body)
          });
        }
        return messages;
      };

      const emit = () => {
        const messages = extract();
        // Streaming indicator: the stop button only exists mid-response.
        const streaming = !!document.querySelector(
          'button[data-testid="stop-button"], button[aria-label*="Stop"]'
        );
        const changed = messages.some(m => seen.get(m.id) !== m.text) || messages.length !== seen.size;
        if (!changed && !streaming) return;
        seen.clear();
        for (const m of messages) seen.set(m.id, m.text);
        window.__androRelay(messages, streaming);
      };

      // Coalesce bursts: streaming mutates the DOM continuously.
      let scheduled = false;
      const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        setTimeout(() => {
          scheduled = false;
          try {
            emit();
          } catch (err) {
            // Surface failures instead of swallowing them: a silent throw here
            // is indistinguishable from "no messages on the page".
            try { window.__androRelayError(String(err)); } catch {}
          }
        }, 220);
      };

      /**
       * Observe body, and re-attach if it is ever replaced.
       *
       * ChatGPT is a single-page app. A hard navigation is not the only way the
       * document changes: if anything swaps document.body, an observer bound to
       * the old node silently stops firing and messages stop flowing with no
       * error at all.
       */
      let observer = null;
      let observedNode = null;
      const attach = () => {
        const target = document.body;
        if (!target || target === observedNode) return;
        if (observer) observer.disconnect();
        observer = new MutationObserver(schedule);
        observer.observe(target, { childList: true, subtree: true, characterData: true });
        observedNode = target;
        schedule();
      };
      attach();

      /**
       * Polling fallback.
       *
       * A MutationObserver only fires on mutation. If a reply is rendered by a
       * means that does not mutate the observed subtree (or the observer is
       * detached by a body swap between checks), nothing would ever be emitted.
       * A slow poll costs almost nothing and guarantees the UI converges.
       */
      setInterval(() => {
        attach();
        schedule();
      }, 2000);

      schedule();
      return 'installed';
    })()
  `

  try {
    const status = await wc.executeJavaScript(script, true)
    return status
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : error}`
  }
}

/**
 * One-shot diagnostic: report what the relay can currently see in the page.
 *
 * Used to distinguish "no messages rendered" from "extraction is broken", which
 * look identical from the UI. Safe to call at any time.
 */
async function probeRelay(wc: Electron.WebContents) {
  const script = `
    (() => {
      const nodes = [...document.querySelectorAll('[data-message-author-role]')];
      return {
        turns: nodes.length,
        roles: nodes.map(n => n.getAttribute('data-message-author-role')),
        lengths: nodes.map(n => {
          const body = n.querySelector('.markdown') || n;
          return {
            innerText: (body.innerText || '').length,
            textContent: (body.textContent || '').length
          };
        }),
        relayInstalled: !!window.__androRelayInstalled,
        // Must be 'function'. 'undefined' means the contextBridge exposure did
        // not reach the page world, and every scraped message is being dropped.
        relayFn: typeof window.__androRelay,
        relayErrorFn: typeof window.__androRelayError
      };
    })()
  `
  try {
    return await wc.executeJavaScript(script, true)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}


/**
 * Groq narration proxy.
 *
 * This runs in the main process rather than the renderer for three reasons:
 *  1. The API key stays out of the bundled renderer JS.
 *  2. No page CSP applies here, so the request cannot be blocked.
 *  3. Failures can be reported back instead of vanishing into a catch block.
 *
 * The model is asked for a JSON object keyed by event id, so a batch of tool
 * calls costs one request instead of one per call.
 */
ipcMain.handle('narration:describe', async (_event, payload: { items: Record<string, unknown> }) => {
  const key = process.env.GROQ_API_KEY || readEnvFile('GROQ_API_KEY')
  if (!key) {
    return { ok: false, reason: 'No Groq API key configured (set GROQ_API_KEY in .env.local).' }
  }

  const items = payload?.items
  if (!items || typeof items !== 'object' || Object.keys(items).length === 0) {
    return { ok: false, reason: 'No items to describe.' }
  }

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          {
            role: 'system',
            content:
              'You describe what a coding agent did, for a non-technical reader. ' +
              'You receive a JSON object mapping an id to a tool call, which may include ' +
              '"output" (what the tool actually produced) and "error".\n' +
              'Reply with ONLY a JSON object mapping each id to ONE short sentence, ' +
              'max 14 words, plain English.\n' +
              'Rules:\n' +
              '- Base the sentence on the OUTCOME shown in "output"/"error", not on the ' +
              'command text. If the output shows a failure, say it failed; if it shows ' +
              'success or data, say what was found or done.\n' +
              '- Never include raw commands, flags, file paths, file extensions, or code.\n' +
              '- Start the sentence with a verb. Do NOT name a subject or actor: the UI ' +
              'already labels every row "Andro", so write "checked which files changed", ' +
              'never "Andro checked which files changed" or "The agent checked...".\n' +
              '- If "status" is running and there is no output yet, describe what is ' +
              'being attempted.\n' +
              '- Describe purpose, not mechanics: "checked which files changed", not "git status"; ' +
              '"the tests failed", not "npm test exited 1".',
          },
          { role: 'user', content: JSON.stringify(items) },
        ],
        response_format: { type: 'json_object' },
      }),
    })

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return { ok: false, reason: `Groq returned ${response.status}. ${body.slice(0, 200)}` }
    }

    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] }
    const raw = data.choices?.[0]?.message?.content
    if (!raw) return { ok: false, reason: 'Groq returned an empty response.' }

    // Reasoning-capable models can wrap output in a think block even when a JSON
    // response format is requested. Strip it, then fall back to the outermost
    // braces so a stray preamble cannot turn valid narration into a parse error.
    let cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim()
    if (!cleaned.startsWith('{')) {
      const start = cleaned.indexOf('{')
      const end = cleaned.lastIndexOf('}')
      if (start !== -1 && end > start) cleaned = cleaned.slice(start, end + 1)
    }

    try {
      return { ok: true, table: JSON.parse(cleaned) as Record<string, string> }
    } catch {
      return { ok: false, reason: `Groq reply was not valid JSON: ${cleaned.slice(0, 160)}` }
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Groq request failed.' }
  }
})

/**
 * Minimal .env reader for main-process secrets.
 *
 * Vite only exposes VITE_-prefixed vars to the renderer, and those end up in the
 * bundle. A secret like a Groq key must not be one of them, so it is read here
 * instead.
 */
function readEnvFile(name: string): string | undefined {
  for (const file of ['.env.local', '.env']) {
    try {
      const contents = readFileSyncSafe(path.join(ROOT, file))
      if (!contents) continue
      for (const line of contents.split('\n')) {
        const match = line.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*)\\s*$`))
        if (match) {
          const value = match[1].replace(/^["']|["']$/g, '').trim()
          if (value) return value
        }
      }
    } catch {
      // Missing or unreadable file: try the next candidate.
    }
  }
  return undefined
}

function readFileSyncSafe(file: string): string | null {
  try {
    return fsSync.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Read a project source file. Paths are resolved against the project root and
 * verified to stay inside it, so the renderer cannot traverse the filesystem.
 */
ipcMain.handle('fs:read', async (_event, relPath: string) => {
  try {
    const root = app.getAppPath()
    const target = path.resolve(root, relPath)
    if (!target.startsWith(root + path.sep) && target !== root) {
      return { ok: false, reason: 'Path escapes the project root.' }
    }
    const content = await fs.readFile(target, 'utf8')
    return { ok: true, content }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Read failed.' }
  }
})

ipcMain.handle('fs:write', async (_event, relPath: string, content: string) => {
  try {
    const root = app.getAppPath()
    const target = path.resolve(root, relPath)
    if (!target.startsWith(root + path.sep)) {
      return { ok: false, reason: 'Path escapes the project root.' }
    }
    await fs.writeFile(target, content, 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'Write failed.' }
  }
})

/* ── lifecycle ─────────────────────────────────────────────────────────── */

/**
 * Keep Chromium's profile (cookies, cache, GPU shaders) inside the project
 * directory. This keeps the ChatGPT login self-contained and portable, and
 * avoids sandbox denials on ~/.config.
 */
app.setPath('userData', path.join(ROOT, '.andro-profile'))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

void app.whenReady().then(async () => {
  // Attach the message relay preload before any chat view is created, so the
  // first page load already has window.__androRelay available.
  installRelayPreload()

  // Give the chat partition a normal desktop UA at the session level too.
  session.fromPartition(CHAT_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
    // What a chat page plus an OAuth sign-in legitimately needs. Everything
    // else (geolocation, camera, midi, usb...) is denied.
    const allowed = new Set([
      'clipboard-sanitized-write',
      'clipboard-read',
      'notifications',
      'media',
      'fullscreen',
      'storage-access',
    ])
    callback(allowed.has(permission))
  })

  // Some providers probe the user agent to decide whether to allow an embedded
  // sign-in. Reporting plain Chrome for the whole partition avoids the
  // "this browser or app may not be secure" dead end.
  session.fromPartition(CHAT_PARTITION).setUserAgent(
    session.fromPartition(CHAT_PARTITION).getUserAgent().replace(/Electron\/[\d.]+ /, ''),
  )

  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow()
  })
})

app.on('window-all-closed', () => {
  staticServer?.close()
  if (process.platform !== 'darwin') app.quit()
})
