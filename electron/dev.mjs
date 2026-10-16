/**
 * Dev launcher: builds the Electron entry points, starts Vite, waits for it to
 * serve, then launches Electron pointed at that URL.
 *
 * A fixed port is used (strictPort) so the URL handed to Electron is
 * deterministic — otherwise Vite silently falls through to 5174, 5175… and the
 * Electron window loads the wrong thing or nothing at all.
 */
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const PORT = Number(process.env.ANDRO_PORT || 5273)
const URL = `http://localhost:${PORT}/`

const children = []
let shuttingDown = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM')
  }
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
    ...options,
  })
  children.push(child)
  return child
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* not up yet */
    }
    await delay(250)
  }
  return false
}

// 1. Compile main + preload.
await new Promise((resolve, reject) => {
  const build = run(process.execPath, [path.join(__dirname, 'build.mjs')])
  build.on('exit', code => (code === 0 ? resolve() : reject(new Error(`build failed (${code})`))))
})

// 2. Start Vite on the agreed port.
run('npx', ['vite', '--port', String(PORT), '--strictPort'])

if (!(await waitForServer(URL))) {
  console.error(`[andro] Vite did not come up at ${URL}`)
  shutdown(1)
}

// 3. Launch Electron against it.
run('npx', ['electron', '.'], {
  env: { ...process.env, ANDRO_DEV_URL: URL },
}).on('exit', code => shutdown(code ?? 0))
