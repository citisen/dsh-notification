/**
 * Boot the real dsh with a profile and check that this plugin is part of it.
 *
 * This is the last check and the only one that answers questions the other two
 * cannot, because they both stub the platform away:
 *
 * 1. **Does the loader accept the bundle patch?** `cordis.patch.yml` inserts one row,
 *    and a malformed patch, an id that collides, or a package that does not resolve
 *    is a boot failure in this application rather than a missing plugin.
 * 2. **Does the host half activate?** `apply()` runs against the *real* settings
 *    service, so a schema that the service refuses — a field that is not volatile, a
 *    type it cannot represent — surfaces here rather than as a settings page that
 *    silently saves nothing.
 * 3. **Does the browser half reach the page?** The client-modules roster scans live
 *    loader entries for packages declaring `dsh.client` and serves the bundle from
 *    `/plugins`, so a missing `lib/client.js`, a stale build, or a bad `dsh.client`
 *    block is a plugin that never arrives.
 *
 * The server is booted on a spare port with `--no-open`, asked for its composed tree,
 * and then fetched. Everything is torn down afterwards.
 *
 * Usage:
 *   node scripts/verify-profile.mjs
 *
 * Environment:
 *   DSH_PROFILE   Profile to boot (default desktop)
 *   DSH_REQUIRE   Set to 1 to fail instead of skipping when dsh cannot be found
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME ?? (HOME === '' ? undefined : join(HOME, '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const PORT = process.env.DSH_PROFILE_PORT ?? '19407'

/** Give up (or fail, under DSH_REQUIRE) because dsh is not usable here. */
function skip(reason) {
  console.log(`verify-profile: SKIP — ${reason}`)
  if (process.env.DSH_REQUIRE === '1') {
    console.error('verify-profile: DSH_REQUIRE=1, treating the skip as a failure')
    process.exit(1)
  }
  process.exit(0)
}

/**
 * Resolve how to run dsh.
 *
 * The desktop application is an Electron shell, and its CLI is that binary re-run
 * as plain Node via `ELECTRON_RUN_AS_NODE` — which is what the shipped `dsh.cmd`
 * launcher does. This resolves both halves itself rather than going through the
 * launcher's batch file, because the installation path contains spaces and handing
 * that to a shell is a quoting problem with no upside: spawning the executable
 * directly needs no shell at all.
 *
 * @returns `{ command, prefixArgs, env }`, or undefined.
 */
function resolveRunner() {
  const explicitCli = process.env.DSH_CLI
  const localAppData = process.env.LOCALAPPDATA ?? ''
  const installed = join(localAppData, 'Programs', 'DeepSeek Harness')
  const candidates = explicitCli === undefined ? [] : [explicitCli]
  candidates.push(
    join(localAppData, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
    '/usr/local/bin/dsh',
    '/usr/bin/dsh',
  )
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) return undefined
  const binary = join(installed, 'DeepSeek Harness.exe')
  const cli = join(
    installed,
    'resources',
    'app.asar',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-desktop-host',
    'lib',
    'cli.js',
  )
  // The shipped `dsh.cmd` does exactly this: re-run the application binary as plain
  // Node (`ELECTRON_RUN_AS_NODE`) with the desktop host's CLI script. Doing the same
  // here avoids the batch file entirely — which matters because Node's own argument
  // quoting for `cmd.exe` produces `\"path\"`, a form the interpreter reads as a
  // literal quote rather than as a quoted path.
  //
  // The CLI script is inside the asar archive, so `existsSync` cannot confirm it from
  // outside Electron; the path is derived from the installation layout the launcher
  // itself uses, and a wrong path fails loudly on the first run.
  if (existsSync(binary)) {
    return {
      command: binary,
      prefixArgs: ['--expose-internals', cli],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      shell: false,
    }
  }
  return { command: found, prefixArgs: [], env: {}, shell: true }
}

const runner = resolveRunner()
if (runner === undefined) skip('no dsh launcher found (set DSH_CLI to one)')

const profileDir = DSH_HOME === undefined ? undefined : join(DSH_HOME, 'profiles', PROFILE)
if (profileDir === undefined || !existsSync(profileDir)) {
  skip(`no profile at ${String(profileDir)}`)
}

/**
 * Build the profile to boot.
 *
 * The `desktop` profile cannot be booted from a command line: the application owns it
 * and the launcher refuses — "profile desktop is managed exclusively by the Electron
 * application". That refusal is correct, and it is also the reason this check needs a
 * profile of its own rather than a weaker assertion: booting a *copy* is the only way
 * to ask the real loader about the real bundle.
 *
 * The copy is made beside the original rather than in a temporary directory on purpose.
 * A profile's `node_modules` is where a plugin's dependencies resolve, and moving it
 * across volumes would break the symlinks and the junction that points at this
 * checkout — which is exactly the kind of breakage this check exists to catch. It is
 * small (under a megabyte) and it is removed when the check finishes.
 *
 * @param source - the profile directory.
 * @returns `{ dir, dispose }`.
 */
function mirrorProfile(source) {
  const name = `${PROFILE}-verify`
  const dir = join(dirname(source), name)
  rmSync(dir, { recursive: true, force: true })
  cpSync(source, dir, {
    recursive: true,
    // `pnpm-lock.yaml` is deliberately excluded: this is a copy for a boot, not a
    // workspace to install into, and carrying the lock file invites an install that
    // would rewrite it.
    filter: (input) => basename(input) !== 'pnpm-lock.yaml',
  })
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name = `dsh-profile-${name}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return {
    dir,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const mirror = mirrorProfile(profileDir)
const manifest = JSON.parse(readFileSync(join(mirror.dir, 'package.json'), 'utf8'))
const bundleList = manifest.dsh?.profile?.bundles ?? []
if (!bundleList.includes('@citisen/dsh-notification')) {
  mirror.dispose()
  skip(
    `the ${PROFILE} profile does not list this package in dsh.profile.bundles, so booting it would ` +
      'not prove anything',
  )
}
process.on('exit', () => {
  try {
    mirror.dispose()
  } catch {
    /* best effort: a leftover directory is better than a thrown exit handler */
  }
})
const VERIFY_PROFILE = `${PROFILE}-verify`

/**
 * Run the launcher and collect its output.
 * @param args - the arguments.
 * @param options - `{ timeoutMs, killOn }`.
 * @returns `{ code, stdout, stderr }`.
 */
function run(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(runner.command, [...runner.prefixArgs, ...args], {
      cwd: root,
      shell: runner.shell === true,
      env: { ...process.env, ...runner.env, DSH_NO_TELEMETRY: '1' },
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: null, stdout, stderr, timedOut: true })
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
      options.onStdout?.(stdout, child)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: null, stdout, stderr: `${stderr}\n${String(error)}` })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

// ── 1. the loader composes the row ──────────────────────────────────────────

const dump = await run(['--profile', VERIFY_PROFILE, '--dump-config'])
assert.ok(!dump.timedOut, '--dump-config must not hang')
assert.equal(dump.code, 0, `--dump-config must succeed:\n${dump.stderr}`)
assert.match(
  dump.stdout,
  /dsh-notification/u,
  'the composed profile tree must mention this package; a patch that did not apply is a plugin that ' +
    'is not part of the boot',
)
assert.match(
  dump.stdout,
  /notification/u,
  'the composed tree must carry the row id the settings namespace is keyed on',
)

// ── 2. the boot serves the interface, and this plugin's bundle is in it ─────

/**
 * What the live server said, collected while it was running.
 *
 * The server is asked for its page *while it is up* rather than after it exits: it
 * is an ordinary web server that keeps running, so its output has to be watched for
 * the URL it prints, and the page fetched at that moment. A `--no-open` boot is
 * otherwise a process that never returns, which is why the fetch kills it.
 */
const live = { url: undefined, response: undefined, error: undefined, done: undefined }

const boot = await run(['--profile', VERIFY_PROFILE, '--no-open', '--port', PORT], {
  timeoutMs: 120_000,
  onStdout: (output, child) => {
    if (live.url !== undefined) return
    const found = /https?:\/\/127\.0\.0\.1:\d+\/\S*/u.exec(output)?.[0]
    if (found === undefined) return
    live.url = found
    live.done = (async () => {
      try {
        const response = await fetch(found, { signal: AbortSignal.timeout(15_000) })
        live.response = { status: response.status, body: await response.text() }
      } catch (error) {
        live.error = error
      } finally {
        child.kill()
      }
    })()
  },
})
if (live.done !== undefined) await live.done

const combined = `${boot.stdout}\n${boot.stderr}`

// A boot failure in this application is loud, and silence is not a pass: an entry
// that never activates refuses the boot outright rather than dropping a plugin.
assert.ok(
  !/did not activate|Failed to load plugins|fatal/iu.test(combined),
  `the boot must not report a failed plugin or a fatal error:\n${combined}`,
)

assert.ok(live.url !== undefined, `the server must report a URL. Output tail:\n${combined.slice(-3000)}`)
assert.equal(live.error, undefined, `fetching ${String(live.url)} must succeed: ${String(live.error)}`)

// The server answers, which is what this half is for: it proves the web application
// reached the point of listening, with every entry activated. It does **not** prove
// the page renders, and that is not a gap to paper over: the URL's token is minted for
// the Electron shell, which exchanges it for a session cookie through its own native
// fetch, so a plain request from here is refused with 401 by design. Both answers are
// accepted, and the body is asserted for whichever arrived — a 200 has to carry the
// boot graph, and a 401 has to be the authentication refusal rather than a crash.
assert.ok(
  live.response.status === 200 || live.response.status === 401,
  `the interface must answer (got ${String(live.response.status)})`,
)
if (live.response.status === 200) {
  assert.match(live.response.body, /__DSH_BOOT__/u, 'the page must carry the boot graph the shell reads')
  assert.match(live.response.body, /plugins\//u, 'the page must reference the plugin bundle route')
} else {
  assert.match(
    live.response.body,
    /authentication/u,
    'a 401 must be the authentication refusal, not an error from a half-built server',
  )
}

// And the artifact the roster will serve is the one this checkout built, which is the
// question a 401 leaves open. A missing or stale `lib/client.js` is a plugin that never
// arrives, and the host's own composition refuses to boot with one — so this closes the
// loop the HTTP check cannot.
const bundlePath = join(root, 'lib', 'client.js')
assert.ok(existsSync(bundlePath), 'lib/client.js must exist: the client-modules host serves it to the browser')
const built = readFileSync(bundlePath, 'utf8')
assert.match(built, /__ModuleLoader__/u, 'the served bundle must register a module row')
assert.match(built, /dsh-notification/u, 'the served bundle must carry this plugin’s identity')

console.log(
  `verify-profile: OK — the '${VERIFY_PROFILE}' mirror composes the row, boots with no failed plugin, ` +
    `answers on ${String(live.url)} (${String(live.response.status)}), and ships ${String(built.length)} bytes ` +
    'of client bundle',
)
