/**
 * Cross-platform smoke test runner.
 *
 * Builds the Electron entry points, then launches Electron with ANDRO_SMOKE=1 so
 * the main process probes the live renderer (bridge presence, component mounts,
 * native dock geometry, prompt-bar overlap) and exits.
 *
 * This exists so the native/HTML boundary can be verified without a human at the
 * keyboard — the geometry assertions are the whole point.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const buildCode = await new Promise(resolve => {
  const build = spawn(process.execPath, [path.join(__dirname, 'build.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  build.on('exit', code => resolve(code ?? 1))
})

if (buildCode !== 0) {
  console.error('[smoke] build failed')
  process.exit(buildCode)
}

const electron = spawn('npx', ['electron', '.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ANDRO_SMOKE: '1' },
})

electron.on('exit', code => process.exit(code ?? 0))
