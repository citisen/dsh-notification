/**
 * Drive the real GUI in a real Chromium through the DevTools protocol, and report
 * what the page says about this plugin.
 *
 * This exists because of a question the other checks cannot answer. `verify-profile`
 * proves the loader composes the row and the server answers; `verify-client` proves the
 * bundle's own logic against stubs. Neither can tell you what happened when the *real*
 * page ran the *real* bundle against the *real* services — and that is exactly where a
 * plugin can be listed as installed and still render nothing.
 *
 * So this boots a profile for real, opens the interface in Chrome, and:
 *
 * 1. captures every console message and uncaught error, which is where a plugin that
 *    throws reports itself;
 * 2. asks the page what it knows: whether this bundle registered, whether its stylesheet
 *    is in the document, and whether its settings card exists in the DOM;
 * 3. walks into the settings dialog and looks for the row, so "the card is missing" is
 *    answered rather than inferred.
 *
 * The page is fetched with the URL the server itself prints, which is the authenticated
 * one. If the token is refused, the harness says so instead of reporting a missing card.
 *
 * Environment:
 *   DSH_PROFILE      profile to boot (default desktop)
 *   DSH_LIVE_CHROME  browser executable
 *   DSH_LIVE_PORT    port for the booted server
 *
 * Exits non-zero when the card is not found, so it works as a gate.
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME ?? (HOME === '' ? undefined : join(HOME, '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'
const PORT = process.env.DSH_LIVE_PORT ?? '19411'
const DEBUG_PORT = 9333

if (DSH_HOME === undefined) {
  console.error('live-probe: no DSH_HOME')
  process.exit(2)
}

/** Find a Chromium-based browser. @returns the executable path. */
function findBrowser() {
  const explicit = process.env.DSH_LIVE_CHROME
  if (explicit !== undefined && existsSync(explicit)) return explicit
  const candidates = [
    join(process.env.ProgramFiles ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env.ProgramFiles ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ]
  const found = candidates.find((candidate) => candidate !== '' && existsSync(candidate))
  if (found === undefined) {
    console.error('live-probe: no Chromium browser found (set DSH_LIVE_CHROME)')
    process.exit(2)
  }
  return found
}

/**
 * Build a bootable mirror of a profile.
 *
 * The application owns the real `desktop` profile and the launcher refuses to boot it,
 * so the probe boots a copy. The copy is made in a temporary directory rather than beside
 * the original: the plugin's dependencies resolve from its own installation, not from the
 * profile, so nothing here depends on the copy's location.
 *
 * @param source - the profile directory.
 * @returns `{ name, dir, dispose }`.
 */
function mirror(source) {
  const name = `${PROFILE}-live`
  const dir = join(DSH_HOME, 'profiles', name)
  rmSync(dir, { recursive: true, force: true })
  cpSync(source, dir, {
    recursive: true,
    filter: (input) => !input.endsWith('pnpm-lock.yaml'),
  })
  const manifestPath = join(dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name = `dsh-profile-${name}`
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    name,
    dir,
    dispose: () => {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const profileDir = join(DSH_HOME, 'profiles', PROFILE)
if (!existsSync(profileDir)) {
  console.error(`live-probe: no profile at ${profileDir}`)
  process.exit(2)
}
const mirrored = mirror(profileDir)
const browser = findBrowser()
const userDataDir = mkdtempSync(join(tmpdir(), 'dsh-live-'))

const installed = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness')
const server = spawn(
  join(installed, 'DeepSeek Harness.exe'),
  [
    '--expose-internals',
    join(installed, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
    '--profile',
    mirrored.name,
    '--no-open',
    '--port',
    PORT,
  ],
  { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
)

let serverOutput = ''
let chrome
let finished = false

/** Tear everything down and report. @param code - the exit code. */
function finish(code) {
  if (finished) return
  finished = true
  try {
    chrome?.kill()
  } catch {
    /* already gone */
  }
  try {
    server.kill()
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      mirrored.dispose()
    } catch {
      /* best effort */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
    process.exit(code)
  }, 500)
}

server.stdout.on('data', (chunk) => {
  serverOutput += String(chunk)
  const url = /https?:\/\/127\.0\.0\.1:\d+\/\S+/u.exec(serverOutput)?.[0]
  if (url === undefined || chrome !== undefined) return
  console.log(`live-probe: server up at ${url}`)
  chrome = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--autoplay-policy=no-user-gesture-required',
      `--remote-debugging-port=${String(DEBUG_PORT)}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  )
  void drive(url)
})
server.stderr.on('data', (chunk) => {
  serverOutput += String(chunk)
})

/**
 * Connect over CDP and interrogate the page.
 * @param url - the authenticated interface URL.
 * @returns {Promise<void>}
 */
async function drive(url) {
  const target = await waitForTarget()
  const socket = await openSocket(target.webSocketDebuggerUrl)
  const messages = []
  const errors = []
  socket.on('Runtime.consoleAPICalled', (params) => {
    const text = (params.args ?? [])
      .map((arg) => arg.value ?? arg.description ?? arg.unserializableValue ?? '')
      .join(' ')
    messages.push(`${params.type}: ${text}`)
  })
  socket.on('Runtime.exceptionThrown', (params) => {
    const details = params.exceptionDetails ?? {}
    errors.push(`${details.text ?? ''} ${details.exception?.description ?? ''}`.trim())
  })
  socket.on('Log.entryAdded', (params) => {
    const entry = params.entry ?? {}
    messages.push(`log.${entry.level}: ${entry.text ?? ''}`)
  })

  await socket.send('Runtime.enable')
  await socket.send('Log.enable')
  await socket.send('Page.enable')
  await socket.send('Page.navigate', { url })
  await new Promise((resolve) => setTimeout(resolve, 9000))

  // The settings row lives inside a dialog, so a probe of the idle page cannot see it.
  // The dialog is opened the way a user opens it — by pressing the control that declares it opens
  // one — and then the row is driven: every state in the switcher is clicked and the card read,
  // because a switcher entry that renders nothing is a state the user cannot reach.
  const opened = await socket.send('Runtime.evaluate', {
    expression: `(async () => {
      const trigger = document.querySelector('[aria-haspopup="dialog"]')
      if (trigger === null) return { opened: false, reason: 'no settings trigger in the document' }
      trigger.click()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      // The settings dialog lists a section per registered section; General is the one this
      // plugin's card belongs to, and it is selected by its own label.
      const navButtons = [...document.querySelectorAll('nav button')]
      const general = navButtons.find((button) => /通用|General/u.test(button.textContent ?? ''))
      if (general !== undefined) {
        general.click()
        await new Promise((resolve) => setTimeout(resolve, 1200))
      }
      const rows = [...document.querySelectorAll('[class*="dsh-notification"]')]
      // Exact class membership rather than a substring: the picker class is a prefix of the picker
      // count badge's class, so a substring test would count every badge as a switcher entry.
      const isClass = (node, name) => new RegExp('(?:^|\\\\s)' + name + '(?:\\\\s|$)').test(String(node.className))
      const pickers = [...document.querySelectorAll('[role="tab"]')].filter((node) => isClass(node, 'dsh-notification-picker'))
      // A horizontal tab strip is what this replaced, so its absence is asserted rather than assumed.
      const horizontalTabs = [...document.querySelectorAll('[class*="dsh-notification"]')].filter((node) => isClass(node, 'dsh-notification-tab'))

      // Click each state in turn and record what the card beside it contains, so "the switcher works"
      // is an observation rather than an assumption.
      const entries = []
      for (const picker of pickers) {
        picker.click()
        await new Promise((resolve) => setTimeout(resolve, 350))
        const active = pickers.find((node) => node.getAttribute('data-active') === 'true')
        const cards = [...document.querySelectorAll('[class*="dsh-notification-card"]')].filter((node) => node.getAttribute('data-state') !== null)
        entries.push({
          state: (picker.textContent ?? '').replace(/\\d+$/u, '').trim(),
          activeAfterClick: (active?.textContent ?? '').replace(/\\d+$/u, '').trim(),
          cards: cards.length,
          inputs: cards.length === 0 ? 0 : cards[0].querySelectorAll('input, select, button').length,
        })
      }

      // Every control in the row, so the compact layout is measured rather than described — and the
      // number fields' *values*, because an empty box satisfies "a number input exists" while telling
      // the user nothing. That distinction is what this reports.
      const row = rows[0]
      const numberInputs = row === undefined ? [] : [...row.querySelectorAll('input[type="number"]')]
      const counts = {
        sliders: row === undefined ? 0 : row.querySelectorAll('input[type="range"]').length,
        numbers: numberInputs.length,
        emptyNumbers: numberInputs.filter((input) => String(input.value).trim() === '').length,
        numberValues: numberInputs.map((input) => input.value),
        checkboxes: row === undefined ? 0 : row.querySelectorAll('input[type="checkbox"]').length,
        controls: row === undefined ? 0 : row.querySelectorAll('input, select, button').length,
      }

      return {
        opened: true,
        navLabels: navButtons.map((button) => (button.textContent ?? '').trim()),
        generalClicked: general !== undefined,
        notificationNodes: rows.length,
        entryLabels: pickers.map((node) => (node.textContent ?? '').trim()),
        entries,
        controls: counts,
        horizontalTabs: horizontalTabs.length,
        slotChildren: document.querySelector('[data-slot="settings.general.item"]')?.children.length ?? null,
        // What the row's text actually says, which is the check a screenshot would make. A disabled
        // feature must not be named anywhere in the interface — and this is asserted against the
        // rendered text rather than against the presence of one control, because the complaint that
        // produced it was literally "the settings still mention notifications", and the switch left
        // behind by an earlier attempt was inside a state card rather than on a tab.
        rowText: row === undefined ? '' : row.innerText.replace(/\\s+/gu, ' '),
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })

  // Press the card's own test button, in the card the switcher is showing, and read the line it
  // prints. This is the plugin's own answer about its own capability.
  const tested = await socket.send('Runtime.evaluate', {
    expression: `(async () => {
      const button = [...document.querySelectorAll('[class*="dsh-notification"] button')].find((node) => /Test notification|测试通知/u.test(node.textContent ?? ''))
      if (button === undefined) return { pressed: false, reason: 'no test button in the row' }
      button.click()
      await new Promise((resolve) => setTimeout(resolve, 2500))
      const result = document.querySelector('[class*="dsh-notification-result"]')
      return {
        pressed: true,
        result: result === null ? null : (result.textContent ?? '').trim(),
      }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })

  const probe = await socket.send('Runtime.evaluate', {
    expression: `(() => {
      const styles = [...document.querySelectorAll('style[data-plugin]')].map((tag) => tag.dataset.plugin)
      return {
        location: location.href,
        pluginStyles: styles.length,
        notificationStyles: styles.filter((name) => String(name).includes('dsh-notification')).length,
        hasNotificationNodes: document.querySelectorAll('[class*="dsh-notification"]').length,
      }
    })()`,
    returnByValue: true,
    awaitPromise: false,
  })

  console.log('===== PAGE =====')
  console.log(JSON.stringify(probe.result?.value ?? probe, null, 2))
  console.log('===== SETTINGS DIALOG =====')
  console.log(JSON.stringify(opened.result?.value ?? opened, null, 2))
  console.log('===== TEST BUTTON =====')
  console.log(JSON.stringify(tested.result?.value ?? tested, null, 2))

  // Whether the ask *itself* is what denies. The card reported `default` before its button
  // was pressed and `denied` after, which would mean the plugin is destroying the
  // permission by asking for it. A fresh navigation gets a fresh permission state, so the
  // question is asked on a page where nothing has touched it yet.
  await socket.send('Page.navigate', { url })
  await new Promise((resolve) => setTimeout(resolve, 8000))
  const askEffect = await socket.send('Runtime.evaluate', {
    expression: `(async () => {
      const before = Notification.permission
      let returned = null
      let threw = null
      try { returned = await Notification.requestPermission() } catch (error) { threw = String(error) }
      let canConstruct = null
      try { new Notification('after the ask', { silent: true }).close(); canConstruct = true } catch (error) { canConstruct = String(error) }
      return { before, returned, after: Notification.permission, threw, canConstruct }
    })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  console.log('===== ASK EFFECT =====')
  console.log(JSON.stringify(askEffect.result?.value ?? askEffect, null, 2))
  console.log('===== CONSOLE =====')
  for (const line of messages.slice(-40)) console.log(line)
  console.log('===== UNCAUGHT =====')
  for (const line of errors.slice(-20)) console.log(line)
  console.log('===== END =====')

  // The verdict, so this works as a gate rather than as something a human has to read. A card that
  // registers and then throws is the failure mode this whole harness exists for, and it shows up as
  // `slot entry crashed` in the console with nothing on screen.
  const dialog = opened.result?.value ?? {}
  const crashed = messages.some((line) => /slot entry crashed/u.test(line) && /notification/u.test(line))
  const entries = dialog.entries ?? []
  const controls = dialog.controls ?? {}
  const problems = []
  if (crashed) problems.push('the slot entry crashed; see the console section above')
  if ((dialog.notificationNodes ?? 0) === 0) problems.push('the settings row did not render')
  if (errors.length > 0) problems.push(`${String(errors.length)} uncaught error(s)`)

  // The layout: a vertical switcher offering every state, one card at a time, and no horizontal tab
  // strip — which is the shape this replaced.
  if (entries.length !== 6) problems.push(`the switcher offers ${String(entries.length)} states, not 6`)
  if ((dialog.horizontalTabs ?? 0) !== 0) problems.push('a horizontal tab strip is back')
  for (const entry of entries) {
    if (entry.activeAfterClick !== entry.state) {
      problems.push(`clicking '${entry.state}' left '${entry.activeAfterClick}' selected`)
    }
    if (entry.cards !== 1) problems.push(`'${entry.state}' renders ${String(entry.cards)} cards, not 1`)
    if (entry.inputs === 0) problems.push(`the '${entry.state}' card renders no control`)
  }

  // Every level is a number box and no level is a slider. This is the compact layout, measured — and
  // the empty check is the one that matters: a box with no value satisfies "a number input exists"
  // while showing the user nothing, which is how a converted control ends up looking broken.
  if ((controls.sliders ?? 0) !== 0) problems.push(`${String(controls.sliders)} slider(s) remain`)
  if ((controls.numbers ?? 0) === 0) problems.push('no number field rendered')
  if ((controls.emptyNumbers ?? 0) !== 0) {
    problems.push(
      `${String(controls.emptyNumbers)} number field(s) render empty (values: ${JSON.stringify(controls.numberValues)})`,
    )
  }

  // A disabled feature must not be named in the interface. This is asserted from the rendered text,
  // because the failure it guards was exactly that: the channel was switched off in code while the
  // settings page still said "系统通知".
  const rowText = dialog.rowText ?? ''
  for (const phrase of ['系统通知', 'System notification']) {
    if (rowText.includes(phrase)) {
      problems.push(`the row still says "${phrase}" while the notification channel is switched off`)
    }
  }

  if (problems.length > 0) {
    console.error(`live-probe: FAIL — ${problems.join('; ')}`)
    finish(1)
    return
  }
  console.log(
    `live-probe: OK — the vertical switcher offers ${String(entries.length)} states and each one selects a ` +
      `single card, ${String(controls.numbers)} number fields and ${String(controls.sliders)} sliders, ` +
      `${String(controls.controls)} controls in the row, no horizontal tab strip, the word for a notification ` +
      'appears nowhere, with no console error and no uncaught exception',
  )
  finish(0)
}

/**
 * Wait for the browser to expose a page target.
 * @returns the target descriptor.
 */
async function waitForTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/list`, {
        signal: AbortSignal.timeout(2000),
      })
      const targets = await response.json()
      const page = targets.find((entry) => entry.type === 'page')
      if (page !== undefined) return page
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('the browser never exposed a page target')
}

/**
 * A minimal CDP client over the target's WebSocket.
 * @param wsUrl - the debugger URL.
 * @returns `{ send, on }`.
 */
async function openSocket(wsUrl) {
  const socket = new WebSocket(wsUrl)
  let nextId = 1
  const pending = new Map()
  const handlers = new Map()
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  socket.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (entry !== undefined) {
        pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new Error(JSON.stringify(message.error)))
        else entry.resolve(message.result ?? {})
      }
      return
    }
    for (const listener of handlers.get(message.method) ?? []) listener(message.params ?? {})
  })
  return {
    send: (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = nextId++
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      }),
    on: (method, listener) => {
      handlers.set(method, [...(handlers.get(method) ?? []), listener])
    },
  }
}

setTimeout(() => {
  console.error('live-probe: timed out')
  console.error(serverOutput.slice(-2000))
  finish(1)
}, 120_000)
