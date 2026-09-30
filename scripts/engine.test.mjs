/**
 * Unit tests for the engine: what one state change actually does.
 *
 * This is the file that makes the plugin's behaviour checkable rather than audible. Every rule a user
 * would describe as a sentence — "it stayed quiet because I was looking at that session", "it did not
 * chime twice" — is asserted here as the situation, not as the field.
 *
 * The engine plans **one** thing: a sound. Everything about the notification channel lives in
 * `system.js` and `templates.js`, which the shipped bundle does not contain, and
 * `system.test.mjs` / `templates.test.mjs` cover those.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createSpeechLog, describePlan, firstAudible, gapElapsed, planEvent } from '../src/engine.js'
import { GLOBAL_DEFAULTS, STATE_DEFAULTS, resolveSettings } from '../src/settings.js'
import { STATE_KINDS } from '../src/states.js'

/** A window the user is not looking at. */
const HIDDEN = { visible: false, focused: false }
/** A window the user is looking at. */
const WATCHING = { visible: true, focused: true }

/**
 * An event from the state machine.
 * @param overrides - fields to override.
 * @returns the event.
 */
function event(overrides = {}) {
  return {
    kind: 'question',
    sessionId: 'a',
    title: 'Deploy',
    summary: 'Which file?',
    isMain: false,
    previous: 'running',
    ...overrides,
  }
}

/**
 * Plan one event against resolved settings.
 * @param overrides - `{ event, settings, visibility, now, lastSpoke }`.
 * @returns the plan.
 */
function planFor(overrides = {}) {
  return planEvent({
    event: overrides.event ?? event(),
    settings: overrides.settings ?? resolveSettings(undefined),
    visibility: overrides.visibility ?? HIDDEN,
    now: overrides.now ?? 100_000,
    lastSpoke: overrides.lastSpoke,
  })
}

test('a shipped card plans its sound at the configured level', () => {
  const plan = planFor()
  assert.equal(plan.admit, true)
  assert.equal(plan.reason, 'allowed')
  assert.equal(plan.sound.kind, 'question')
  assert.equal(plan.sound.voice, STATE_DEFAULTS.question.voice)
  assert.equal(plan.sound.melody, STATE_DEFAULTS.question.melody)
  // Derived rather than written out: the two levels multiply and both ship at full, so a literal here
  // would be a second opinion about a default the settings module already states.
  assert.ok(
    Math.abs(plan.sound.gain - STATE_DEFAULTS.question.volume * GLOBAL_DEFAULTS.masterVolume) < 1e-9,
  )
})

test('the global mute silences every card, with a reason the row can print', () => {
  // `soundScope: 'off'` is the one control that means "silence everything for now". There used to be a
  // plugin-wide switch above the settings doing the same job, and it is gone: dsh disables a plugin from
  // its own manager, so a second switch was a second place to look when the plugin was silent.
  //
  // Every card is turned on for this, because the question is what the *mute* does — a card that ships
  // switched off would answer `card-off`, and the test would pass without reaching the rule it is about.
  // That ordering is deliberate: the checks run from the most general to the most specific, so a card the
  // user switched off says so rather than blaming the mute.
  const settings = resolveSettings({
    soundScope: 'off',
    states: Object.fromEntries(STATE_KINDS.map((kind) => [kind, { enabled: true }])),
  })
  for (const kind of STATE_KINDS) {
    const plan = planFor({ event: event({ kind }), settings })
    assert.deepEqual(
      { admit: plan.admit, reason: plan.reason },
      { admit: false, reason: 'global-mute' },
      `${kind} must be muted by the global mute`,
    )
    assert.equal(plan.sound, undefined)
  }
})

test("a card's own switch silences that card alone", () => {
  const settings = resolveSettings({ states: { done: { enabled: false } } })
  assert.equal(planFor({ event: event({ kind: 'done' }), settings }).reason, 'card-off')
  // And a different card is untouched by it.
  assert.equal(planFor({ settings }).admit, true)
})

test('a card with its bell off is switched off, not admitted and then silent', () => {
  const settings = resolveSettings({ states: { done: { sound: false } } })
  const plan = planFor({ event: event({ kind: 'done' }), settings })
  assert.deepEqual({ admit: plan.admit, reason: plan.reason }, { admit: false, reason: 'no-channel' })
  assert.equal(plan.sound, undefined)
})

test('the bell is gated on the window', () => {
  // `background` is the shipped scope: a window the user is reading is a window the interface has
  // already spoken for.
  assert.equal(planFor({ visibility: WATCHING }).sound, undefined)

  // `always` removes that gate, and `off` closes the channel for every card.
  const always = planFor({ settings: resolveSettings({ soundScope: 'always' }), visibility: WATCHING })
  assert.notEqual(always.sound, undefined)

  const off = planFor({ settings: resolveSettings({ soundScope: 'off' }) })
  assert.equal(off.sound, undefined)
  assert.equal(off.reason, 'global-mute')
})

test('the plugin says nothing about the session the user is reading', () => {
  const plan = planFor({ event: event({ isMain: true }), visibility: WATCHING })
  assert.equal(plan.reason, 'focused-session')
  assert.equal(plan.sound, undefined)

  // A main-view session while the window is in the background is still news: the user is elsewhere,
  // so the interface is not the notification.
  assert.equal(planFor({ event: event({ isMain: true }), visibility: HIDDEN }).admit, true)
})

test('a build that cannot see the window does not claim the session is focused', () => {
  // No visibility at all: the focused-session rule must not fire, because the fact it is about does
  // not exist. Claiming it would mute the plugin entirely.
  const plan = planEvent({ event: event({ isMain: true }), settings: resolveSettings(undefined), now: 1 })
  assert.equal(plan.admit, true)
})

test('a rate-limited repeat is refused with its own reason', () => {
  const settings = resolveSettings({ repeatMs: 5000 })
  const log = createSpeechLog()
  log.note('a', 99_000)
  const repeated = planFor({ settings, lastSpoke: log, now: 100_000 })
  assert.deepEqual({ admit: repeated.admit, reason: repeated.reason }, { admit: false, reason: 'repeat' })

  // After the window it is allowed again, and the shipped default does not rate-limit at all.
  assert.equal(planFor({ settings, lastSpoke: log, now: 104_000 }).admit, true)
  assert.equal(planFor({ lastSpoke: log, now: 99_001 }).admit, true)
})

test('a gain of zero is not planned as a sound', () => {
  const plan = planFor({ settings: resolveSettings({ masterVolume: 0 }) })
  assert.equal(plan.admit, true)
  assert.equal(plan.sound, undefined, 'a silent gain is not a sound to play')
})

test('one sound per burst is the first plan that has a sound, not the first plan', () => {
  // The bug this pins: taking the first event and finding it silent would suppress the whole burst,
  // because the silent card is first in the urgency order.
  const silent = planFor({ settings: resolveSettings({ states: { question: { sound: false } } }) })
  const loud = planFor({ event: event({ kind: 'approval' }) })
  assert.equal(silent.sound, undefined)
  assert.notEqual(loud.sound, undefined)
  assert.equal(firstAudible([silent, loud]), 1)
  assert.equal(firstAudible([silent]), -1)
  assert.equal(firstAudible([]), -1)
})

test('the speech log remembers, forgets and prunes', () => {
  const log = createSpeechLog()
  assert.equal(log.size(), 0)
  log.note('a', 10)
  log.note('b', 20)
  assert.equal(log.lastAt('a'), 10)
  assert.equal(log.lastAt('missing'), undefined)
  assert.equal(log.forget('a'), true)
  assert.equal(log.forget('a'), false)
  log.note('a', 30)
  log.prune(['b'])
  assert.equal(log.size(), 1)
  assert.equal(log.lastAt('a'), undefined)
  assert.equal(log.lastAt('b'), 20)
})

test('the minimum gap is measured against a clock, never a timer', () => {
  assert.equal(gapElapsed(undefined, 1000, 1500), true, 'the first sound is never gapped')
  assert.equal(gapElapsed(1000, 2000, 1500), false)
  assert.equal(gapElapsed(1000, 2500, 1500), true)
  // A gap of zero is no limit, which is what the shipped value means.
  assert.equal(gapElapsed(1000, 1000, 0), true)
})

test('a plan describes itself in the words the card shows', () => {
  /** The translator, replaced by the key so the assertion is about which line was chosen. */
  const says = (key) => key
  const played = describePlan(planFor(), says)
  assert.match(played, /bell/u)
  assert.match(played, /100%/u)

  assert.match(describePlan(planFor({ settings: resolveSettings({ soundScope: 'off' }) }), says), /global-mute/u)
  const silentCard = planFor({
    settings: resolveSettings({ states: { done: { sound: false } } }),
    event: event({ kind: 'done' }),
  })
  assert.match(describePlan(silentCard, says), /no-channel/u)
})
