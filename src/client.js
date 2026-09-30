/**
 * Browser half of `dsh-notification`.
 *
 * ## What this plugin is for
 *
 * The interface already says everything you need to know *while you are looking at
 * it*: the sidebar has a state per session, the conversation has its own streaming
 * indicators. What it cannot do is tell you anything once you are in another
 * application, which is exactly when a long turn runs. So this plugin answers one
 * question from across the room — *does anything need me?* — through the two
 * channels a backgrounded desktop window actually has: its speakers, and the
 * operating system's notification centre.
 *
 * ## The favicon channel is gone, and that is the point
 *
 * This is the successor to a plugin that did the same job for the *tabbed* web
 * interface, where the channels were a favicon, a title prefix, and a chime. The
 * desktop application is the web interface inside an Electron window — it loads
 * `dsh-web-app` from the same loopback server on the same client-plugin roster —
 * so this plugin works in both, and it drops the two channels that only make sense
 * in a browser: a desktop window has no tab strip to paint an icon into and no tab
 * title to prefix. Keeping them would have meant maintaining two-thirds of a
 * feature for one-third of the audience.
 *
 * What replaced them is the channel a window actually has: a real desktop
 * notification, with the session's own words in it. That channel did not exist in
 * the tabbed version, and it is why this is a new plugin rather than a rename.
 *
 * ## How it is put together
 *
 * Everything with a decision in it lives in a module that does not touch the DOM:
 * `states.js` projects the interface's observables into per-session state and
 * diffs two observations into events; `engine.js` turns one event plus the
 * resolved settings into a plan; `sound.js` parses a melody and schedules it;
 * `system.js` owns the notification permission state; `settings.js` and
 * `templates.js` are the configuration and its text. This file is deliberately the
 * only impure one, and it is thin: read two snapshots, ask for a plan, perform it.
 *
 * This file is **not** loaded as an ES module. `scripts/build-client.mjs` wraps it
 * in the DSH client-bundle envelope and writes `lib/client.js`, which is what the
 * shell fetches. It may `import` only the platform singletons the shell seeds into
 * its module table — and it uses no JSX, because the build's import rewriting is
 * deliberately narrow and a transformation that had to understand JSX is one that
 * could be wrong about it.
 *
 * @module dsh-notification/client
 */

import React from 'react'
import { defineStore } from '@deepseek-ai/dsh-client-store'
import { NotificationRow, ROW_CSS, en, zh } from './row.js'
import { createFailureLog, createSpeechLog, diffStatus, observe, tally } from './states.js'
import { createPlayer } from './sound.js'
import { createNotifier } from './system.js'
import { describePlan, gapElapsed, planEvent } from './engine.js'
import { resolveSettings, stateGain } from './settings.js'
import { STATE_KINDS } from './states.js'

/**
 * The plugin's identity, substituted by `scripts/build-client.mjs` with the real
 * package name. It stamps the stylesheet this plugin owns and heads its
 * diagnostics, so a bundle mounted under another name says so.
 */
const PLUGIN_ID = /* dsh:plugin-id */ 'dsh-notification'

/**
 * The settings namespace this plugin owns — and it must equal the `id:` of this
 * package's row in `cordis.patch.yml`.
 *
 * Two spellings of one contract, and neither half can import the other: the host
 * package and this client bundle are separate module graphs. The settings model
 * keys a section by the Loader entry id, so the string here is what makes
 * `ctx.configForms.get(...)` answer with *this* plugin's configuration. Getting it
 * wrong is silent in the worst way — the form resolves to a namespace nobody
 * serves, `value` stays undefined, and the row renders the shipped defaults while
 * every edit goes nowhere.
 */
const NOTIFICATION_NAMESPACE = 'notification'

/** The locale namespace owning this feature's settings-row copy. */
const LOCALE_NAMESPACE = 'notification'

/**
 * Report a missing service once, so a composition that cannot support this plugin
 * says why instead of simply doing nothing.
 *
 * @param what - the missing surface, named the way a reader would look for it.
 * @param why - what stops working without it.
 * @returns {void}
 */
function reportOnce(reported, what, why) {
  if (reported.value) return
  reported.value = true
  console.error(`${PLUGIN_ID}: this dsh does not provide ${what}, so ${why}`)
}

// ─── the settings row ────────────────────────────────────────────────────────

/**
 * Install the row's stylesheet for the plugin's lifetime.
 * @param ctx - the client context.
 * @returns {void}
 */
function installStyles(ctx) {
  if (typeof document === 'undefined') return
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = PLUGIN_ID
    tag.dataset.pluginCss = `${PLUGIN_ID}/row.css`
    tag.textContent = ROW_CSS
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, `${PLUGIN_ID}: row stylesheet`)
}

/**
 * The store behind the settings row: the resolved section, plus the counts the
 * cards print and a revision so an older write cannot overwrite a newer one.
 *
 * `defineStore` returns a registration *handle*, not a live store: `handle.create()`
 * makes the instance, and the instance is what carries `getSnapshot` and `subscribe`.
 * **The instance is what the slot's `hooks` seat takes** — the renderer binds its
 * selector hook to the source it is handed, by calling `getSnapshot` on it. Passing the
 * handle instead is a mistake with a distinctive symptom: the row registers, the slot
 * renderer accepts it, and the component throws `getSnapshot is not a function` on its
 * first render, which the shell reports as `slot entry crashed` — a card that exists in
 * the ledger and not on the screen.
 *
 * @returns `{ handle, instance, getSnapshot, sync, setCounts }`.
 */
function createRowStore() {
  const handle = defineStore({
    init: () => ({ settings: resolveSettings(undefined), counts: {}, revision: -1 }),
    actions: {
      /**
       * Fold a configuration snapshot in.
       *
       * Guarded by the revision rather than by a comparison of values: a write this
       * plugin made comes back as a new snapshot, and an *older* snapshot arriving
       * late must not undo it.
       *
       * @param draft - the draft.
       * @param section - the snapshot's resolved value.
       * @param revision - the snapshot's revision.
       */
      sync: (draft, section, revision) => {
        if (typeof revision === 'number' && revision <= draft.revision) return
        draft.settings = resolveSettings(section)
        if (typeof revision === 'number') draft.revision = revision
      },
      /**
       * Record how many sessions are in each state, so a card can say so.
       * @param draft - the draft.
       * @param counts - the tally.
       */
      setCounts: (draft, counts) => {
        draft.counts = counts
      },
    },
  })
  // One instance for the whole plugin, made once: `create()` reads the store's own
  // source, so calling it twice would give the row and the engine two different stores
  // — the row rendering one configuration while the engine runs another.
  const instance = handle.create()
  return {
    handle,
    instance,
    getSnapshot: () => instance.getSnapshot(),
    sync: (section, revision) => {
      instance.actions.sync(section, revision)
    },
    setCounts: (counts) => {
      instance.actions.setCounts(counts)
    },
  }
}

// ─── the engine ──────────────────────────────────────────────────────────────

/**
 * Read the two observables the interface publishes, or the best substitute.
 *
 * `uiSession.sessionStatus` is the real signal: one entry per session carrying
 * `running`, `pendingInteraction` and `completionUnread`. It is what the sidebar
 * itself renders from. Where it is absent — a release that moved it, or a
 * composition that never installed it — the session list's own `running` bit is a
 * strictly worse but honest substitute: it can say "running" and nothing else, and
 * this plugin degrades to that rather than failing to load.
 *
 * @param ctx - the client context.
 * @returns `{ status, list }`.
 */
function readSources(ctx) {
  const list = ctx.sessions?.list?.getSnapshot?.() ?? { ids: [], byId: {} }
  const status = ctx.uiSession?.sessionStatus?.getSnapshot?.()
  if (status !== undefined) return { status, list }
  const fallback = new Map()
  for (const id of list.ids ?? []) {
    const row = list.byId?.[id]
    if (row === undefined) continue
    fallback.set(id, { running: row.running === true })
  }
  return { status: fallback, list }
}

/**
 * Wire the interface's state to the two output channels.
 *
 * @param ctx - the client context.
 * @param options - `{ store, player, notifier, view }`.
 * @returns `{ counts, refresh }` — the live counts and a function that re-reads.
 */
function installEngine(ctx, options) {
  const { store, player, notifier, view } = options
  const failures = createFailureLog()
  const speech = createSpeechLog()
  const reportedSources = { value: false }

  /** The previous observation, or undefined before the first. */
  let previous
  /** When the last *sound* played, for the burst gap. */
  let lastSoundAt
  /** Whether the sound was ever admitted long enough to report a locked context. */
  let reportedLocked = false

  /**
   * Read the current state, diff it against the last one, and perform the plans.
   * @returns the current tally, so the row can print it.
   */
  const refresh = () => {
    const { status, list } = readSources(ctx)
    if (status === undefined || status.size === undefined) {
      reportOnce(reportedSources, 'uiSession.sessionStatus', 'the plugin cannot tell when a session needs you.')
    }
    const next = observe(status, list, failures)
    const events = diffStatus(previous, next)
    previous = next

    const settings = store.getSnapshot().settings
    // The count comes from the state module rather than from a loop here: it is the
    // same tally the cards print and the tests assert, and a second implementation
    // of "how many sessions are in each state" is a second answer.
    const counts = tally(next)

    // Nothing to do is the common case by a wide margin, and it is worth leaving
    // early rather than walking the whole permission and visibility path for it.
    if (events.length > 0) {
      const visibility = readVisibility(view)
      const permission = notifier.permission()
      const stateLabel = events.map((entry) => entry.kind)
      const plans = events.map((entry) =>
        planEvent({
          event: entry,
          settings,
          counts,
          stateLabel: stateLabelText(ctx, entry.kind),
          permission,
          visibility,
          now: Date.now(),
          lastSpoke: speech,
        }),
      )

      // ── the bell ────────────────────────────────────────────────────────────
      const audible = firstAudibleIndex(plans)
      if (audible !== -1) {
        const chosen = plans[audible]
        const now = Date.now()
        if (gapElapsed(lastSoundAt, now, settings.minGapMs)) {
          player.setMaster(settings.masterVolume)
          const played = player.play(chosen.sound.melody, chosen.sound.voice, chosen.sound.gain)
          if (played) {
            lastSoundAt = now
            speech.note(events[audible].sessionId, now)
          } else if (!reportedLocked) {
            // The autoplay policy: a chime requested before any user gesture is
            // dropped rather than queued, and the row says so once.
            reportedLocked = true
          }
        }
      }

      // ── the banners ─────────────────────────────────────────────────────────
      for (const plan of plans) {
        if (plan.banner === undefined) continue
        notifier.show(plan.banner)
        speech.note(plan.banner.data.sessionId, Date.now())
      }
    }

    store.setCounts(counts)
    return counts
  }

  // Every subscription goes through `ctx.effect`, so teardown is the plugin's
  // disposal rather than this function's discipline.
  ctx.effect(() => {
    const disposeList = ctx.sessions?.list?.subscribe?.(refresh)
    const disposeStatus = ctx.uiSession?.sessionStatus?.subscribe?.(refresh)
    return () => {
      disposeList?.()
      disposeStatus?.()
    }
  }, `${PLUGIN_ID}: session subscriptions`)

  // The one fact that arrives as an event rather than as a level. `remote` is bound
  // optionally, so a composition without it loses the `failed` state and nothing
  // else.
  ctx.inject(['remote'], (remoteCtx) => {
    remoteCtx.effect(() => {
      const disposeErrors = remoteCtx.remote.$on('api-session/error', (sessionId, message) => {
        failures.record(sessionId, message, Date.now())
        // Recording is not enough on its own: a failure is not one of the levels
        // `sessionStatus` publishes, so the state machine has to be asked again or
        // the error would sit in the log until an unrelated session changed.
        refresh()
      })
      const disposeRemoved = remoteCtx.remote.$on('api-session/removed', (sessionId) => {
        failures.clear(sessionId)
        speech.forget(sessionId)
      })
      return () => {
        disposeErrors?.()
        disposeRemoved?.()
      }
    }, `${PLUGIN_ID}: session events`)
  })

  return { refresh, speech, failures }
}

/**
 * The window's own account of whether it is in front.
 *
 * `document.visibilityState` is the half that is always available; `hasFocus()` is
 * the half that distinguishes "behind another window" from "in front", which is
 * the distinction the `background` sound scope is about. Where focus cannot be
 * read the answer is `focused: false`, because the alternative — assuming the user
 * is watching — would silence the chime in exactly the case it exists for.
 *
 * @param view - the window.
 * @returns `{ visible, focused }`, or undefined when there is no document at all.
 */
function readVisibility(view) {
  if (view?.document === undefined) return undefined
  const visible = view.document.visibilityState === undefined ? true : view.document.visibilityState === 'visible'
  return { visible, focused: typeof view.document.hasFocus === 'function' ? view.document.hasFocus() : false }
}

/**
 * The first plan that has a sound, so a silent card cannot swallow a burst.
 * @param plans - the plans.
 * @returns the index, or -1.
 */
function firstAudibleIndex(plans) {
  for (let index = 0; index < plans.length; index += 1) {
    if (plans[index]?.sound !== undefined) return index
  }
  return -1
}

/**
 * One state's name in the interface language.
 *
 * The row's own copy is keyed by state, so the same string fills a card's heading
 * and a banner's `{state}` placeholder — one vocabulary rather than two.
 *
 * @param ctx - the client context.
 * @param kind - the state.
 * @returns the label.
 */
function stateLabelText(ctx, kind) {
  const t = ctx.locale?.bind?.(LOCALE_NAMESPACE)
  if (t === undefined) return kind
  try {
    return t(`notification.state.${kind}`)
  } catch {
    return kind
  }
}

/**
 * Bring the window forward and try to select the session a banner was about.
 *
 * A notification that cannot take you to the thing it is about is a nag, so the
 * click does the two things it can: raise the window, which every window can do,
 * and click the session's own row, which is a best-effort selector against markup
 * this plugin does not own. The second half is deliberately guarded — a release
 * that renames the attribute costs the *navigation*, not the notification.
 *
 * @param ctx - the client context.
 * @param data - the banner's `data`.
 * @param view - the window.
 * @returns {void}
 */
function focusSession(ctx, data, view) {
  try {
    view?.focus?.()
  } catch {
    /* a window that refuses focus is the platform's decision */
  }
  const sessionId = data?.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return
  try {
    // Two spellings, because the session id has appeared both raw and prefixed.
    const selector = `[data-session-id="${sessionId}"], [data-session-id="session-${sessionId}"]`
    const element = view?.document?.querySelector?.(selector)
    element?.click?.()
  } catch {
    /* the interface is not ours; a click that does not land is not an error */
  }
}

/**
 * The services this plugin waits for.
 *
 * `slots` and `locale` are how it adds a row. `sessions` and `uiSession` are the
 * two observables the engine reads — and they are declared *required*, which is a
 * decision worth stating, because the previous plugin in this family recorded the
 * opposite lesson. A required service that a release stops providing holds the
 * entry in `pending` forever, and an entry that never activates is a boot failure
 * here rather than a missing plugin. The counter-argument is that this plugin has
 * nothing at all to do without the session state: unlike the tabbed version, it
 * paints no icon and rewrites no title, so a build that could not observe sessions
 * would be a settings page that configures nothing. Requiring them turns that into
 * a visible boot report instead of a silent no-op.
 *
 * `remote` carries the one event this plugin cannot derive from a level: the
 * agent-error notification. It is bound optionally in `apply`, because losing it
 * costs the `failed` state and nothing else.
 *
 * `configForms` is the configuration service. Every shipped client plugin that
 * carries a `Config` declares it, and a plugin whose settings can never be read or
 * written is not worth half-activating.
 */
export const inject = ['slots', 'locale', 'configForms', 'sessions', 'uiSession']

/**
 * Client plugin body: resolve the configuration, watch every session, and register
 * the settings row that configures what watching means.
 *
 * @param ctx - client cordis context.
 */
export function apply(ctx) {
  installStyles(ctx)

  const view = typeof window === 'undefined' ? undefined : window
  const player = createPlayer({
    AudioContextClass: view?.AudioContext ?? view?.webkitAudioContext,
  })
  const notifier = createNotifier({
    view,
    onClick: (data) => {
      focusSession(ctx, data, view)
    },
  })
  const store = createRowStore()

  /** The configuration form for this plugin's own Loader entry. */
  let form
  try {
    form = ctx.configForms.get(NOTIFICATION_NAMESPACE)
  } catch (error) {
    console.error(`${PLUGIN_ID}: could not open the "${NOTIFICATION_NAMESPACE}" configuration form`, error)
  }

  /**
   * Fold the form's snapshot into the store, and keep folding it.
   * @returns a disposer.
   */
  const watchSettings = () => {
    if (form === undefined) return () => undefined
    /** @returns {void} */
    const sync = () => {
      const snapshot = form.getSnapshot()
      store.sync(snapshot?.value, snapshot?.revision)
    }
    sync()
    const dispose = form.subscribe(sync)
    return () => {
      dispose?.()
    }
  }

  ctx.effect(() => watchSettings(), `${PLUGIN_ID}: settings subscription`)
  const engine = installEngine(ctx, { store, player, notifier, view })

  // Audio cannot start before the user's first gesture, and the browser will not
  // say when that was. Resuming on the first one anywhere in the interface is what
  // makes a chime possible at all later; the card's own audition button is a
  // second, more deliberate way to do the same thing.
  ctx.effect(() => {
    if (view?.addEventListener === undefined) return undefined
    const unlock = () => {
      player.resume()
    }
    view.addEventListener('pointerdown', unlock, { passive: true })
    view.addEventListener('keydown', unlock)
    return () => {
      view.removeEventListener('pointerdown', unlock)
      view.removeEventListener('keydown', unlock)
    }
  }, `${PLUGIN_ID}: audio unlock`)

  ctx.effect(
    () => ctx.locale.register(LOCALE_NAMESPACE, { zh, en }),
    `${PLUGIN_ID}: dictionaries`,
  )

  /**
   * Play one state's sound, and say what happened.
   *
   * The audition is also the gesture that unlocks audio for the session, which is
   * why there is no separate unlock control: pressing "play" is the most direct way
   * to make a sound and the most natural way to grant permission for one.
   *
   * @param kind - the state.
   * @returns a line for the card to print, or undefined.
   */
  const audition = (kind) => {
    const settings = store.getSnapshot().settings
    const state = settings.states[kind]
    player.setMaster(settings.masterVolume)
    const played = player.play(state.melody, state.voice, stateGain(settings, kind))
    return played ? undefined : 'audition-failed'
  }

  /**
   * Raise a real banner for one state, without waiting for a session to be in it.
   *
   * This is the only control that can answer whether notifications work, and it is
   * also the gesture that asks for permission — a prompt with no context is worse
   * than one behind a button that says what it is for.
   *
   * @param kind - the state.
   * @returns a promise for the line to print.
   */
  const test = async (kind) => {
    const t = ctx.locale.bind(LOCALE_NAMESPACE)
    const settings = store.getSnapshot().settings
    const permission = notifier.permission()
    if (permission.canAsk === true) await notifier.request()
    const plan = planEvent({
      event: { kind, sessionId: 'test', title: t('notification.title'), summary: t('notification.description'), isMain: false },
      settings: { ...settings, enabled: true, states: { ...settings.states, [kind]: { ...settings.states[kind], enabled: true } } },
      counts: store.getSnapshot().counts,
      stateLabel: t(`notification.state.${kind}`),
      permission: notifier.permission(),
      visibility: readVisibility(view),
      now: Date.now(),
    })
    if (plan.banner !== undefined) {
      const outcome = notifier.show(plan.banner)
      if (outcome.shown !== true) return t(`notification.testResult.${outcome.reason === 'empty' ? 'empty' : 'threw'}`)
    }
    return describePlan(plan, t)
  }

  /**
   * Write one field of the configuration.
   *
   * @param kind - the state, or undefined for a global field.
   * @param field - the field name.
   * @param value - the value, or undefined to reset the field.
   * @param resetCard - whether to reset the whole card instead.
   * @returns {void}
   */
  const change = (kind, field, value, resetCard) => {
    if (form === undefined) return
    const settings = store.getSnapshot().settings
    const held = kind === undefined ? settings : settings.states[kind]
    const defaults = resolveSettings(undefined)
    const base = kind === undefined ? defaults : defaults.states[kind]
    /** @type {{op: string, path: string[], value?: unknown}[]} */
    const operations = []
    const push = (name, next) => {
      const path = kind === undefined ? [name] : ['states', kind, name]
      if (next === base[name]) operations.push({ op: 'unset', path })
      else operations.push({ op: 'set', path, value: next })
    }
    // Changing or resetting one field at a time: a whole-object write would replace
    // every other field with whatever this render happened to be holding, which is
    // how a settings page loses an edit made in another window.
    if (resetCard === true && kind !== undefined) {
      for (const name of Object.keys(base)) push(name, base[name])
    } else if (field !== undefined) {
      push(field, value === undefined ? held[field] : value)
    }
    // One `mutate` is one atomic document write, and it is fenced by the revision
    // the store last accepted — so a stale edit is refused rather than applied.
    const write = form.mutate(operations, store.getSnapshot().revision)
    // The write may be refused (a conflicting edit elsewhere) or rejected (no
    // durable settings at all). Both resolve `false` and neither throws, so the
    // only way a user learns is if the row says something.
    void Promise.resolve(write).then((accepted) => {
      if (accepted === false) {
        console.error(
          `${PLUGIN_ID}: the settings write was refused; the plugin keeps running on its last accepted ` +
            'configuration.',
        )
      }
    })
  }

  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register(
      {
        name: 'settings.general.item',
        id: 'dsh-notification',
        // After the built-in General rows, which are the shipped ones.
        order: 40,
        locale: LOCALE_NAMESPACE,
        inject: () => ({
          // The **instance**, not the handle: the renderer binds its selector hook to
          // whatever source it is given, by calling `getSnapshot` on it.
          hooks: { notification: store.instance },
          onChange: change,
          onAudition: audition,
          onTest: test,
          onReset: () => {
            if (form === undefined) return
            void Promise.resolve(form.unset('states')).then(() => {
              void Promise.resolve(form.unset('version'))
            })
          },
          onAskPermission: () => notifier.request(),
          permission: notifier.permission(),
          audio: player.state(),
        }),
      },
      NotificationRow,
    ),
  )

  ctx.effect(() => {
    return () => {
      notifier.closeAll()
      player.dispose()
    }
  }, `${PLUGIN_ID}: teardown`)

  // The first read is a baseline: what is already on screen when the plugin starts
  // is known, not news. Everything after it is an edge.
  engine.refresh()
}
