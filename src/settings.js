/**
 * Settings: the whole configuration, its defaults, and the policy that reads it.
 *
 * Every value the plugin runs on comes through {@link resolveSettings}. Nothing
 * else reaches into a stored section, and that single entry point is what keeps
 * the three halves of this plugin — the engine, the settings cards, and the
 * documentation — from disagreeing about what a missing field means. The
 * previous plugin in this family shipped that particular bug: its host schema and
 * its browser fallback each had their own copy of the defaults, and a change to
 * one of them rendered one configuration while running another.
 *
 * The shape is deliberately flat and card-shaped. `perState` holds one record per
 * state, and a card is one record, which is why "each card can be switched off on
 * its own" is a field and not a special case.
 *
 * @module dsh-notification/settings
 */

import { DEFAULT_VOICE, VOICE_NAMES } from './sound.js'
import { STATE_KINDS } from './states.js'

/**
 * Whether the system notification channel is live.
 *
 * **Off, in code, deliberately.** The channel is kept rather than deleted so it can be turned
 * back on in one place if the platform ever grows a way to make it work — and it is a constant
 * rather than a setting so that it cannot be half-enabled from the interface while it does not
 * work.
 *
 * Why it is off, measured rather than assumed, in the desktop shell:
 *
 * - the shell installs **no permission request handler**, so `Notification.requestPermission()`
 *   resolves immediately to `denied` with no prompt and *consumes* the `default` — a plugin that
 *   asks destroys the very permission it is trying to obtain;
 * - `Notification.permission` then reads `denied` while `new Notification(...)` still
 *   *constructs successfully*, so from inside the page the plugin cannot tell whether a banner
 *   was shown or whether the operating system dropped it;
 * - and the shell's own notifications are raised in the **main process** — its mandatory update
 *   prompt calls Electron's `Notification` there, not the renderer's Web API.
 *
 * A channel whose success cannot be observed and whose failure is indistinguishable from
 * success is not a feature. Shipping it produced a test button that reported "sent" and showed
 * nothing.
 *
 * Turning it on properly needs a host-side bridge to the main process: the shell has to expose
 * one, because a client plugin cannot reach Electron. That is a change to the application, not
 * to this bundle — and everything the channel needs is below, kept working and tested, so that
 * bridging it is the only remaining step.
 */
export const NOTIFICATIONS_ENABLED = false

/**
 * When a sound is allowed to be audible at all.
 *
 * `background` is the shipped value and the reasoning is the same one the tabbed
 * plugin recorded: while the user is looking at the interface, the interface has
 * already said what happened, and a chime on top of that is noise. `always` is
 * for a user who wants the feedback regardless, and `off` mutes the bell channel
 * without touching any card.
 */
export const SOUND_SCOPES = ['off', 'background', 'always']

/**
 * The per-state defaults.
 *
 * ## The melodies
 *
 * Every phrase is a public-domain classical quotation, chosen for what its state means rather
 * than for how it sounds in isolation, and each is short enough to be an alert rather than a
 * performance:
 *
 * - **question** — Beethoven, Symphony No. 5 op. 67, the opening motif. Beethoven called it
 *   fate knocking at the door, which is exactly what a question is: someone outside, waiting.
 * - **approval** — Bach, Toccata and Fugue in D minor BWV 565, the opening descent. Grave and
 *   downward: this is not a call, it is a decision that has to be made.
 * - **plan** — an ascending C-major arpeggio, for something put in front of you to read.
 * - **failed** — the *Dies irae*, the 13th-century plainchant sequence, quoted in its opening
 *   descent. The most recognisable funeral melody in Western music, and the one phrase here
 *   that ends unresolved.
 * - **done** — Beethoven, Symphony No. 9, the "Ode to Joy" theme, low and quiet: closure.
 * - **running** — Mozart, Eine kleine Nachtmusik K. 525, the opening arpeggio. Bright, upward
 *   and *beginning*, which is what it reports.
 *
 * The four phrases that were already here are kept note for note from the previous plugin in
 * this family, because a user who has lived with those sounds should not have them change under
 * an upgrade. `failed` and `running` were the two that plugin did not have — its failure state
 * did not exist and its running state made no sound — so both are new, and both were chosen
 * under the rule above.
 *
 * ## The volumes
 *
 * All at full, deliberately. These are levels a card multiplies by the master volume, so a
 * default below 1 means a user who has turned the master up still hears something quieter than
 * they asked for, for no reason they can see. What a user actually wants quieter, they turn
 * down on the card that annoys them.
 */
export const STATE_DEFAULTS = {
  question: {
    enabled: true,
    sound: true,
    volume: 1,
    voice: 'bell',
    melody: 'G4:170ms G4:170ms G4:170ms Eb4:680ms',
  },
  approval: {
    enabled: true,
    sound: true,
    volume: 1,
    voice: 'bell',
    melody: 'A5:350ms G5:95ms F5:95ms E5:95ms D5:95ms C#5:95ms D5:500ms',
  },
  plan: {
    enabled: true,
    sound: true,
    volume: 1,
    voice: 'marimba',
    melody: 'C5:120ms E5:120ms G5:120ms C6:420ms',
  },
  failed: {
    enabled: true,
    sound: true,
    volume: 1,
    // A bell for the *Dies irae*: the chant is a bell anyway, and the voice's long inharmonic
    // tail is what makes six descending notes read as one solemn phrase rather than six blips.
    voice: 'bell',
    melody: 'A4:200ms G4:200ms F4:200ms E4:200ms D4:200ms C4:520ms',
  },
  done: {
    enabled: true,
    sound: true,
    volume: 1,
    voice: 'marimba',
    melody: 'E4:230ms E4:230ms F4:230ms G4:230ms G4:230ms F4:230ms E4:230ms D4:460ms',
  },
  running: {
    // The one card that ships switched off, and the reason the card exists at all: a turn
    // *starting* is not something to interrupt anyone for, so the shipped answer is no. A user
    // who wants feedback that work began turns it on, and that is a decision the card can
    // express rather than a policy the engine has to guess.
    enabled: false,
    sound: false,
    volume: 1,
    // A marimba rather than a bell or a sawtooth: a rising arpeggio wants a percussive attack
    // and a short decay, which is exactly the wooden bar.
    voice: 'marimba',
    melody: 'G4:130ms D5:130ms G5:130ms B5:130ms D6:420ms',
  },
}

/**
 * The global defaults.
 *
 * `minGapMs` is the one number here that is a mitigation rather than a
 * preference: agents ask several questions in a row, and three chimes in three
 * seconds reads as a malfunction. The gap is measured against a clock the caller
 * supplies rather than a timer, because a background window throttles
 * `setTimeout` and a timer-based gap fires late or not at all.
 */
export const GLOBAL_DEFAULTS = {
  enabled: true,
  // Full, like every state's own level. The two multiply, so a master below 1 would mean a fresh
  // install does not actually play at the volume its cards claim — and the knob exists for a user
  // who wants things quieter than the card they are configuring, not for a default nobody chose.
  masterVolume: 1,
  soundScope: 'background',
  minGapMs: 1500,
  skipFocusedSession: true,
  skipWhenVisible: false,
  repeatMs: 0,
}

/** The settings-schema version, so a future migration has something to read. */
export const SETTINGS_VERSION = 1

/**
 * The field roster, in the order a card lists it.
 *
 * This table is the contract between three things that cannot import each other:
 * the settings card that renders a control, the engine that reads the value, and
 * the host-half schema that decides what may be stored. It is written down once
 * here and asserted by the tests, which is the only way a fourth writer can be
 * prevented from inventing a field nobody reads.
 */
export const STATE_FIELDS = [
  { id: 'enabled', kind: 'boolean', label: 'Alert for this state', hint: 'the card’s own master switch' },
  { id: 'sound', kind: 'boolean', label: 'Play a sound', hint: 'this state’s bell' },
  { id: 'volume', kind: 'number', min: 0, max: 1, label: 'Volume', hint: 'this state’s own level' },
  { id: 'voice', kind: 'choice', values: VOICE_NAMES, label: 'Timbre', hint: 'what it sounds like' },
  { id: 'melody', kind: 'melody', label: 'Melody', hint: 'note names and lengths; off for silence' },
]

/** The global field roster, in the order the section lists it. */
export const GLOBAL_FIELDS = [
  { id: 'enabled', kind: 'boolean', label: 'Enable notifications', hint: 'the plugin’s master switch' },
  { id: 'masterVolume', kind: 'number', min: 0, max: 1, label: 'Master volume', hint: 'applies to every state’s sound' },
  { id: 'soundScope', kind: 'choice', values: SOUND_SCOPES, label: 'When sound plays', hint: 'the bell channel' },
  { id: 'minGapMs', kind: 'number', min: 0, max: 30_000, label: 'Minimum gap between sounds', hint: 'milliseconds' },
  { id: 'skipFocusedSession', kind: 'boolean', label: 'Stay quiet about the session you are looking at', hint: 'it is already on screen' },
  { id: 'skipWhenVisible', kind: 'boolean', label: 'Stay quiet while the window is in front', hint: 'no sound and no banner while you are here' },
  { id: 'repeatMs', kind: 'number', min: 0, max: 600_000, label: 'Do not repeat the same state within', hint: 'milliseconds; 0 for no limit' },
]

/**
 * Coerce one stored value to the shape the engine reads.
 *
 * The stored document is user-editable YAML and the wire carries whatever it
 * holds, so this survives a hand-edit rather than validating a form: a field that
 * says nothing is left out so its default stands, and a field that says something
 * impossible is refused rather than clamped silently — a card that shows 2 for a
 * volume that can only be 1 is worse than a card that shows the default.
 *
 * @param field - a roster entry.
 * @param value - the stored value.
 * @returns the usable value, or undefined when the value says nothing usable.
 */
export function coerceField(field, value) {
  if (value === undefined || value === null) return undefined
  if (field.kind === 'boolean') {
    if (value === true || value === false) return value
    // A hand-written `yes`/`on`/`1` is what a settings file accumulates.
    if (value === 'true' || value === 'on' || value === 'yes' || value === 1) return true
    if (value === 'false' || value === 'off' || value === 'no' || value === 0) return false
    return undefined
  }
  if (field.kind === 'number') {
    const numeric = typeof value === 'number' ? value : Number.parseFloat(value)
    if (!Number.isFinite(numeric)) return undefined
    if (field.min !== undefined && numeric < field.min) return undefined
    if (field.max !== undefined && numeric > field.max) return undefined
    return numeric
  }
  if (field.kind === 'choice') {
    return field.values.includes(value) ? value : undefined
  }
  // A template or a melody is text. An empty one is a decision — silence, or a
  // fallback body — so it is kept rather than treated as absent.
  if (typeof value === 'string') return value
  return undefined
}

/**
 * Resolve one stored record against a field roster.
 * @param fields - the roster.
 * @param defaults - the defaults for that record.
 * @param stored - the stored record, if any.
 * @returns every field, with defaults filled in.
 */
function resolveRecord(fields, defaults, stored) {
  const resolved = { ...defaults }
  if (stored === null || typeof stored !== 'object') return resolved
  for (const field of fields) {
    const value = coerceField(field, stored[field.id])
    if (value !== undefined) resolved[field.id] = value
  }
  return resolved
}

/**
 * The plugin's whole configuration as the engine reads it.
 *
 * Total: any input produces a complete, usable configuration, because a settings
 * file with a typo in it must not be able to stop the plugin from telling the
 * user that their session is waiting. A stored section that is not an object at
 * all — a string where a map belongs — yields the shipped defaults.
 *
 * @param section - the stored section, or nothing.
 * @returns `{ version, enabled, masterVolume, soundScope, minGapMs,
 */
export function resolveSettings(section) {
  const stored = section !== null && typeof section === 'object' ? section : {}
  const globals = resolveRecord(GLOBAL_FIELDS, GLOBAL_DEFAULTS, stored)
  const states = {}
  const storedStates = stored.states !== null && typeof stored.states === 'object' ? stored.states : {}
  for (const kind of STATE_KINDS) {
    states[kind] = resolveRecord(STATE_FIELDS, STATE_DEFAULTS[kind], storedStates[kind])
  }
  return {
    version: Number.isInteger(stored.version) ? stored.version : SETTINGS_VERSION,
    ...globals,
    states,
  }
}

/**
 * The section the plugin ships with, as the stored shape.
 *
 * This is what the host-half schema defaults to and what a card's "reset this
 * state" writes, so it is derived from the same tables rather than written out a
 * second time — the mistake this family has already made once.
 *
 * @returns the default section.
 */
export function defaultSection() {
  const states = {}
  for (const kind of STATE_KINDS) states[kind] = { ...STATE_DEFAULTS[kind] }
  return { version: SETTINGS_VERSION, ...GLOBAL_DEFAULTS, states }
}

/**
 * Whether a state's configuration is worth acting on for one event.
 *
 * The order of these checks is the design, and every one of them is a decision
 * that has been wrong in some version of this feature somewhere:
 *
 * 1. **The master switch, then the card's own.** Two switches in series, because
 *    "silence everything" and "silence this one state" are different intentions.
 * 2. **The state must have something to do.** A card with both channels off is
 *    not an error, it is a card that has been switched off — and the answer is
 *    "nothing", not "play the other channel".
 * 3. **The session the user is looking at.** When the window has focus and the
 *    session is the one on screen, the interface *is* the notification. This is
 *    the check that keeps the plugin from being annoying in the one situation
 *    where it has nothing to add.
 * 4. **The same session repeating.** A session can flap between states within
 *    seconds, and `repeatMs` is the user's answer to how much of that they want.
 *
 * @param kind - the state the event is about.
 * @param settings - resolved settings.
 * @param facts - `{ isMain, now, lastSpokenAt }`.
 * @returns `{ allowed, reason }`: whether anything should happen, and why not.
 */
export function admit(kind, settings, facts) {
  const state = settings?.states?.[kind]
  if (settings?.enabled !== true) return { allowed: false, reason: 'master-off' }
  if (state === undefined) return { allowed: false, reason: 'unknown-state' }
  if (state.enabled !== true) return { allowed: false, reason: 'card-off' }
  // There is one channel. A card with its bell switched off — or with the bell muted globally —
  // has nothing it could do, so it is switched off rather than admitted and then silent.
  const wantsSound = state.sound === true && settings.soundScope !== 'off'
  if (!wantsSound) return { allowed: false, reason: 'no-channel' }
  if (facts?.skipFocusedSession === true && settings.skipFocusedSession === true && facts.isMain === true) {
    return { allowed: false, reason: 'focused-session' }
  }
  const repeatMs = settings.repeatMs
  if (
    typeof repeatMs === 'number' &&
    repeatMs > 0 &&
    typeof facts?.lastSpokenAt === 'number' &&
    typeof facts?.now === 'number' &&
    facts.now - facts.lastSpokenAt < repeatMs
  ) {
    return { allowed: false, reason: 'repeat' }
  }
  return { allowed: true, reason: 'allowed' }
}

/**
 * Whether the bell channel may be audible right now.
 *
 * Kept apart from {@link admit} because the two answer different questions and
 * are decided at different moments: `admit` is asked once when an event arrives,
 * and this is asked again at play time, when the window's visibility may have
 * changed. A sound that was admitted while the window was hidden and then played
 * while the user is reading the screen is exactly the case `background` exists to
 * prevent.
 *
 * @param settings - resolved settings.
 * @param facts - `{ visible, focused }`.
 * @returns whether to play.
 */
export function soundAllowed(settings, facts) {
  const scope = settings?.soundScope
  if (scope === 'off') return false
  if (scope === 'always') return true
  // `background` — the shipped value: only while this window is not in front.
  if (settings?.skipWhenVisible === true) return true
  return facts?.visible !== true || facts?.focused !== true
}

/**
 * The gain one state's sound plays at.
 *
 * A product rather than an override, and that is a deliberate reversal of a
 * decision the previous plugin made. Master volume is a knob the user asked for
 * by name, and a knob that silently does nothing for states that have their own
 * level would be a knob that does nothing. So the two numbers multiply, and the
 * card prints both — the state's level and the master — so the figure a user
 * hears is one they can find on the screen.
 *
 * @param settings - resolved settings.
 * @param kind - the state.
 * @returns the gain, 0–1.
 */
export function stateGain(settings, kind) {
  const own = settings?.states?.[kind]?.volume
  const master = settings?.masterVolume
  const left = typeof own === 'number' ? own : 1
  const right = typeof master === 'number' ? master : 1
  return Math.min(1, Math.max(0, left * right))
}

/**
 * The voice a state plays with, falling back to the shipped one.
 * @param settings - resolved settings.
 * @param kind - the state.
 * @returns the voice name.
 */
export function stateVoice(settings, kind) {
  const voice = settings?.states?.[kind]?.voice
  return VOICE_NAMES.includes(voice) ? voice : DEFAULT_VOICE
}
