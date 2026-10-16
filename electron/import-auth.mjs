/**
 * Imports a ChatGPT session from a real Firefox profile into the app.
 *
 * WHY THIS EXISTS
 * ---------------
 * Google refuses to complete an OAuth sign-in inside an embedded browser
 * ("This browser or app may not be secure"), and that block is deliberate and
 * cannot be reliably spoofed away. Rather than fight it, this imports a session
 * you created in a normal browser, where the sign-in is completely legitimate.
 *
 * HOW
 * ---
 * Firefox stores cookies as plain SQLite (cookies.sqlite) with unencrypted
 * values, so they can be read directly. Each row is re-created inside the
 * Electron partition that the chat view uses, via session.cookies.set().
 *
 * The result is that the embedded chatgpt.com sees a normal authenticated
 * session without ever performing a sign-in itself.
 *
 *   npm run auth:import
 *   npm run auth:import -- --profile /path/to/profile
 *   npm run auth:import -- --list      (show profiles and what they contain)
 */
import { app, session } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { readdirSync, existsSync, copyFileSync, mkdtempSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CHAT_PARTITION = 'persist:andro-chatgpt'

/** Hosts whose cookies define a ChatGPT/OpenAI session. */
const WANTED_HOSTS = ['chatgpt.com', 'openai.com', 'oaistatic.com', 'oaiusercontent.com']

/**
 * The cookie that actually proves authentication. Cloudflare and device cookies
 * are present even when logged out, so they must not be mistaken for a session.
 */
const SESSION_COOKIE = /session-token|__Secure-next-auth|__Host-next-auth|oai-client-auth/i

const log = (...args) => console.log('[auth]', ...args)

function firefoxRoot() {
  const candidates = [
    path.join(homedir(), '.mozilla', 'firefox'),
    path.join(homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'),
    path.join(homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox'),
  ]
  return candidates.find(existsSync)
}

/** Discover Firefox profiles by locating cookies.sqlite in each directory. */
function findProfiles() {
  const root = firefoxRoot()
  if (!root) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name))
    .filter(dir => existsSync(path.join(dir, 'cookies.sqlite')))
}

/**
 * Open a profile's cookie database.
 *
 * The live file is copied first: Firefox holds a lock while running, and reading
 * a locked WAL database can yield a partial view.
 */
function openCookieDb(profileDir) {
  const source = path.join(profileDir, 'cookies.sqlite')
  const temp = mkdtempSync(path.join(tmpdir(), 'andro-cookies-'))
  const copy = path.join(temp, 'cookies.sqlite')
  copyFileSync(source, copy)
  // Copy the WAL too, if present, so recent writes are included.
  for (const suffix of ['-wal', '-shm']) {
    const extra = `${source}${suffix}`
    if (existsSync(extra)) copyFileSync(extra, `${copy}${suffix}`)
  }
  return new DatabaseSync(copy, { readOnly: true })
}

function readCookies(profileDir) {
  const db = openCookieDb(profileDir)
  try {
    const placeholders = WANTED_HOSTS.map(() => 'host LIKE ?').join(' OR ')
    const params = WANTED_HOSTS.map(h => `%${h}`)
    const rows = db
      .prepare(
        `SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
         FROM moz_cookies
         WHERE ${placeholders}`,
      )
      .all(...params)
    return rows.map(row => ({ ...row }))
  } finally {
    db.close()
  }
}

/** Map Firefox's numeric sameSite to Electron's string form. */
function sameSite(value) {
  // Firefox: 0 = none, 1 = lax, 2 = strict
  if (value === 2) return 'strict'
  if (value === 0) return 'no_restriction'
  return 'lax'
}

function describe(profileDir) {
  try {
    const cookies = readCookies(profileDir)
    const sessionCookie = cookies.find(c => SESSION_COOKIE.test(c.name))
    return { profileDir, count: cookies.length, hasSession: Boolean(sessionCookie), cookies, sessionCookie }
  } catch (error) {
    return { profileDir, error: error instanceof Error ? error.message : String(error), count: 0, hasSession: false, cookies: [] }
  }
}

/* ── main ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2)
const listOnly = args.includes('--list')
const explicitProfile = (() => {
  const i = args.indexOf('--profile')
  return i !== -1 ? args[i + 1] : null
})()

app.setPath('userData', path.join(ROOT, '.andro-profile'))
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache')

app.whenReady().then(async () => {
  const profiles = explicitProfile ? [explicitProfile] : findProfiles()

  if (profiles.length === 0) {
    log('No Firefox profiles with a cookie database were found.')
    log('Pass one explicitly:  npm run auth:import -- --profile /path/to/profile')
    app.exit(1)
    return
  }

  const described = profiles.map(describe)

  if (listOnly) {
    for (const p of described) {
      if (p.error) {
        log(`${p.profileDir}\n    unreadable: ${p.error}`)
        continue
      }
      log(`${p.profileDir}`)
      log(`    openai/chatgpt cookies: ${p.count}`)
      log(`    session cookie: ${p.hasSession ? `YES (${p.sessionCookie.name})` : 'no'}`)
    }
    app.exit(0)
    return
  }

  // Prefer a profile that actually holds a session.
  const usable = described.filter(p => p.hasSession)
  if (usable.length === 0) {
    log('No ChatGPT session cookie found in any Firefox profile.')
    log('')
    for (const p of described) {
      log(`  ${p.profileDir}: ${p.count} chatgpt/openai cookie(s), but no session token`)
    }
    log('')
    log('Cloudflare and device cookies appear even when signed out, so they are')
    log('not enough. Sign in at https://chatgpt.com in Firefox, then re-run:')
    log('')
    log('  npm run auth:import')
    app.exit(1)
    return
  }

  const chosen = usable[0]
  log(`Importing from ${chosen.profileDir}`)
  log(`  found session cookie: ${chosen.sessionCookie.name}`)

  const target = session.fromPartition(CHAT_PARTITION)
  let imported = 0
  let failed = 0

  for (const cookie of chosen.cookies) {
    // Leading dots mark a domain cookie; Electron expects the bare host plus
    // an explicit domain entry in that case.
    const host = cookie.host.replace(/^\./, '')
    const details = {
      url: `${cookie.isSecure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || '/',
      secure: Boolean(cookie.isSecure),
      httpOnly: Boolean(cookie.isHttpOnly),
      sameSite: sameSite(cookie.sameSite),
    }
    // Firefox stores expiry in seconds; 0 means a session cookie.
    if (cookie.expiry) details.expirationDate = cookie.expiry

    try {
      await target.cookies.set(details)
      imported++
    } catch (error) {
      failed++
      log(`  skipped ${cookie.name}: ${error instanceof Error ? error.message : error}`)
    }
  }

  log(`Imported ${imported} cookie(s)${failed ? `, ${failed} skipped` : ''} into ${CHAT_PARTITION}`)

  // Read back from the session to confirm the write actually landed, rather
  // than trusting the set() calls.
  const stored = await target.cookies.get({ domain: 'chatgpt.com' })
  const storedSession = stored.find(c => SESSION_COOKIE.test(c.name))
  log(`Verified in partition: ${stored.length} chatgpt.com cookie(s)`)
  log(
    storedSession
      ? `Session token present: ${storedSession.name}`
      : 'WARNING: session token not found after import',
  )
  log('')
  log(storedSession ? 'Done. Start the app with: npm run electron:dev' : 'Import did not take.')

  app.exit(storedSession ? 0 : 1)
})
