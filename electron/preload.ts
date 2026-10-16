/**
 * Preload script — the ONLY place with access to both Electron IPC and the page.
 *
 * This implements the AndroBridge contract declared in src/bridge.ts. Every
 * method here is a thin, typed passthrough over ipcRenderer; all real work
 * (docking the native view, driving chatgpt.com) happens in the main process,
 * which is the only context that can reach other WebContents.
 *
 * Security posture: contextIsolation stays ON and nodeIntegration stays OFF, so
 * this file is the entire attack surface exposed to the renderer. It exposes a
 * fixed, auditable set of operations — never ipcRenderer itself.
 */
import { contextBridge, ipcRenderer } from 'electron'

const api = {
  version: 1 as const,

  dockChatSurface: (rect: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('chat:dock', rect)
  },

  hideChatSurface: () => {
    ipcRenderer.send('chat:hide')
  },

  submitPrompt: (text: string) => ipcRenderer.invoke('chat:submit', text),

  readSourceFile: (path: string) => ipcRenderer.invoke('fs:read', path),

  writeSourceFile: (path: string, content: string) => ipcRenderer.invoke('fs:write', path, content),

  /**
   * Ask the main process to narrate tool calls via Groq. Kept in main so the
   * API key never reaches the renderer bundle and no page CSP can block it.
   */
  describeActivity: (items: Record<string, unknown>) =>
    ipcRenderer.invoke('narration:describe', { items }),

  onChatSurfaceState: (listener: (state: unknown) => void) => {
    const handler = (_event: unknown, state: unknown) => listener(state)
    ipcRenderer.on('chat:state', handler)
    return () => {
      ipcRenderer.off('chat:state', handler)
    }
  },

  /** Assistant/user messages scraped from the ChatGPT page. */
  onChatMessages: (listener: (payload: unknown) => void) => {
    const handler = (_event: unknown, payload: unknown) => listener(payload)
    ipcRenderer.on('chat:messages', handler)
    return () => {
      ipcRenderer.off('chat:messages', handler)
    }
  },
}

contextBridge.exposeInMainWorld('andro', api)
