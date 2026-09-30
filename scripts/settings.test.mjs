/**
 * Unit tests for the configuration: its defaults, the coercion of a hand-edited
 * document, and the policy that decides whether anything happens.
 *
 * The policy half is the part worth this many assertions. Every branch in
 * {@link admit} and {@link soundAllowed} is a decision that was wrong in some
 * version of this feature, and each one is asserted as the situation a user
 * would describe ("it beeped at me while I was reading it") rather than as the
 * field it reads.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { VOICE_NAMES } from '../src/sound.js'
import { STATE_KINDS } from '../src/states.js'
import { unknownFields } from '../src/templates.js'
import {
  GLOBAL_DEFAULTS,
  GLOBAL_FIELDS,
  SETTINGS_VERSION,
  SOUND_SCOPES,
  STATE_DEFAULTS,
  STATE_FIELDS,
  admit,
  coerceField,
  defaultSection,
  resolveSettings,
  soundAllowed,
  stateGain,
  stateVoice,
} from '../src/settings.js'

test('an absent section resolves to the shipped defaults, completely', () => {
  const settings = resolveSettings(undefined)
  assert.equal(settings.enabled, GLOBAL_DEFAULTS.enabled)
  assert.equal(settings.masterVolume, GLOBAL_DEFAULTS.masterVolume)
  assert.equal(settings.soundScope, GLOBAL_DEFAULTS.soundScope)
  assert.deepEqual(Object.keys(settings.states), STATE_KINDS)
  for (const kind of STATE_KINDS) {
    assert.deepEqual(settings.states[kind], STATE_DEFAULTS[kind], `${kind} must ship as documented`)
  }
})

test('a section that is not an object at all resolves to the defaults', () => {
  for (const stored of ['nonsense', 42, null, []]) {
    const settings = resolveSettings(stored)
    assert.equal(settings.masterVolume, GLOBAL_DEFAULTS.masterVolume)
    assert.deepEqual(Object.keys(settings.states), STATE_KINDS)
  }
})

test('the shipped document round-trips through the resolver unchanged', () => {
  // The failure this pins: a default written in one place and read in another,
  // so the interface renders one configuration and the engine runs a different
  // one. Deriving the stored default from the same tables makes that impossible.
  const shipped = defaultSection()
  const resolved = resolveSettings(shipped)
  assert.equal(resolved.version, SETTINGS_VERSION)
  for (const kind of STATE_KINDS) {
    assert.deepEqual(resolved.states[kind], STATE_DEFAULTS[kind])
  }
  for (const field of GLOBAL_FIELDS) {
    assert.deepEqual(
      resolved[field.id],
      GLOBAL_DEFAULTS[field.id],
      `${field.id} must survive its own default`,
    )
  }
})

test('one changed field leaves every other field alone', () => {
  const settings = resolveSettings({ states: { done: { volume: 0.9 } } })
  assert.equal(settings.states.done.volume, 0.9)
  assert.equal(settings.states.done.voice, STATE_DEFAULTS.done.voice)
  assert.equal(settings.states.done.notification, STATE_DEFAULTS.done.notification)
  assert.equal(settings.states.question.volume, STATE_DEFAULTS.question.volume)
})

test('booleans accept the spellings a settings file accumulates, and refuse the rest', () => {
  const field = { id: 'on', kind: 'boolean' }
  for (const [value, expected] of [
    [true, true],
    [false, false],
    ['true', true],
    ['on', true],
    ['yes', true],
    [1, true],
    ['false', false],
    ['off', false],
    ['no', false],
    [0, false],
  ]) {
    assert.equal(coerceField(field, value), expected, `${String(value)} must coerce to ${String(expected)}`)
  }
  for (const value of ['maybe', 2, {}, [], undefined, null, '']) {
    assert.equal(coerceField(field, value), undefined, `${JSON.stringify(value)} must be refused`)
  }
})

test('a number outside its declared range is refused rather than clamped', () => {
  const field = { id: 'v', kind: 'number', min: 0, max: 1 }
  assert.equal(coerceField(field, 0.5), 0.5)
  assert.equal(coerceField(field, '0.25'), 0.25)
  assert.equal(coerceField(field, 0), 0)
  assert.equal(coerceField(field, 1), 1)
  // Silently clamping produces a card that shows a value the user never chose.
  assert.equal(coerceField(field, 2), undefined)
  assert.equal(coerceField(field, -0.1), undefined)
  assert.equal(coerceField(field, 'lots'), undefined)
  assert.equal(coerceField(field, Number.NaN), undefined)
})

test('a choice accepts only the names its roster declares', () => {
  const field = { id: 'voice', kind: 'choice', values: VOICE_NAMES }
  assert.equal(coerceField(field, 'bell'), 'bell')
  assert.equal(coerceField(field, 'tuba'), undefined)
})

test('text fields keep an empty string, which is a decision rather than an absence', () => {
  const field = { id: 'melody', kind: 'melody' }
  // `off` and `` both mean silence; neither may become "use the default".
  assert.equal(coerceField(field, 'off'), 'off')
  assert.equal(coerceField(field, ''), '')
  assert.equal(coerceField(field, 7), undefined)
})

test('an impossible stored value falls back to the default instead of breaking the card', () => {
  const settings = resolveSettings({
    masterVolume: 5,
    soundScope: 'sometimes',
    states: { question: { voice: 'tuba', volume: 3, enabled: 'maybe' } },
  })
  assert.equal(settings.masterVolume, GLOBAL_DEFAULTS.masterVolume)
  assert.equal(settings.soundScope, GLOBAL_DEFAULTS.soundScope)
  assert.equal(settings.states.question.voice, STATE_DEFAULTS.question.voice)
  assert.equal(settings.states.question.volume, STATE_DEFAULTS.question.volume)
  assert.equal(settings.states.question.enabled, STATE_DEFAULTS.question.enabled)
})

test('every roster field is reachable and documented', () => {
  for (const field of [...STATE_FIELDS, ...GLOBAL_FIELDS]) {
    assert.equal(typeof field.id, 'string', 'a field needs an id')
    assert.equal(typeof field.kind, 'string', `${field.id} needs a kind`)
    assert.equal(typeof field.label, 'string', `${field.id} needs a label`)
    assert.equal(typeof field.hint, 'string', `${field.id} needs a hint`)
  }
  // The two rosters are disjoint by construction: a global field and a state
  // field with the same name would make the card's meaning position-dependent.
  const globalIds = new Set(GLOBAL_FIELDS.map((field) => field.id))
  const shared = STATE_FIELDS.filter((field) => globalIds.has(field.id)).map((field) => field.id)
  assert.deepEqual(shared, ['enabled'], 'only `enabled` names both a card and the master switch')
})

test('the master switch silences every card', () => {
  const settings = resolveSettings({ enabled: false })
  for (const kind of STATE_KINDS) {
    assert.deepEqual(admit(kind, settings, { now: 0 }), { allowed: false, reason: 'master-off' })
  }
})

test("a card's own switch silences that card alone", () => {
  const settings = resolveSettings({ states: { done: { enabled: false } } })
  assert.equal(admit('done', settings, {}).reason, 'card-off')
  assert.equal(admit('question', settings, {}).allowed, true)
})

test('a card with both channels off is switched off, not redirected', () => {
  const settings = resolveSettings({
    states: { done: { sound: false, notification: false } },
  })
  const outcome = admit('done', settings, {})
  assert.deepEqual(outcome, { allowed: false, reason: 'no-channel' })
})

test('turning the bell channel off leaves the banner channel working', () => {
  const settings = resolveSettings({ soundScope: 'off' })
  // `admit` still allows the event: it is a notification, not a sound.
  assert.equal(admit('question', settings, {}).allowed, true)
  assert.equal(soundAllowed(settings, { visible: false, focused: false }), false)
})

test('the plugin says nothing about the session the user is already reading', () => {
  const settings = resolveSettings({})
  assert.deepEqual(admit('question', settings, { isMain: true, skipFocusedSession: true }), {
    allowed: false,
    reason: 'focused-session',
  })
  // Only when the caller says the window is actually in front.
  assert.equal(admit('question', settings, { isMain: true, skipFocusedSession: false }).allowed, true)
  assert.equal(admit('question', settings, { isMain: false, skipFocusedSession: true }).allowed, true)
  // And a user who wants to hear about it anyway can turn the rule off.
  const insists = resolveSettings({ skipFocusedSession: false })
  assert.equal(admit('question', insists, { isMain: true, skipFocusedSession: true }).allowed, true)
})

test('a session flapping between states can be rate-limited', () => {
  const settings = resolveSettings({ repeatMs: 5000 })
  assert.deepEqual(admit('done', settings, { now: 10_000, lastSpokenAt: 8000 }), {
    allowed: false,
    reason: 'repeat',
  })
  assert.equal(admit('done', settings, { now: 20_000, lastSpokenAt: 8000 }).allowed, true)
  // Off by default: the shipped value does not rate-limit repeats, because the
  // states themselves are already edge-triggered.
  const shipped = resolveSettings({})
  assert.equal(admit('done', shipped, { now: 10, lastSpokenAt: 9 }).allowed, true)
})

test('the bell is gated on the window, and `always` removes the gate', () => {
  const background = resolveSettings({ soundScope: 'background' })
  // In the background means hidden *or* unfocused: a window sitting behind
  // another application is still a window the user is not looking at, and that
  // is the case the chime is for.
  assert.equal(soundAllowed(background, { visible: false, focused: false }), true)
  assert.equal(soundAllowed(background, { visible: false, focused: true }), true)
  assert.equal(soundAllowed(background, { visible: true, focused: false }), true)
  // The one case it is not for: the user is reading this window.
  assert.equal(soundAllowed(background, { visible: true, focused: true }), false)

  const always = resolveSettings({ soundScope: 'always' })
  assert.equal(soundAllowed(always, { visible: true, focused: true }), true)

  const off = resolveSettings({ soundScope: 'off' })
  assert.equal(soundAllowed(off, { visible: false, focused: false }), false)

  // The opt-in that turns the whole rule off, for a user who wants the chime
  // even while looking at the interface.
  const insist = resolveSettings({ soundScope: 'background', skipWhenVisible: true })
  assert.equal(soundAllowed(insist, { visible: true, focused: true }), true)
  assert.equal(soundAllowed(insist, { visible: false, focused: false }), true)
  assert.deepEqual(SOUND_SCOPES, ['off', 'background', 'always'])
})

test('the state and the master volume multiply, so the master knob is real', () => {
  const settings = resolveSettings({ masterVolume: 0.5, states: { done: { volume: 0.4 } } })
  assert.ok(Math.abs(stateGain(settings, 'done') - 0.2) < 1e-9, '0.4 × 0.5')
  assert.ok(
    Math.abs(stateGain(settings, 'question') - STATE_DEFAULTS.question.volume * 0.5) < 1e-9,
  )
  // A product can never exceed either factor, which is the whole reason the
  // clamp exists.
  const loud = resolveSettings({ masterVolume: 1, states: { done: { volume: 1 } } })
  assert.equal(stateGain(loud, 'done'), 1)
})

test('a state whose voice is unknown falls back to that state’s own shipped voice', () => {
  // The fallback is per state, not global: a state that shipped with a marimba
  // must not become a sine because one stored word was wrong.
  const settings = resolveSettings({ states: { done: { voice: 'tuba' } } })
  assert.equal(stateVoice(settings, 'done'), STATE_DEFAULTS.done.voice)
  assert.equal(stateVoice(resolveSettings({}), 'question'), STATE_DEFAULTS.question.voice)
  assert.ok(VOICE_NAMES.includes(stateVoice(resolveSettings({}), 'question')))
  // And the last-resort fallback, for a kind nobody configured at all.
  assert.equal(stateVoice({}, 'question'), 'sine')
})

test('the shipped cards are configured the way the documentation claims', () => {
  // The three states that mean "a person must act" raise a banner; the two that
  // do not, do not. This is the one default a reader is most likely to check.
  for (const kind of ['question', 'approval', 'plan', 'failed']) {
    assert.equal(STATE_DEFAULTS[kind].notification, true, `${kind} should raise a banner`)
    assert.equal(STATE_DEFAULTS[kind].enabled, true, `${kind} should ship enabled`)
  }
  assert.equal(STATE_DEFAULTS.done.notification, false)
  assert.equal(STATE_DEFAULTS.running.notification, false)
  assert.equal(STATE_DEFAULTS.running.enabled, false, 'a turn starting is not worth an interruption')
  // Every shipped melody must be a real melody: the sound tests prove the
  // grammar, this proves nobody wrote a placeholder into a default.
  for (const kind of STATE_KINDS) {
    assert.ok(STATE_DEFAULTS[kind].melody.length > 0)
    assert.ok(STATE_DEFAULTS[kind].title.length > 0)
  }
  // And every shipped template must use only the documented placeholders. Without this,
  // every card opens with a warning about its own correct text — a warning that fires on
  // everything teaches the user to ignore the one that matters.
  for (const kind of STATE_KINDS) {
    assert.deepEqual(unknownFields(STATE_DEFAULTS[kind].title), [], `${kind} title placeholders`)
    assert.deepEqual(unknownFields(STATE_DEFAULTS[kind].body), [], `${kind} body placeholders`)
  }
})
