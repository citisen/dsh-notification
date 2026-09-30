/**
 * Build `lib/client.js` from `src/`.
 *
 * A DSH client bundle is a **classic script**, not an ES module: the browser shell
 * loads it with a plain `<script>` element, and all it may do is register a lazy
 * CommonJS factory with `window.__ModuleLoader__`. So this script does three
 * things, and the third is the interesting one.
 *
 * 1. **Wrap** the compiled source in that envelope, exporting the names the
 *    verifier drives.
 * 2. **Rewrite** static imports of the shell's platform singletons into the
 *    factory's `require` form — which is the only way a bundle may reach React or
 *    the client store.
 * 3. **Splice** this package's own relative modules into the factory's single
 *    scope, because the shell's module table has no entry for them and a second
 *    `<script>` would be a second roster row. This is done recursively rather than
 *    one level deep: `client.js` imports `engine.js`, which imports `settings.js`,
 *    and an inliner that stopped at one level would emit an `import` statement
 *    inside a classic script — which parses nowhere and fails only in the browser.
 *
 * The transformation stays deliberately narrow and **fails loudly** on any import
 * shape it cannot express, because a hand-written bundle has no bundler behind it
 * and a silent miss here is a plugin that simply never loads.
 *
 * Usage:
 *   node scripts/build-client.mjs           # write lib/client.js
 *   node scripts/build-client.mjs --watch   # rebuild on save
 *   node scripts/build-client.mjs --check   # fail if lib/client.js is stale
 */

import { readFileSync, watch, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sourcePath = join(root, 'src', 'client.js')
const outputPath = join(root, 'lib', 'client.js')

/** The package name, which the bundle id must equal. */
const PACKAGE_NAME = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).name

/**
 * The names the envelope exports from the factory.
 *
 * The first two are what the loader consumes. The rest exist so
 * `scripts/verify-client.mjs` can drive the *shipped* bundle in Node — testing the
 * emitted artifact rather than the sources is the point, since the build is what
 * could have mangled them.
 */
const ENVELOPE_EXPORTS = [
  'apply',
  'inject',
  'NOTIFICATION_NAMESPACE',
  'LOCALE_NAMESPACE',
  'PLUGIN_ID',
  'ROW_CSS',
  'StateCard',
  'NotificationRow',
  'zh',
  'en',
  'MESSAGE_KEYS',
  'createRowStore',
  'readSources',
  'readVisibility',
  'focusSession',
  'installStyles',
  'installEngine',
  // states.js
  'STATE_KINDS',
  'OBSERVED_KINDS',
  'BLOCKING_KINDS',
  'stateOf',
  'sessionTitle',
  'interactionSummary',
  'observe',
  'tally',
  'diffStatus',
  'firstOf',
  'createFailureLog',
  // sound.js
  'VOICES',
  'VOICE_NAMES',
  'DEFAULT_VOICE',
  'DEFAULT_NOTE_MS',
  'DEFAULT_STAGGER_MS',
  'RELEASE_MS',
  'SILENCE',
  'noteFrequency',
  'parseLength',
  'readMelody',
  'melodyLengthMs',
  'readVoice',
  'schedule',
  'periodicWave',
  'createPlayer',
  // system.js
  'permissionState',
  'requestPermission',
  'notificationOptions',
  'createNotifier',
  // engine.js
  'BANNER_BODY_LIMIT',
  'planEvent',
  'buildBanner',
  'createSpeechLog',
  'gapElapsed',
  'firstAudible',
  'allBannered',
  'describePlan',
  // settings.js
  'SOUND_SCOPES',
  'NOTIFICATIONS_ENABLED',
  'STATE_FIELDS',
  'GLOBAL_FIELDS',
  'STATE_DEFAULTS',
  'GLOBAL_DEFAULTS',
  'SETTINGS_VERSION',
  'coerceField',
  'resolveSettings',
  'defaultSection',
  'admit',
  'soundAllowed',
  'stateGain',
  'stateVoice',
  // templates.js
  'TEMPLATE_FIELDS',
  'renderTemplate',
  'unknownFields',
  'fitLine',
  'clockTime',
]

/**
 * The only specifiers the shell seeds into the browser module table.
 *
 * Anything else has to be declared in `dsh.client.external` and shipped as its own
 * graph row; a mistake would otherwise surface only at runtime, in the browser,
 * as a plugin that never registered.
 */
const PLATFORM_SINGLETONS = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/**
 * `import [default][, { named }] from 'spec'`, matching the whole line.
 *
 * The quotes are captured so a rewritten line keeps the author's style, and no
 * nested braces are allowed because the named list is flattened by splitting on
 * commas — which is exact for the shapes this package uses and fails loudly
 * otherwise.
 */
const IMPORT_PATTERN =
  /^import\s+(?:(?<default>[A-Za-z_$][\w$]*)(?:\s*,\s*)?)?(?:\{\s*(?<named>[^{}]*?)\s*\})?\s*from\s*(?<quote>['])(?<spec>[^']+)\k<quote>[ \t]*$/gm

/** Turn one specifier into the alias DSH's own bundles are emitted with. */
function aliasFor(spec) {
  return `_${spec.replace(/^@/u, '').replace(/[^A-Za-z0-9]+/gu, '_').replace(/_+$/u, '')}`
}

/** Whether a specifier names a file in this package rather than a dependency. */
function isRelative(spec) {
  return spec.startsWith('./') || spec.startsWith('../')
}

/**
 * Spliced modules, by source path, so a module two others import appears once.
 *
 * The order matters: a module's own code is emitted *after* everything it imports,
 * because the factory is one scope and a `const` read before its declaration is a
 * temporal-dead-zone error at materialization. The `emitted` set is what makes a
 * diamond — `client` and `engine` both importing `settings` — a single copy.
 */
const emitted = new Set()

/**
 * Splice one module and its dependencies into the factory scope.
 *
 * @param file - the module's path, relative to `src/`.
 * @param chain - the import chain so far, for cycle detection.
 * @param bound - the platform names already bound in this scope.
 * @returns the module and its dependencies as one source text.
 * @throws {Error} on a relative import that cannot be resolved, or on a cycle.
 */
function inlineModule(file, chain = [], scope) {
  if (emitted.has(file)) return ''
  if (chain.includes(file)) {
    throw new Error(`build-client: import cycle ${[...chain, file].join(' -> ')}`)
  }
  const path = join(root, 'src', file)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch {
    throw new Error(
      `build-client: src/client.js imports ./${file}, which does not exist (${path})`,
    )
  }
  emitted.add(file)
  const state = { requested: [] }
  const body = rewriteImports(source, { file, chain, state, bound: scope.bound, bindings: scope.bindings })
  // Dependencies first: the factory is one scope, so a module that reads another
  // module's `const` must be emitted after it.
  const prelude = state.requested
    .map((spec) => inlineModule(spec.replace(/^\.\//u, ''), [...chain, file], scope))
    .join('')
  const banner = `\n// ─── src/${file} ${'─'.repeat(Math.max(0, 60 - file.length))}\n`
  return `${prelude}${banner}${body.trimEnd()}\n`
}

/**
 * Rewrite every static import in one module.
 *
 * A relative specifier is collected for splicing and its line removed — the
 * module's declarations are about to be in this scope, so the name it was imported
 * as is already bound. A platform specifier becomes a binding request, recorded in
 * `context.bindings` **and emitted nowhere here**.
 *
 * That last part is the correction this file needed. The splice puts every module in
 * one scope, so a platform dependency imported by two modules must be declared once;
 * and it must be declared *before any module body runs*, because a module may read
 * it at its own top level — `const h = React.createElement` at the top of a
 * component module reads React during materialization, and a binding emitted next
 * to the import that asked for it is in the temporal dead zone at that moment. So
 * the names are collected and emitted in the envelope's prelude, ahead of every
 * module. A `ReferenceError` in a bundle the browser loads as one classic script
 * means the whole plugin fails to load, which is why this is worth stating.
 *
 * @param source - the module's source.
 * @param context - `{ file, chain, requested, bound, bindings }`.
 * @returns the rewritten source.
 */
function rewriteImports(source, context) {
  let matched = 0
  const body = source.replace(IMPORT_PATTERN, (...args) => {
    const { default: defaultName, named, spec } = args.at(-1)
    matched += 1
    if (isRelative(spec)) {
      if (!context.state.requested.includes(spec)) context.state.requested.push(spec)
      return ''
    }
    if (!PLATFORM_SINGLETONS.has(spec)) {
      throw new Error(
        `build-client: src/${context.file} imports "${spec}", which is neither a platform singleton nor a ` +
          'relative module. Declare it in dsh.client.external and ship it as its own client bundle, or ' +
          'compile it in.',
      )
    }
    const alias = aliasFor(spec)
    /** Record one local name bound to a platform module, once. @param local @param expression */
    const bind = (local, expression) => {
      if (context.bound.has(local)) return
      context.bound.add(local)
      context.bindings.push({ local, expression, spec })
    }
    if (defaultName !== undefined) {
      if (!/^[A-Za-z_$][\w$]*$/u.test(defaultName)) {
        throw new Error(`build-client: unsupported default import name "${defaultName}"`)
      }
      bind(defaultName, alias)
    }
    for (const entry of (named ?? '').split(',')) {
      const trimmed = entry.trim()
      if (trimmed === '') continue
      if (!/^[A-Za-z_$][\w$]*$/u.test(trimmed)) {
        throw new Error(
          `build-client: unsupported named import "${trimmed}" from "${spec}" — write the local name ` +
            'identical to the exported name',
        )
      }
      bind(trimmed, `${alias}.${trimmed}`)
    }
    return ''
  })

  // A leftover import means the pattern missed a form it did not anticipate.
  // Emitting it produces a bundle that cannot parse, which the browser reports as
  // the plugin simply never loading.
  const leftover = /^\s*import[\s{*]/mu.exec(body)
  if (leftover !== null) {
    throw new Error(
      `build-client: src/${context.file} has an import the transformation cannot express ` +
        `(at "${leftover[0].trim()}"); use a static, single-line import`,
    )
  }
  return body
}

/**
 * Substitute the plugin-identity placeholder with the real package name.
 *
 * Single-sourced from `package.json` so a rename cannot desynchronize the bundle
 * id and what the plugin calls itself in its diagnostics.
 */
const IDENTITY_PATTERN = /\/\* dsh:plugin-id \*\/\s*(['"])[^'"]*\1/u

/** @param body - the transformed source. @returns the source with identity filled in. */
function substituteIdentity(body) {
  const matches = body.match(new RegExp(IDENTITY_PATTERN.source, 'gu')) ?? []
  if (matches.length !== 1) {
    throw new Error(
      `build-client: src/client.js must contain exactly one /* dsh:plugin-id */ declaration ` +
        `(found ${String(matches.length)})`,
    )
  }
  return body.replace(IDENTITY_PATTERN, JSON.stringify(PACKAGE_NAME))
}

/**
 * Strip the template's `export` keywords, leaving the declarations.
 *
 * The envelope re-exports {@link ENVELOPE_EXPORTS} by name, so each of those only
 * has to be a top-level declaration — and a missing one is a build failure rather
 * than an `undefined` export the verifier would trip over later. `async function`
 * counts, because an exported async helper is a declaration like any other and a
 * pattern that only knew `function` would reject one.
 *
 * @param body - the transformed source.
 * @returns the source without declaration exports.
 */
function stripExports(body) {
  for (const name of ENVELOPE_EXPORTS) {
    const declaration = new RegExp(
      `^(?:export )?(?:async )?(?:const|let|var|function|class) ${name}\\b`,
      'mu',
    )
    if (!declaration.test(body)) {
      throw new Error(
        `build-client: the source must declare \`${name}\` at the top level for the envelope to re-export`,
      )
    }
  }
  // The `async` keyword is kept: it belongs to the declaration, not to the export.
  const stripped = body.replace(/^export (async )?(const|let|var|function|class) /gmu, '$1$2 ')
  if (/^\s*export\s/mu.test(stripped)) {
    throw new Error(
      'build-client: the source contains an export form the build cannot strip (only top-level ' +
        'declarations may be exported)',
    )
  }
  return stripped
}

/**
 * Wrap the transformed source in the DSH client-bundle envelope.
 * @param body - the transformed, export-stripped source.
 * @param prelude - the `require` bindings for the platform singletons.
 * @returns the complete bundle text.
 */
function wrap(body, prelude) {
  const exports = ENVELOPE_EXPORTS.map((name) => `\t\texports.${name} = ${name};`).join('\n')
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(PACKAGE_NAME)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${prelude}${body.trimEnd()}
${exports}
\t\treturn module.exports;
\t}
});
`
}

/**
 * Compile the sources into the bundle.
 *
 * The relative imports are rewritten *before* the platform ones, because the
 * spliced modules carry platform imports of their own and they have to go through
 * the same pass — there is no second set of import rules for them.
 *
 * @returns the bundle text.
 */
function compile() {
  emitted.clear()
  // One scope for the whole factory: the names already bound, and the binding
  // requests collected from every module so the prelude can declare them all before
  // any module body runs.
  const scope = { bound: new Set(), bindings: [] }
  const entry = readFileSync(sourcePath, 'utf8')
  const state = { requested: [] }
  const body = rewriteImports(entry, {
    file: 'client.js',
    chain: [],
    state,
    bound: scope.bound,
    bindings: scope.bindings,
  })
  const prelude = state.requested
    .map((spec) => inlineModule(spec.replace(/^\.\//u, ''), ['client.js'], scope))
    .join('')

  const compiled = prelude + substituteIdentity(body)
  // The `require` calls are emitted for exactly the platform specifiers the graph
  // asks for: a bundle that required `react-dom` it never used would be a lie about
  // its dependencies, and one that used an alias with no binding would fail at
  // materialization.
  const specifiers = [...new Set(scope.bindings.map((entry_) => entry_.spec))]
  const requires = specifiers
    .map((spec) => `\t\tlet ${aliasFor(spec)} = require(${JSON.stringify(spec)});`)
    .join('\n')
  // The local bindings follow the requires and precede every module body, which is
  // what keeps a module that reads React at its own top level out of the temporal
  // dead zone.
  const declarations = scope.bindings
    .map((entry_) => `\t\tconst ${entry_.local} = ${entry_.expression};`)
    .join('\n')
  const bindings = [requires, declarations].filter((line) => line !== '').join('\n')

  return { bundle: wrap(stripExports(compiled), `${bindings}\n`), requested: specifiers }
}

/**
 * Every platform alias a compiled body references.
 * @param body - the compiled source.
 * @returns the specifiers, deduplicated.
 */
function platformSpecifiersIn(body) {
  const found = []
  for (const spec of PLATFORM_SINGLETONS) {
    if (new RegExp(`\\b${aliasFor(spec)}\\b`, 'u').test(body)) found.push(spec)
  }
  return found
}

/** Compile and write, reporting what changed. @returns whether the file changed. */
function build() {
  const { bundle, requested } = compile()
  let existing
  try {
    existing = readFileSync(outputPath, 'utf8')
  } catch {
    existing = undefined
  }
  if (existing === bundle) {
    console.log('build-client: lib/client.js already up to date')
    return false
  }
  writeFileSync(outputPath, bundle, 'utf8')
  console.log(
    `build-client: wrote lib/client.js (${String(bundle.length)} bytes, requires ` +
      `${requested.join(', ') || 'nothing'})`,
  )
  return true
}

if (process.argv.includes('--check')) {
  let existing
  try {
    existing = readFileSync(outputPath, 'utf8')
  } catch {
    console.error('build-client: lib/client.js is missing; run `node scripts/build-client.mjs`')
    process.exit(1)
  }
  if (existing !== compile().bundle) {
    console.error('build-client: lib/client.js is stale; run `node scripts/build-client.mjs`')
    process.exit(1)
  }
  console.log('build-client: lib/client.js is up to date')
} else if (process.argv.includes('--watch')) {
  build()
  console.log('build-client: watching src/ (Ctrl-C to stop)')
  let timer
  const rebuild = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        build()
      } catch (error) {
        // Keep watching: a syntax error mid-edit must not kill the watcher.
        console.error(String(error instanceof Error ? error.message : error))
      }
    }, 50)
  }
  watch(join(root, 'src'), { recursive: true }, rebuild)
} else {
  build()
}
