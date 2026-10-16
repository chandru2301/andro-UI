# Andro UI

An Electron shell that overlays Andro's own agent workspace on top of a live,
logged-in **ChatGPT web** session.

## How the layout works (read this first)

The window is built from a native layer and an HTML layer, and they cannot mix:

```
┌──────────────────────────────────────────────┐
│ Andro topbar                                 │
├──────────────────────────────────────────────┤
│ HTML: agent activity / changed files /       │
│       sessions  +  TypeScript source panel   │
├──────────────────────────────────────────────┤
│ NATIVE: WebContentsView → chatgpt.com        │  ← Electron-owned rect
│         (real, logged-in ChatGPT)            │
├──────────────────────────────────────────────┤
│ HTML: Andro prompt bar (composer + send)     │  ← Andro-owned, drives above
├──────────────────────────────────────────────┤
│ Andro status bar                             │
└──────────────────────────────────────────────┘
```

**The one rule:** a `WebContentsView` is a native surface composited *above* all
HTML. It cannot be placed inside a DOM element, and no CSS can paint over it.
So:

- the React app **reserves and measures** a rectangle (`ChatSurface.tsx`);
- it sends that rect over IPC to the main process, which positions the view;
- the prompt bar is laid out as a **separate, non-overlapping row below** that
  rect — if it ever overlapped, it would be covered and unclickable.

The smoke test asserts `overlap: 0` to enforce exactly that.

## Commands

| Command | What it does |
| --- | --- |
| `npm run electron:dev` | Dev: builds Electron entries, starts Vite on port 5273, opens the shell. Use this. |
| `npm run electron:start` | Build the web bundle, then run the shell with no dev server. |
| `npm run electron:smoke` | Headless-ish self-test: boots the shell, probes the live renderer, prints layout geometry, exits. |
| `npm run auth:check` | List Firefox profiles and whether each holds a ChatGPT session cookie. |
| `npm run auth:import` | Import that session into the app's partition (see below). |
| `npm run dev` | Web UI only, in a browser. The chat region shows a placeholder. |
| `npm run build` | Typecheck + build the web bundle into `dist/`. |

## Activity narration (Groq)

Raw tool calls are rewritten as one plain sentence each ("checked which files
changed", not `git status --short --branch`) using Groq. Set `GROQ_API_KEY` in
`.env.local`; without it the UI falls back to deterministic local phrasing, so
the transcript is never empty or blocked.

Two details that matter:

- **The key is `GROQ_API_KEY`, not `VITE_GROQ_API_KEY`.** Vite inlines `VITE_`
  vars into the renderer bundle; this one is read by the main process so it never
  reaches the UI. The request is also made from main, which no page CSP applies
  to.
- **`GROQ_MODEL` is overridable** (default `qwen/qwen3.8-27b`). Groq retires
  models on its own schedule — the original default vanished from the catalog
  entirely, which turns every call into a 404. Check what exists with:

  ```bash
  curl -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models
  ```

The transcript footer reports narration status, so a missing key or a rejected
request is visible rather than silently degrading to fallback text.

## Signing in to ChatGPT
**"Continue with Google" will not work, and no code change can fix it.** Google
refuses to complete OAuth inside an embedded browser and shows *"This browser or
app may not be secure."* That check does not rely on the user agent — the app
already sends a clean Chrome UA — so it cannot be spoofed away, and attempting
to would be an evasion arms race rather than a fix.

Two paths that do work:

**1. Import a session from Firefox (recommended).** Sign in at chatgpt.com in
Firefox normally, where the login is completely legitimate, then:

```bash
npm run auth:check     # confirm a session cookie is present
npm run auth:import    # copy it into the app
```

Firefox stores cookies as unencrypted SQLite, so the values can be read
directly. The importer re-creates each one inside the `persist:andro-chatgpt`
partition and then **reads them back** to confirm the write landed, so a silent
failure is not possible. It also refuses to run when only anonymous cookies
(Cloudflare, device IDs) are present, since those appear even when signed out.

**2. Sign in with email/password or phone inside the app.** These work in
embedded contexts; they simply do not involve Google.

Note that the imported session is a live credential stored in `.andro-profile/`
(git-ignored). It is readable only by your user account, the same as your
browser's own cookie store. Delete that directory to sign out.

## Verifying it still works

`npm run electron:smoke` is the regression check. A healthy run prints:

```
[smoke] native view bounds: {"x":218,"y":538,"width":1222,"height":300}
"overlap": 0
[smoke] native visible: true
[smoke] chat title: ChatGPT: Chat, Work, Create & Code with AI
```

The native bounds must **equal** the reported `chatRect`. A mismatch means the
DOM and the native layer have drifted apart.

## Files

| Path | Role |
| --- | --- |
| `electron/main.ts` | Main process: window, native view, docking, prompt injection, file IPC. |
| `electron/preload.ts` | The only IPC surface exposed to the renderer (contextBridge). |
| `electron/build.mjs` | Bundles main → ESM and preload → CJS. |
| `electron/dev.mjs` | Dev launcher (Vite + Electron, fixed port). |
| `electron/smoke.mjs` | Layout/bridge regression test. |
| `electron/import-auth.mjs` | Imports a ChatGPT session from a Firefox profile. |
| `src/bridge.ts` | The typed contract both sides implement. |
| `src/ChatSurface.tsx` | Reserved native rect; measures itself and reports geometry. |
| `src/PromptBar.tsx` | Andro-owned composer; submits into the real page. |
| `src/SourcePanel.tsx` | TypeScript source tree + viewer. |

## Notes and limits

- **Login persists** in the `persist:andro-chatgpt` partition, stored under
  `.andro-profile/` in the project. Delete that folder to sign out.
- **Prompt submission is best-effort by design.** ChatGPT's markup is not an API.
  `chat:submit` tries a list of known composer selectors and reports a precise
  failure rather than throwing. Typing + submitting is a small, defensible
  surface; restyling ChatGPT's internal DOM is not, and is deliberately not
  attempted.
- **Do not put Andro controls inside the chat rect.** They will be invisible and
  unclickable once the native view is docked.
