/**
 * Bundles the Electron main and preload entry points.
 *
 * The main process is bundled to ESM (the package is "type": "module"), while
 * the preload is bundled to CommonJS as `preload.cjs` — Electron's preload
 * loader requires a script it can execute outside the page's module graph, and
 * contextBridge must be available synchronously at load time.
 *
 * Electron is marked external so the runtime's own module is used rather than
 * being bundled.
 */
import { build, context } from 'esbuild'
import { copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  sourcemap: true,
  logLevel: 'info',
}

const targets = [
  {
    ...common,
    entryPoints: ['electron/main.ts'],
    outfile: 'electron/dist/main.mjs',
    format: 'esm',
  },
  {
    ...common,
    entryPoints: ['electron/preload.ts'],
    outfile: 'electron/dist/preload.cjs',
    format: 'cjs',
  },
]

if (watch) {
  for (const options of targets) {
    const ctx = await context(options)
    await ctx.watch()
  }
  console.log('[electron] watching main + preload…')
} else {
  await Promise.all(targets.map(options => build(options)))
  // The chat relay preload is loaded by path from the chat session, so it is
  // copied next to the bundled main rather than bundled into it.
  await copyFile(
    fileURLToPath(new URL('./chat-relay.cjs', import.meta.url)),
    fileURLToPath(new URL('./dist/chat-relay.cjs', import.meta.url)),
  )
  console.log('[electron] built main + preload + chat relay')
}
