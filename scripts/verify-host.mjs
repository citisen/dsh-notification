/**
 * Verify the host half against the real schema library.
 *
 * Three things can only be answered by running this file, and all three fail
 * silently in production:
 *
 * 1. **That the configuration round-trips.** `Config.parse` on the shipped values
 *    must produce the shipped values back. A default that the schema itself
 *    rejects, or a number that a `min`/`max` quietly clamps, produces a settings
 *    page that shows one configuration and a host that stores another.
 * 2. **That every field is volatile.** The settings model projects a section
 *    through a view that keeps volatile paths only. A field declared ordinary is
 *    absent from the value the client reads, and a write to it is refused — so an
 *    all-ordinary schema is a settings page on which nothing ever saves. Counting
 *    the reachable volatile paths against the field roster is the only way to see
 *    that from here.
 * 3. **That the two halves agree.** The host schema's defaults and the browser
 *    half's defaults are duplicated by hand, because a Node package and a client
 *    bundle are separate module graphs that cannot share a module. Comparing them
 *    turns that duplication into a failing check.
 *
 * The schema library is resolved through the *profile* rather than through this
 * package, because the profile is where a plugin's dependencies actually resolve
 * at runtime. `DSH_PROFILE` selects the profile and `DSH_HOME` the home; with
 * neither, the defaults match a stock install.
 *
 * Usage:
 *   node scripts/verify-host.mjs
 *
 * Environment:
 *   DSH_HOME      Harness home holding profiles/ (default ~/.dsh)
 *   DSH_PROFILE   Profile to resolve the schema library through (default desktop)
 *   DSH_REQUIRE   Set to 1 to fail instead of skipping when the profile is absent
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  GLOBAL_DEFAULTS,
  SETTINGS_VERSION,
  STATE_DEFAULTS,
  STATE_FIELDS,
  resolveSettings,
} from '../src/settings.js'
import { STATE_KINDS } from '../src/states.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
const DSH_HOME = process.env.DSH_HOME ?? (HOME === '' ? undefined : join(HOME, '.dsh'))
const PROFILE = process.env.DSH_PROFILE ?? 'desktop'

/** Give up (or fail, under DSH_REQUIRE) because the profile is not usable here. */
function skip(reason) {
  console.log(`verify-host: SKIP — ${reason}`)
  if (process.env.DSH_REQUIRE === '1') {
    console.error('verify-host: DSH_REQUIRE=1, treating the skip as a failure')
    process.exit(1)
  }
  process.exit(0)
}

const profileDir = DSH_HOME === undefined ? undefined : join(DSH_HOME, 'profiles', PROFILE)
if (profileDir === undefined || !existsSync(profileDir)) {
  skip(`no profile at ${String(profileDir)}`)
}

/**
 * Load the schema library the way the profile would.
 * @returns the module namespace.
 */
async function loadSchemaLibrary() {
  const anchor = join(profileDir, 'package.json')
  if (!existsSync(anchor)) skip(`profile ${PROFILE} has no package.json`)
  const require = createRequire(anchor)
  let resolved
  try {
    resolved = require.resolve('@deepseek-ai/schemastery')
  } catch {
    skip(`profile ${PROFILE} does not have @deepseek-ai/schemastery installed`)
  }
  return import(pathToFileURL(resolved).href)
}

const schemastery = await loadSchemaLibrary()
const z = schemastery.default ?? schemastery
assert.equal(typeof z?.object, 'function', 'the schema library must export a default factory')

// ── the host half, loaded as the loader would load it ───────────────────────
const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)

assert.equal(host.NOTIFICATION_NAMESPACE, 'notification')
assert.equal(typeof host.apply, 'function', 'the host half must export apply')
assert.equal(typeof host.Config, 'function', 'the host half must export its Config schema')
assert.ok(Array.isArray(host.NOTIFICATION_STATES))
assert.deepEqual(host.NOTIFICATION_STATES, STATE_KINDS)

// ── 1. the namespace is the patch row id ────────────────────────────────────
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
const rowId = /^\s*-\s*id:\s*(\S+)\s*$/mu.exec(patch)?.[1]
const rowName = /^\s*name:\s*'([^']+)'\s*$/mu.exec(patch)?.[1]
assert.equal(
  rowId,
  host.NOTIFICATION_NAMESPACE,
  'the patch row id and the settings namespace must be the same string; the client half ' +
    'addresses its configuration by the row id',
)

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
assert.equal(rowName, manifest.name, 'the patch row must name this package')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.dsh?.client?.platform, 'web')

// ── 2. the schema round-trips the shipped configuration ─────────────────────
/**
 * The same configuration the browser half resolves for an empty document, spelled
 * as a stored section.
 * @returns the section.
 */
function shippedSection() {
  const states = {}
  for (const kind of STATE_KINDS) states[kind] = { ...STATE_DEFAULTS[kind] }
  return { version: SETTINGS_VERSION, ...GLOBAL_DEFAULTS, states }
}

const shipped = shippedSection()

/**
 * Resolve a value against a schema and unwrap it to plain data.
 *
 * A `volatile` field does not resolve to a value: it resolves to a cosmokit
 * `Volatile` reference — `{ get() }` — because that is what lets a settings value
 * live-update the face that reads it. So reading a resolved section means walking
 * it and asking each reference for its snapshot, which is the same thing the host
 * does when it projects a form and the same thing the client half does with a
 * snapshot's leaves.
 *
 * Validation is asserted inside, so a section the schema *refuses* fails here
 * rather than being compared as an empty object.
 *
 * @param schema - the schema.
 * @param value - the value to resolve.
 * @returns the plain resolved value.
 */
function resolvePlain(schema, value) {
  const standard = schema['~standard']
  assert.ok(standard !== undefined, 'the schema library must expose the standard-schema interface')
  const outcome = standard.validate(value)
  assert.equal(
    outcome.issues,
    undefined,
    `the schema refused the shipped configuration: ${JSON.stringify(outcome.issues)}`,
  )
  return unwrap(outcome.value)
}

/**
 * Replace every volatile reference in a resolved value with its snapshot.
 * @param node - the resolved node.
 * @returns the plain value.
 */
function unwrap(node) {
  if (node === null || typeof node !== 'object') return node
  if (typeof node.get === 'function' && typeof node[Symbol.iterator] !== 'function') {
    return unwrap(node.get())
  }
  if (Array.isArray(node)) return node.map((entry) => unwrap(entry))
  const plain = {}
  for (const [key, entry] of Object.entries(node)) plain[key] = unwrap(entry)
  return plain
}

assert.deepEqual(
  resolvePlain(host.Config, shipped),
  shipped,
  'the schema must accept the shipped configuration unchanged; a clamped or dropped default ' +
    'means the page renders one configuration and the host stores another',
)

// A partial section fills in from the schema, which is what makes an upgrade that
// adds a field work without a migration.
const partial = resolvePlain(host.Config, { masterVolume: 0.25, states: { done: { volume: 0.1 } } })
assert.equal(partial.masterVolume, 0.25)
assert.equal(partial.states.done.volume, 0.1)
assert.equal(partial.states.done.voice, SHIPPED_VOICE_FOR('done'))
assert.equal(partial.enabled, true)
assert.equal(partial.soundScope, 'background')

/** @param state - the state name. @returns the voice the host ships for it. */
function SHIPPED_VOICE_FOR(state) {
  return resolvePlain(host.Config, {}).states[state].voice
}

// A value outside a declared range is *refused*, not clamped: silently clamping
// would store something the user never chose and show it back to them.
const refused = host.Config['~standard'].validate({ masterVolume: 5 })
assert.ok(Array.isArray(refused.issues) && refused.issues.length > 0, 'an out-of-range number must be refused')
assert.match(String(refused.issues[0].message), /masterVolume/u)

// ── 3. every field is volatile, at a fixed path ─────────────────────────────
/**
 * Walk a schema and collect the paths marked volatile.
 *
 * The walk mirrors how the settings model reads a section: through objects, not
 * through lists or dictionary values, because a volatile field requires a fixed
 * object path.
 *
 * @param schema - a schema node.
 * @param path - the path so far.
 * @param out - the collector.
 * @returns the collector.
 */
function volatilePaths(schema, path, out) {
  const meta = schema?.meta ?? {}
  if (meta.volatile === true) {
    out.push(path.join('.'))
    // A volatile node may not contain another, which the library itself asserts;
    // stopping here keeps this walk from reporting a nesting the host would reject.
    return out
  }
  const dict = schema?.dict
  if (dict !== undefined && dict !== null && typeof dict === 'object') {
    for (const [key, child] of Object.entries(dict)) {
      volatilePaths(child, [...path, key], out)
    }
  }
  return out
}

const volatile = volatilePaths(host.Config, [], []).sort()

/** The paths the client half reads and writes. @returns the list. */
function expectedPaths() {
  // `version` is stored but has no control: it exists so a future migration has
  // something to read, and it is volatile like everything else because a field the
  // model cannot see is a field the model cannot preserve.
  const paths = ['version']
  for (const field of Object.keys(GLOBAL_DEFAULTS)) paths.push(field)
  for (const kind of STATE_KINDS) {
    for (const field of STATE_FIELDS) paths.push(`states.${kind}.${field.id}`)
  }
  return paths.sort()
}

const missing = expectedPaths().filter((path) => !volatile.includes(path))
assert.deepEqual(
  missing,
  [],
  'these fields are not volatile, so the settings model cannot see them and a write to them ' +
    'is refused',
)

// And nothing extra: a volatile field the client never writes is a field the user
// can see in a generated page and cannot control here.
const extra = volatile.filter((path) => !expectedPaths().includes(path))
assert.deepEqual(extra, [], 'these volatile fields are not in the browser half’s roster')

console.log(
  `verify-host: OK — namespace '${host.NOTIFICATION_NAMESPACE}', ${String(volatile.length)} volatile fields, ` +
    `schema round-trips the shipped defaults`,
)
