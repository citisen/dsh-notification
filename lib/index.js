/**
 * Host half of `dsh-notification`.
 *
 * A dsh profile bundle has two halves. This is the Node half, and it is small on
 * purpose: it declares the durable configuration and tells the settings service
 * that this package ships its own page for it. It paints nothing, plays nothing,
 * and raises no notification — every one of those decisions belongs to the
 * browser half, which is where the session state and the audio graph actually
 * live.
 *
 * ## The two contracts this file is half of
 *
 * **The namespace is the Loader entry id.** `cordis.patch.yml` inserts this
 * package's row as `id: notification`, and the client half addresses its own
 * configuration form by exactly that string. The two spellings are one contract
 * and neither can import the other — a host package and a client bundle are
 * separate module graphs — so they are written down in both places and the test
 * suite compares them. That is also why the id is spelled out in a comment in both
 * files rather than left to memory.
 *
 * **Every field is `.volatile()`.** The settings model projects a section through
 * a filtered view that keeps volatile paths only, so a field declared ordinary is
 * not merely hidden — it is *absent* from the value the client reads, and a write
 * to it is refused with `settings/rejected`. A configuration whose every field is
 * invisible is a configuration with no settings page at all. Getting this wrong is
 * silent in the worst way: the page renders, the controls move, and nothing is
 * ever saved.
 *
 * @module dsh-notification
 */

import z from '@deepseek-ai/schemastery'

/**
 * The settings namespace owned by this plugin.
 *
 * Deliberately **not** a `ui-*` name: dsh reserves that prefix for its own
 * shipped surfaces, and a third-party bundle claiming one would be squatting on a
 * namespace it does not own. It must equal the `id:` of this package's row in
 * `cordis.patch.yml` — see the module comment.
 */
export const NOTIFICATION_NAMESPACE = 'notification'

/**
 * The melodies the six states ship with, as music.
 *
 * Spelled here rather than derived from anything, because this half never reads
 * them: it only has to *store* them, and a string is a string. They are kept
 * beside the schema so a reader of the host half can see what a default install
 * sounds like without opening the browser bundle — and the test suite asserts that
 * this list and the browser half's own defaults are the same music.
 *
 * Four of these are the phrases the previous plugin in this family shipped, note
 * for note: a user who has lived with those sounds should not have them change
 * under an upgrade. The fifth is new, and it is the only one that descends and
 * ends unresolved, because that is what a failure sounds like.
 */
export const SHIPPED_MELODIES = {
  question: 'G4:170ms G4:170ms G4:170ms Eb4:680ms',
  approval: 'A5:350ms G5:95ms F5:95ms E5:95ms D5:95ms C#5:95ms D5:500ms',
  plan: 'C5:130ms C5:130ms C5:130ms C6:420ms',
  failed: 'A4:200ms G4:200ms F4:200ms E4:200ms D4:200ms C4:520ms',
  done: 'E4:230ms E4:230ms F4:230ms G4:230ms G4:230ms F4:230ms E4:230ms D4:460ms',
  running: 'G4:130ms D5:130ms G5:130ms B5:130ms D6:420ms',
}

/**
 * The timbre each state ships with.
 *
 * Also never read here — the voice names are validated by the client half against
 * its own roster — but a host half that stored a name the browser half did not
 * know would be storing a setting that resolves to a fallback, so the two lists
 * are compared by the tests.
 */
const SHIPPED_VOICES = {
  question: 'bell',
  approval: 'bell',
  plan: 'marimba',
  failed: 'bell',
  done: 'marimba',
  running: 'marimba',
}

/**
 * The volume each state ships with, and whether its card is switched on.
 *
 * `running` is the one card that ships switched off. A turn *starting* is not
 * something to interrupt anyone for, and a plugin with no way to say so would be
 * deciding policy that belongs in a setting — which is exactly why the card
 * exists and why its default is `false`.
 */
const SHIPPED_LEVELS = {
  question: { enabled: true, volume: 1 },
  approval: { enabled: true, volume: 1 },
  plan: { enabled: true, volume: 1 },
  failed: { enabled: true, volume: 1 },
  done: { enabled: true, volume: 1 },
  running: { enabled: false, volume: 1 },
}

/** The state names this plugin has a card for, in the order the cards are shown. */
export const NOTIFICATION_STATES = ['question', 'approval', 'plan', 'failed', 'done', 'running']

/**
 * One state's schema.
 *
 * Every property is volatile, and each one is a *fixed path*: `['states','done',
 * 'volume']` is a fixed path, so a nested volatile field is legal here, while the
 * same field under a dictionary key or inside a list would not be. That is why the
 * six states are written out rather than keyed from a map — the roster is a
 * compile-time constant anyway, and an explicit object keeps every path provable.
 *
 * The defaults are the shipped configuration. They are repeated in the browser
 * half, which cannot import them, and `scripts/verify-host.mjs` compares the two
 * copies so that a default changed on one side only is a failing check rather than
 * a page that renders one configuration and an engine that runs another.
 *
 * @param state - the state name.
 * @returns the state's schema.
 */
function stateSchema(state) {
  const melody = SHIPPED_MELODIES[state]
  const level = SHIPPED_LEVELS[state]
  return {
    // The card's own switch. It is what the "Alert for this state" control writes.
    enabled: z.boolean().default(level.enabled).volatile(),
    volume: z.number().min(0).max(1).default(level.volume).volatile(),
    voice: z.string().default(SHIPPED_VOICES[state]).volatile(),
    melody: z.string().default(melody).volatile(),
  }
}

/**
 * The durable configuration, as the settings model sees it.
 *
 * Five global fields used to sit beside `masterVolume` — a sound scope, two switches about where the
 * user is, and two gaps — and they are gone with the rules the browser half no longer asks about: the
 * reasoning is written out in `src/settings.js`. A stored document that still carries them is fine:
 * the browser half resolves the section against its own roster, so an unknown key is simply not read.
 *
 * `version` is stored alongside the rest so a future migration has something to
 * read. It is volatile like everything else, because a field the model cannot see
 * is a field the model cannot preserve.
 */
export const Config = z.object({
  version: z.natural().default(1).volatile(),
  masterVolume: z.number().min(0).max(1).default(1).volatile(),
  states: z.object(
    Object.fromEntries(NOTIFICATION_STATES.map((state) => [state, z.object(stateSchema(state))])),
  ),
})

/**
 * Host plugin body.
 *
 * The only thing it does is hand the configuration to the settings service and
 * decline the generated page. Declining it is what the shipped peers do, and it is
 * the right call here for a reason specific to this plugin: the configuration is
 * six cards of controls with auditions and a live permission state, and a page
 * generated from the schema could not render any of that. A generated page next to
 * this one would be a second, worse copy of the same settings.
 *
 * `ctx.inject` rather than a required service, so a composition without a settings
 * service still loads: the plugin runs on its shipped defaults and the browser
 * half says why nothing can be saved the first time a control is used. A required
 * service would hold the entry in `pending` forever, and an entry that never
 * activates is a boot failure in this application rather than a missing plugin.
 *
 * @param ctx - the host context.
 */
export function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings
    if (typeof settings.configure !== 'function') {
      settingsCtx.logger?.error?.(
        `${NOTIFICATION_NAMESPACE}: this dsh exposes no settings.configure(), so the durable ` +
          `"${NOTIFICATION_NAMESPACE}" section cannot be registered and the plugin will run on its ` +
          'shipped defaults.',
      )
      return
    }
    // `auto: false` — this package ships its own settings row.
    settingsCtx.effect(() => settings.configure({ auto: false }, ctx.fiber))
  })
}
