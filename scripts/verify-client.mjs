/**
 * Load the emitted client bundle in Node, assert its envelope, and drive its pure
 * half against injected clocks, storages, and stubs.
 *
 * A broken client bundle otherwise fails only in the browser, where the diagnostic
 * is a console error inside a boot audit. This check makes the cheap-to-catch
 * failures fail on the command line: a bundle that registers nothing, a factory
 * that throws, a translation that lost a key, a state machine that fires on a level
 * instead of an edge, a chime that plays while the user is reading the screen, a
 * banner that claims to have been shown when the permission was refused.
 *
 * It drives the **emitted bundle** rather than the sources, because the build is
 * the step that could have mangled them: the modules are spliced into one scope by
 * a hand-written inliner, and a name that collided or an import that survived would
 * be invisible in `src/` and fatal in the browser.
 *
 * Usage:
 *   node scripts/verify-client.mjs [path/to/lib/client.js]
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundlePath = resolve(process.argv[2] ?? join(root, 'lib', 'client.js'))
const source = readFileSync(bundlePath, 'utf8')
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

// ── the loader stubs ────────────────────────────────────────────────────────
//
// The bundle is a classic script whose only allowed requests are the platform
// singletons the shell seeds. Anything else would fail in the browser at
// materialization, so the stub throws instead of answering.

/** A React stub: enough to build a tree and hold hook state. */
function createReactStub() {
  const slots = []
  let index = 0
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => {
      if (slots.length <= index) slots.push(value)
      const at = index
      index += 1
      return [
        slots[at],
        (next) => {
          slots[at] = typeof next === 'function' ? next(slots[at]) : next
        },
      ]
    },
    /** Reset the hook cursor before each render. */
    __reset: () => {
      index = 0
    },
  }
}

const react = createReactStub()

/** A tiny observable store, matching the `@deepseek-ai/dsh-client-store` face. */
function createStoreStub() {
  const handles = []
  return {
    handles,
    defineStore: (decl) => {
      const listeners = new Set()
      const store = {
        state: decl.init(),
        getSnapshot() {
          return this.state
        },
        update(mutator) {
          mutator(this.state)
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
      // The real `create()` returns `{ actions, getSnapshot, subscribe, ... }` —
      // actions are **not** at the top level, which is a contract this check has to
      // reproduce or the plugin can pass here and fail in the browser.
      const handle = {
        spec: decl,
        create: () => ({
          actions: Object.fromEntries(
            Object.entries(decl.actions).map(([name, mutate]) => [
              name,
              (...params) => {
                store.update((draft) => {
                  mutate(draft, ...params)
                })
              },
            ]),
          ),
          getSnapshot: () => store.getSnapshot(),
          subscribe: (listener) => store.subscribe(listener),
          store,
        }),
      }
      handles.push({ handle, store })
      return handle
    },
  }
}

const storeStub = createStoreStub()

/** The module table the shell seeds. An unlisted request is a build bug. */
const MODULES = {
  react,
  'react/jsx-runtime': { jsx: react.createElement, jsxs: react.createElement },
  'react-dom': {},
  'react-dom/client': {},
  '@deepseek-ai/cordis': {},
  '@deepseek-ai/dsh-client-store': storeStub,
  '@deepseek-ai/dsh-client-ui-slots': {},
  '@deepseek-ai/dsh-client-ui-primitives': {},
  '@deepseek-ai/dsh-client-ui-dockkit': {},
}

// ── load the bundle as the browser would ────────────────────────────────────

/** What the bundle registered. */
const registered = []
globalThis.window = {
  __ModuleLoader__: {
    load: (row) => {
      registered.push(row)
    },
  },
}

// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)

assert.equal(registered.length, 1, 'the bundle must register exactly one module row')
const row = registered[0]
assert.equal(row.id, PACKAGE_NAME, 'the bundle id must equal the package name')
assert.equal(typeof row.factory, 'function', 'the row must register a factory')

const requested = []
const exports_ = row.factory((spec) => {
  requested.push(spec)
  if (!Object.hasOwn(MODULES, spec)) {
    throw new Error(`the bundle requested "${spec}", which is not a platform singleton`)
  }
  return MODULES[spec]
})

delete globalThis.window

for (const spec of requested) {
  assert.ok(
    ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-store'].includes(spec),
    `the bundle must not require ${spec}`,
  )
}

assert.equal(typeof exports_.apply, 'function', 'the bundle must export apply')
assert.ok(Array.isArray(exports_.inject), 'the bundle must export inject')
assert.equal(exports_.NOTIFICATION_NAMESPACE, 'notification')
assert.equal(exports_.PLUGIN_ID, PACKAGE_NAME, 'the bundle must carry its own identity')

/** Every name the verifier drives, so an envelope that lost one fails here. */
const REQUIRED_EXPORTS = [
  'STATE_KINDS',
  'stateOf',
  'observe',
  'diffStatus',
  'createFailureLog',
  'readMelody',
  'noteFrequency',
  'schedule',
  'createPlayer',
  'permissionState',
  'createNotifier',
  'planEvent',
  'buildBanner',
  'createSpeechLog',
  'gapElapsed',
  'firstAudible',
  'allBannered',
  'resolveSettings',
  'defaultSection',
  'admit',
  'soundAllowed',
  'stateGain',
  'stateVoice',
  'renderTemplate',
  'fitLine',
  'clockTime',
]
for (const name of REQUIRED_EXPORTS) {
  assert.ok(name in exports_, `the bundle must export ${name}`)
}

// ── the translation contract ────────────────────────────────────────────────

const zhKeys = Object.keys(exports_.zh).sort()
const enKeys = Object.keys(exports_.en).sort()
assert.deepEqual(
  enKeys,
  zhKeys,
  'both dictionaries must have the same keys: the English one is checked against the Chinese one, ' +
    'which is the key-set source of truth',
)
assert.deepEqual(exports_.MESSAGE_KEYS.sort(), zhKeys)

// Every state a card renders needs a name, and every option a dropdown offers
// needs a label — the two closed vocabularies the row draws on.
const requiredCopy = [
  'notification.title',
  'notification.description',
  ...exports_.STATE_KINDS.map((kind) => `notification.state.${kind}`),
  ...exports_.SOUND_SCOPES.map((scope) => `notification.soundScope.${scope}`),
]
for (const key of requiredCopy) {
  assert.ok(zhKeys.includes(key), `the dictionaries must carry ${key}`)
}

// Every voice needs a label and a hint, because a card renders both as the option
// text and the tooltip that explains it.
for (const [name, voice] of Object.entries(exports_.VOICES)) {
  assert.equal(typeof voice.label, 'string', `${name} needs a label`)
  assert.equal(typeof voice.hint, 'string', `${name} needs a hint`)
}

// ── the stylesheet ─────────────────────────────────────────────────────────

assert.ok(exports_.ROW_CSS.length > 1000, 'the row must ship a stylesheet')
// Every colour is a design token. A literal colour is how a plugin stops
// following the interface's theme switch, and it is visible from here.
const literals = exports_.ROW_CSS.match(/(?:^|[:\s(])(#[0-9a-fA-F]{3,8}|rgb\(|rgba\()/gu) ?? []
assert.deepEqual(literals, [], 'the stylesheet must use --dsw-* tokens rather than literal colours')
for (const token of ['--dsw-alias-label-primary', '--dsw-alias-border-l4']) {
  assert.ok(exports_.ROW_CSS.includes(token), `the stylesheet must use ${token}`)
}

// ── the state machine, on the shipped bundle ────────────────────────────────

/** @param rows - `[id, row]` pairs. @returns a list snapshot. */
const listOf = (rows) => ({ phase: 'ready', ids: rows.map(([id]) => id), byId: Object.fromEntries(rows) })
/** @param entries - `[id, entry]` pairs. @returns a status snapshot. */
const statusOf = (entries) => new Map(entries)

// A baseline produces nothing; the next observation produces the edge.
const baseline = exports_.observe(statusOf([['a', { running: true }]]), listOf([['a', { title: 'Deploy' }]]))
assert.deepEqual(exports_.diffStatus(undefined, baseline), [], 'the first observation is a baseline')
const started = exports_.observe(statusOf([['a', { running: true }]]), listOf([['a', { title: 'Deploy' }]]))
assert.deepEqual(exports_.diffStatus(baseline, started), [], 'an unchanged level is not an edge')

const waited = exports_.observe(
  statusOf([['a', { running: true, pendingInteraction: { kind: 'question', questions: [{ question: 'Which file?' }] } }]]),
  listOf([['a', { title: 'Deploy' }]]),
)
const events = exports_.diffStatus(baseline, waited)
assert.equal(events.length, 1)
assert.equal(events[0].kind, 'question')
assert.equal(events[0].title, 'Deploy')
assert.equal(events[0].summary, 'Which file?')

// ── the engine, on the shipped bundle ──────────────────────────────────────

const shipped = exports_.resolveSettings(undefined)
const granted = { supported: true, permission: 'granted', canAsk: false }
const hidden = { visible: false, focused: false }
const watching = { visible: true, focused: true }

// Two facts about the *shipped* configuration that shape every assertion below, read from the
// bundle rather than restated: the banner channel is switched off in code, and a banner path is
// therefore only reachable when it is passed as live. Asserting the shipped state first means a
// future change to the switch fails here rather than quietly rewriting what these tests cover.
assert.equal(exports_.NOTIFICATIONS_ENABLED, false, 'the banner channel ships switched off')
const live = { notificationsEnabled: true }
const dark = { notificationsEnabled: false }

const plan = exports_.planEvent({
  event: events[0],
  settings: shipped,
  counts: { question: 1 },
  stateLabel: 'Waiting for an answer',
  permission: granted,
  visibility: hidden,
  now: 1000,
  ...live,
})
assert.equal(plan.admit, true)
assert.equal(plan.banner.title, 'Deploy is asking')
assert.equal(plan.banner.tag, 'question:a')
assert.notEqual(plan.sound, undefined)

// With the channel switched off — which is how it ships — the same event produces the same bell
// and no banner at all. This is the assertion that the hard-coded switch actually switches
// something off, rather than being a comment.
const shippedPlan = exports_.planEvent({
  event: events[0],
  settings: shipped,
  counts: { question: 1 },
  stateLabel: 'Waiting for an answer',
  permission: granted,
  visibility: hidden,
  now: 1000,
  ...dark,
})
assert.equal(shippedPlan.admit, true)
assert.equal(shippedPlan.banner, undefined, 'the shipped configuration must plan no banner')
assert.notEqual(shippedPlan.sound, undefined, 'and must still ring')

// The user is reading the interface: no chime, but the banner still earns its place
// because the session it names is not the one on screen.
const whileWatching = exports_.planEvent({
  event: events[0],
  settings: shipped,
  permission: granted,
  visibility: watching,
  now: 1000,
  ...live,
})
assert.equal(whileWatching.sound, undefined)
assert.notEqual(whileWatching.banner, undefined)

// The session the user is looking at is not news.
assert.equal(
  exports_.planEvent({
    event: { ...events[0], isMain: true },
    settings: shipped,
    permission: granted,
    visibility: watching,
    now: 1000,
    ...live,
  }).admit,
  false,
)

// A refused permission does **not** suppress the banner, and this assertion is the point of
// a bug fix rather than a detail: the desktop shell reports `denied` while the constructor
// still works, so gating on the permission withheld banners the platform would have shown.
// The only thing that suppresses a banner is an environment with no notification API.
const refused = exports_.planEvent({
  event: events[0],
  settings: shipped,
  permission: { supported: true, permission: 'denied', canAsk: false },
  visibility: hidden,
  now: 1000,
  ...live,
})
assert.notEqual(refused.banner, undefined, 'a denied permission must not suppress the banner')
assert.equal(refused.suppressed, undefined)

const noApi = exports_.planEvent({
  event: events[0],
  settings: shipped,
  permission: { supported: false, permission: 'unsupported' },
  visibility: hidden,
  now: 1000,
  ...live,
})
assert.equal(noApi.banner, undefined, 'no notification API means nothing to try with')
assert.equal(noApi.suppressed, 'unsupported')

// ── the sound, on the shipped bundle ───────────────────────────────────────

const phrase = exports_.readMelody('G4:170ms G4:170ms G4:170ms Eb4:680ms')
assert.deepEqual(phrase.problems, [])
assert.equal(exports_.melodyLengthMs(phrase.notes), 1190)
const envelope = exports_.schedule(phrase.notes, 'bell', { gain: 0.5, startAt: 0 })
assert.equal(envelope.events.length, 4)
assert.equal(envelope.events[0].gain, 0.5)
assert.ok(envelope.events[3].stopsAt > envelope.events[3].decayEndsAt)

// Every shipped melody must parse: a default nobody can read is a silent default.
for (const kind of exports_.STATE_KINDS) {
  const read = exports_.readMelody(exports_.STATE_DEFAULTS[kind].melody)
  assert.deepEqual(read.problems, [], `the shipped ${kind} melody must parse`)
  assert.equal(read.silent, false, `the shipped ${kind} melody must make a sound`)
}

// ── the notifier, on the shipped bundle ────────────────────────────────────

const shown = []
function FakeNotification(title, settings) {
  this.title = title
  this.settings = settings
  this.listeners = new Map()
  this.addEventListener = (name, listener) => {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener])
  }
  this.close = () => undefined
  shown.push(this)
}
FakeNotification.permission = 'granted'
FakeNotification.requestPermission = () => Promise.resolve('granted')

const notifier = exports_.createNotifier({ view: { Notification: FakeNotification }, onClick: () => undefined })
assert.deepEqual(notifier.show({ title: 'T', body: 'B', tag: 'x' }), { shown: true, reason: 'shown' })
assert.equal(shown.length, 1)
assert.equal(shown[0].settings.silent, true, 'the banner must not double the chime the plugin makes')

const noPermission = exports_.createNotifier({ view: {} })
assert.equal(noPermission.show({ title: 'T' }).shown, false)

// ── apply(), against stub services ──────────────────────────────────────────

/**
 * A client context good enough to activate the plugin.
 *
 * This is where the wiring is actually exercised: a reference to a service that
 * does not exist, an options object the slot registry would reject, or a component
 * that throws on its first render are all invisible to the pure-function checks
 * above and fatal in the browser.
 *
 * @param overrides - `{ section, permission }`.
 * @returns the context, plus what was registered.
 */
function createContext(overrides = {}) {
  const recorded = { slots: [], styles: [], effects: 0, locale: undefined, writes: [] }
  const listeners = new Set()
  let snapshot = {
    status: 'ready',
    value: overrides.section ?? exports_.defaultSection(),
    base: undefined,
    user: undefined,
    revision: 1,
    writable: true,
    mode: 'host',
  }
  const form = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (field, value) => {
      recorded.writes.push({ op: 'set', field, value })
      return Promise.resolve(true)
    },
    unset: (field) => {
      recorded.writes.push({ op: 'unset', field })
      return Promise.resolve(true)
    },
    mutate: (operations, revision) => {
      recorded.writes.push({ operations, revision })
      return Promise.resolve(true)
    },
  }
  const listListeners = new Set()
  const list = { phase: 'ready', ids: ['s1'], byId: { s1: { id: 's1', title: 'Deploy', running: true } } }
  const statusListeners = new Set()
  const status = new Map([['s1', { running: true, pendingInteraction: undefined, completionUnread: false }]])

  const ctx = {
    effect: (fn) => {
      recorded.effects += 1
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    get: () => undefined,
    inject: (names, fn) => {
      fn({ effect: ctx.effect, remote: { $on: () => () => undefined } })
    },
    slots: {
      inject: (name, fn) => {
        fn()
      },
      register: (options, component) => {
        recorded.slots.push({ options, component })
        return () => undefined
      },
    },
    locale: {
      register: (namespace, dictionaries) => {
        recorded.locale = { namespace, dictionaries }
      },
      bind: () => (key) => key,
    },
    configForms: { get: () => form },
    sessions: {
      list: {
        getSnapshot: () => list,
        subscribe: (listener) => {
          listListeners.add(listener)
          return () => listListeners.delete(listener)
        },
      },
    },
    uiSession: {
      sessionStatus: {
        getSnapshot: () => status,
        subscribe: (listener) => {
          statusListeners.add(listener)
          return () => statusListeners.delete(listener)
        },
      },
    },
  }
  return { ctx, recorded, form, push: () => snapshot }
}

// A window for the plugin to read visibility and audio from.
const previousWindow = globalThis.window
globalThis.window = {
  document: {
    visibilityState: 'hidden',
    hasFocus: () => false,
    head: { appendChild: () => undefined },
    createElement: () => ({ dataset: {}, remove: () => undefined, set textContent(value) {}, get textContent() { return '' } }),
    querySelector: () => undefined,
  },
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  focus: () => undefined,
}
// The bundle's `document` reference is the global one.
globalThis.document = globalThis.window.document
globalThis.Notification = function StubNotification() {
  throw new Error('no notification service in this environment')
}
globalThis.Notification.permission = 'denied'

const { ctx, recorded } = createContext()
exports_.apply(ctx)

const slotRow = recorded.slots.find((entry) => entry.options?.name === 'settings.general.item')
assert.ok(slotRow !== undefined, 'the plugin must register its settings row')
assert.equal(slotRow.options.id, 'dsh-notification')
assert.equal(slotRow.options.locale, exports_.LOCALE_NAMESPACE)
assert.ok(Number.isFinite(slotRow.options.order), 'the row must declare an order')
assert.equal(recorded.locale.namespace, exports_.LOCALE_NAMESPACE)
assert.deepEqual(
  Object.keys(recorded.locale.dictionaries).sort(),
  ['en', 'zh'],
  'both dictionaries must be registered',
)

// The injected actions, exactly as the slot registry composes them.
const injected = slotRow.options.inject()
assert.equal(typeof injected.onChange, 'function')
assert.equal(typeof injected.onAudition, 'function')
assert.equal(typeof injected.onTest, 'function')
assert.equal(typeof injected.onReset, 'function')
assert.ok(injected.hooks?.notification !== undefined, 'the row needs its store hook')
// The store seat is bound by the renderer calling `getSnapshot` on whatever it is given,
// so an object without one registers successfully, renders nothing, and is reported as
// `slot entry crashed`. Asserting the *shape* is what turns that into a failing check: the
// first version of this plugin passed a `defineStore` handle — which has `create` and no
// `getSnapshot` — and the card was silently absent from the settings page.
const storeSource = injected.hooks.notification
assert.equal(typeof storeSource.getSnapshot, 'function', 'the store seat must expose getSnapshot')
assert.equal(typeof storeSource.subscribe, 'function', 'the store seat must expose subscribe')
assert.ok(
  storeSource.getSnapshot() !== undefined,
  'the store seat must report a snapshot before anything writes to it',
)
// And it must be the *same* store the engine reads, or the row would render one
// configuration while the engine runs another.
assert.equal(typeof storeSource.actions?.sync, 'function', 'the store seat must be the instance')
assert.ok(injected.permission !== undefined, 'the row needs the banner permission state')

/** The translator the slot registry would hand the component. */
const t = (key) => recorded.locale.dictionaries.zh[key] ?? key

// Render the row the way the renderer would: the store source becomes a selector hook,
// and the injected actions arrive as props. A component that throws here would blank the
// settings page — which is exactly the failure this section exists to catch.
const storeInstance = storeSource
const useNotification = (selector) => selector(storeInstance.getSnapshot())
react.__reset()
const tree = slotRow.component({
  t,
  useNotification,
  ...injected,
})
assert.ok(tree !== null && typeof tree === 'object', 'the row must render an element')

/**
 * Render a tree of element descriptors, calling function components.
 *
 * The row hands back `h(StateCard, props)` rather than a finished tree — that is what React
 * stores for a function component, and a check that walked the descriptors without calling
 * them would see the row's own markup and none of the cards, which is the opposite of what
 * this check is for.
 *
 * Text is **kept**, as a plain value. An earlier version of this returned `[]` for anything
 * that was not an object, which silently discarded every label in the tree — so this walker
 * reported that the tabs had no labels, and the check about tab labels then failed for a
 * reason that had nothing to do with the plugin.
 *
 * @param node - an element descriptor, an array, a component, text, or nothing.
 * @returns the rendered nodes, flattened.
 */
function renderTree(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return []
  if (typeof node === 'string' || typeof node === 'number') return [node]
  if (Array.isArray(node)) return node.flatMap((entry) => renderTree(entry))
  const props = node.props ?? {}
  if (typeof node.type === 'function') {
    // The stub hooks are call-order based, so the cursor resets per component: the
    // component's own `useState`/`useEffect` calls are what it is about to make.
    react.__reset()
    return renderTree(node.type(props))
  }
  return [{ ...node, children: (node.children ?? []).flatMap((child) => renderTree(child)) }]
}

/** Count every rendered element. Text is not an element. @param node @returns the count. */
function countNodes(node) {
  if (typeof node === 'string' || typeof node === 'number') return 0
  if (node === null || typeof node !== 'object') return 0
  let total = 1
  for (const child of node.children ?? []) total += countNodes(child)
  return total
}

const rendered = renderTree(tree)
const nodes = countNodes(rendered[0])
// The panel renders one tab at a time, so this is a floor rather than a total: it catches a
// row that renders nothing at all, and the per-tab check below is what proves every tab has
// content.
assert.ok(nodes > 40, `the row must render its first tab (rendered ${String(nodes)} nodes)`)

/** Walk a rendered tree, collecting every node's props. @param node @param out @returns the collector. */
function collect(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  out.push(node)
  for (const child of node.children ?? []) collect(child, out)
  return out
}

// ── the layout ──────────────────────────────────────────────────────────────
//
// The row is one column with a vertical switcher down the side of the state card, and these are the
// assertions that hold that shape: no top-level tab strip, six state names, and exactly one card.
// The earlier layout was four tabs across the top, so an assertion that no `dsh-notification-tab`
// exists is what stops that from creeping back.

/**
 * The first string anywhere inside a rendered child list, descending into elements.
 *
 * Two shapes make this necessary rather than a simple index. An element's children arrive as an array
 * — a localized label, and a count badge when the state has sessions in it — and a stub
 * `createElement(type, props, children)` nests that array one level deeper than React's spread form
 * does. And the label may be wrapped in an element rather than passed as a bare string: a switcher row
 * puts its name in a `<span>` so it can sit left while the count sits right. Both are descended.
 *
 * @param value - a child, an element, or a list of them.
 * @returns the first string found, or an empty string.
 */
function firstString(value) {
  if (typeof value === 'string') return value
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = firstString(entry)
      if (found !== '') return found
    }
    return ''
  }
  if (value !== null && typeof value === 'object') return firstString(value.children)
  return ''
}

const all = collect(rendered[0], [])
const label = (key) => recorded.locale.dictionaries.zh[key]

const topTabs = all.filter((node) => /(?:^|\s)dsh-notification-tab(?:\s|$)/u.test(String(node.props?.className ?? '')))
assert.equal(topTabs.length, 0, 'the row must not go back to a horizontal tab strip')

const pickers = all.filter((node) => /(?:^|\s)dsh-notification-picker(?:\s|$)/u.test(String(node.props?.className ?? '')))
assert.equal(pickers.length, exports_.STATE_KINDS.length, 'the switcher must offer every state')
assert.equal(
  pickers.filter((node) => node.props['aria-selected'] === 'true').length,
  1,
  'exactly one state is selected',
)
assert.deepEqual(
  pickers.map((node) => node.props['aria-selected']),
  exports_.STATE_KINDS.map((kind) => (kind === exports_.STATE_KINDS[0] ? 'true' : 'false')),
  'the first state is the one shown',
)
assert.deepEqual(
  pickers.map((node) => firstString(node.children)),
  exports_.STATE_KINDS.map((kind) => label(`notification.state.${kind}`)),
  'the switcher must name every state, in roster order',
)

// The card beside the switcher, and only that one: six cards at once was the layout two revisions
// ago, and "one card" is the assertion that it stayed gone.
const cards = all.filter((node) => node.props?.['data-state'] !== undefined)
assert.equal(cards.length, 1, 'only the selected state renders a card')
assert.equal(cards[0].props['data-state'], exports_.STATE_KINDS[0])

// Every level is a number box, not a slider. The range input is what made each field three rows tall,
// so its absence is the check that the compact layout held — and the presence of number inputs is the
// other half, since a row with neither control would satisfy the first.
assert.equal(
  all.filter((node) => node.type === 'input' && node.props?.type === 'range').length,
  0,
  'no slider may remain: every level is a number field',
)
assert.ok(
  all.filter((node) => node.type === 'input' && node.props?.type === 'number').length > 0,
  'the levels must render as number fields',
)

if (!exports_.NOTIFICATIONS_ENABLED) {
  // A switched-off channel must not be named anywhere — and not only on a tab. The banner switch also
  // lives on every state card, so hiding just the tab left six cards offering "系统通知" for a channel
  // that is switched off in code, which is what a user found after being told it was disabled.
  //
  // The card is rendered **both ways** and the two results compared, because an assertion that a
  // control is absent passes just as well when the control was never reachable at all — the second
  // render is what proves the probe can find the thing it claims is missing.
  //
  // The probe counts checkboxes. That took a few wrong attempts worth recording, because each would
  // have been a test that passed for the wrong reason: the `labelKey` is a prop of the `Check`
  // *component*, so searching for it in the output finds its `<label>` and `<input>` and loses the
  // key; and searching the serialized tree for the label *string* finds nothing ever, since a label
  // is never a text node. An input element is what the user actually clicks, so that is what is
  // counted.
  const countCheckboxes = (node, total = 0) => {
    if (node === null || typeof node !== 'object') return total
    if (!Array.isArray(node) && node.type === 'input' && node.props?.type === 'checkbox') total += 1
    for (const child of Array.isArray(node) ? node : (node.children ?? [])) {
      total = countCheckboxes(child, total)
    }
    return total
  }
  const renderCard = (banner) =>
    countCheckboxes(
      exports_.StateCard({
        t,
        kind: 'question',
        state: exports_.STATE_DEFAULTS.question,
        count: 0,
        defaults: exports_.STATE_DEFAULTS.question,
        banner,
        onChange: () => undefined,
        onAudition: () => undefined,
        onTest: () => undefined,
      }),
    )
  // With the channel live: "alert for this state", "play a sound", "system notification".
  assert.equal(renderCard(true), 3, 'a live channel contributes the banner switch')
  // With it off: the same card, one switch fewer, and nothing else lost.
  assert.equal(renderCard(false), 2, 'the banner switch must not be rendered while the channel is off')
}


// The controls write through the form, fenced by the revision the store holds.
storeInstance.actions.setCounts({ question: 1 })
storeInstance.actions.sync(exports_.defaultSection(), 2)
assert.equal(storeInstance.getSnapshot().settings.states.done.enabled, true)
// An older snapshot arriving late must not undo a newer one.
storeInstance.actions.sync({ enabled: false }, 1)
assert.equal(storeInstance.getSnapshot().settings.enabled, true)
injected.onChange('done', 'volume', 0.5)
assert.equal(recorded.writes.at(-1).operations[0].path.join('.'), 'states.done.volume')
assert.equal(recorded.writes.at(-1).revision, 2, 'a write must be fenced by the accepted revision')

// Resetting a card writes every field of that card, which is what "reset" means.
injected.onChange('done', undefined, undefined, true)
const resetOps = recorded.writes.at(-1).operations
assert.equal(resetOps.length, Object.keys(exports_.STATE_DEFAULTS.done).length)
assert.ok(resetOps.every((operation) => operation.path[1] === 'done'))

// A global write goes to the top level, not under `states`.
injected.onChange(undefined, 'masterVolume', 0.25)
assert.deepEqual(recorded.writes.at(-1).operations[0].path, ['masterVolume'])

// The audition path must face an environment with no Web Audio without throwing,
// and the test path must report the refusal rather than claiming a banner was shown.
assert.doesNotThrow(() => injected.onAudition('question'))
const tested = await injected.onTest('question')
assert.equal(typeof tested, 'string', 'a test must report its outcome as text')
assert.ok(!/sent|已发出/u.test(tested), `a refused banner must not be reported as sent (got "${tested}")`)

await injected.onAskPermission()

globalThis.window = previousWindow
delete globalThis.document
delete globalThis.Notification

console.log(
  `verify-client: OK — ${String(source.length)} bytes, requires ${requested.join(', ') || 'nothing'}, ` +
    `${String(zhKeys.length)} translated keys, ${String(Object.keys(exports_.VOICES).length)} voices, ` +
    `${String(nodes)} rendered nodes, ${String(recorded.effects)} effects`,
)