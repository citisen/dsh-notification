/**
 * Unit tests for the engine: what one state change actually does.
 *
 * This is the file that makes the plugin's behaviour checkable rather than
 * audible. Every rule a user would describe as a sentence — "it stayed quiet
 * because I was looking at that session", "it did not chime twice", "it refused to
 * claim a notification it could not show" — is asserted here as the situation,
 * not as the field.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BANNER_BODY_LIMIT,
  allBannered,
  buildBanner,
  createSpeechLog,
  describePlan,
  firstAudible,
  gapElapsed,
  planEvent,
} from '../src/engine.js'
import { GLOBAL_DEFAULTS, STATE_DEFAULTS, resolveSettings } from '../src/settings.js'

/** A granted permission state. */
const GRANTED = { supported: true, permission: 'granted', canAsk: false }
/** A refused permission state. */
const DENIED = { supported: true, permission: 'denied', canAsk: false }
/** A state where the window is behind everything. */
const HIDDEN = { visible: false, focused: false }
/** A state where the user is looking at this window. */
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
 *
 * The banner channel is turned **on** here, because these tests are about what the engine does
 * when it is live, and the channel ships switched off while it cannot work. Its shipped state
 * has its own test — and the switch being a parameter rather than a module constant read inside
 * the engine is exactly what makes both states reachable from a test.
 *
 * @param overrides - `{ event, settings, permission, visibility, now, lastSpoke, counts,
 *   notificationsEnabled }`.
 * @returns the plan.
 */
function planFor(overrides = {}) {
  return planEvent({
    event: overrides.event ?? event(),
    settings: overrides.settings ?? resolveSettings(undefined),
    counts: overrides.counts ?? { question: 1 },
    stateLabel: overrides.stateLabel ?? 'Waiting for an answer',
    permission: overrides.permission ?? GRANTED,
    visibility: overrides.visibility ?? HIDDEN,
    now: overrides.now ?? 100_000,
    lastSpoke: overrides.lastSpoke,
    notificationsEnabled: overrides.notificationsEnabled ?? true,
  })
}

test('with the banner channel switched off, no plan ever carries a banner', () => {
  // The shipped configuration, and the assertion that the hard-coded switch actually switches
  // something off — without it the channel would be "disabled" in a comment only.
  //
  // Every card is forced *on*, because the point is what the engine does with the switch rather
  // than which cards happen to ship enabled: `running` ships disabled, so a naive version of this
  // test would have passed for the wrong reason on exactly that state.
  const forced = resolveSettings({
    states: Object.fromEntries(
      ['question', 'approval', 'plan', 'failed', 'done', 'running'].map((kind) => [kind, { enabled: true }]),
    ),
  })
  for (const kind of ['question', 'approval', 'plan', 'failed', 'done', 'running']) {
    const plan = planFor({ event: event({ kind }), settings: forced, notificationsEnabled: false })
    assert.equal(plan.banner, undefined, `${kind} must plan no banner while the channel is off`)

    // The bell is untouched by the banner switch — and the expectation of a sound is derived from
    // the card rather than asserted for every kind, because a shipped card may also have its own
    // bell switched off (`running` does), and a hardcoded list would report that as a defect.
    const rings = forced.states[kind].sound === true && forced.soundScope !== 'off'
    assert.equal(
      plan.sound !== undefined,
      rings,
      `${kind} ${rings ? 'must still ring' : 'has its own bell off, so it must stay silent'}`,
    )
  }
})

test('with the banner channel switched off, a card that only wanted a banner is switched off too', () => {
  // Not "admitted and then silent", which would report the state as on and do nothing about it.
  const onlyBanner = resolveSettings({
    states: { done: { sound: false, notification: true, enabled: true } },
  })
  const plan = planFor({ event: event({ kind: 'done' }), settings: onlyBanner, notificationsEnabled: false })
  assert.deepEqual({ admit: plan.admit, reason: plan.reason }, { admit: false, reason: 'no-channel' })
  // The same card admits normally the moment the channel is back.
  assert.equal(planFor({ event: event({ kind: 'done' }), settings: onlyBanner }).admit, true)
})

test('a shipped card with a granted permission produces both channels', () => {
  const plan = planFor()
  assert.equal(plan.admit, true)
  assert.equal(plan.reason, 'allowed')
  assert.equal(plan.sound.kind, 'question')
  assert.equal(plan.sound.voice, STATE_DEFAULTS.question.voice)
  // Derived rather than hardcoded: the two levels multiply, and both ship at full, so a literal
  // here would be a second opinion about a default the settings module already states.
  assert.ok(
    Math.abs(plan.sound.gain - STATE_DEFAULTS.question.volume * GLOBAL_DEFAULTS.masterVolume) < 1e-9,
  )
  assert.equal(plan.banner.title, 'Deploy is asking')
  assert.equal(plan.banner.body, 'Which file?')
  assert.equal(plan.banner.tag, 'question:a')
  assert.deepEqual(plan.banner.data.sessionId, 'a')
})

test('the master switch silences both channels with a reason the row can print', () => {
  const plan = planFor({ settings: resolveSettings({ enabled: false }) })
  assert.deepEqual({ admit: plan.admit, reason: plan.reason }, { admit: false, reason: 'master-off' })
  assert.equal(plan.sound, undefined)
  assert.equal(plan.banner, undefined)
})

test("a card's own switch silences that card alone", () => {
  const settings = resolveSettings({ states: { done: { enabled: false } } })
  const plan = planFor({ event: event({ kind: 'done' }), settings })
  assert.equal(plan.reason, 'card-off')
  // And a different card is untouched by it.
  assert.equal(planFor({ settings }).admit, true)
})

test('a card with both channels off is off, not redirected to the other channel', () => {
  const settings = resolveSettings({ states: { done: { sound: false, notification: false } } })
  const plan = planFor({ event: event({ kind: 'done' }), settings })
  assert.equal(plan.reason, 'no-channel')
  assert.equal(plan.sound, undefined)
  assert.equal(plan.banner, undefined)
})

test('a sound-only card still raises no banner, and a banner-only card still makes no sound', () => {
  const soundOnly = resolveSettings({ states: { done: { notification: false, sound: true } } })
  const quietPlan = planFor({ event: event({ kind: 'done' }), settings: soundOnly })
  assert.notEqual(quietPlan.sound, undefined)
  assert.equal(quietPlan.banner, undefined)

  const bannerOnly = resolveSettings({ states: { done: { sound: false, notification: true } } })
  const loudPlan = planFor({ event: event({ kind: 'done' }), settings: bannerOnly })
  assert.equal(loudPlan.sound, undefined)
  assert.notEqual(loudPlan.banner, undefined)
})

test('the bell is gated on the window, and the banner is not', () => {
  // Looking at this window with `background` (the shipped scope): no chime, and a
  // banner is still worth showing if the session is not the one on screen.
  const plan = planFor({ visibility: WATCHING, event: event({ isMain: false }) })
  assert.equal(plan.sound, undefined)
  assert.notEqual(plan.banner, undefined)

  const always = planFor({ settings: resolveSettings({ soundScope: 'always' }), visibility: WATCHING })
  assert.notEqual(always.sound, undefined)
})

test('the plugin says nothing about the session the user is reading', () => {
  const plan = planFor({ event: event({ isMain: true }), visibility: WATCHING })
  assert.equal(plan.reason, 'focused-session')
  assert.equal(plan.sound, undefined)
  assert.equal(plan.banner, undefined)

  // A main-view session while the window is in the background is still news: the
  // user is elsewhere and the interface is not the notification.
  const background = planFor({ event: event({ isMain: true }), visibility: HIDDEN })
  assert.equal(background.admit, true)
})

test('a build that cannot see the window does not claim the session is focused', () => {
  // No visibility at all: the focused-session rule must not fire, because the fact
  // it is about does not exist. Claiming it would mute the plugin entirely.
  const plan = planEvent({
    event: event({ isMain: true }),
    settings: resolveSettings(undefined),
    permission: GRANTED,
    now: 1,
  })
  assert.equal(plan.admit, true)
})

test('a rate-limited repeat is refused with its own reason', () => {
  const settings = resolveSettings({ repeatMs: 5000 })
  const log = createSpeechLog()
  log.note('a', 99_000)
  const plan = planFor({ settings, lastSpoke: log, now: 100_000 })
  assert.deepEqual({ admit: plan.admit, reason: plan.reason }, { admit: false, reason: 'repeat' })
  // After the window it is allowed again.
  assert.equal(planFor({ settings, lastSpoke: log, now: 104_000 }).admit, true)
  // And the shipped default does not rate-limit at all.
  assert.equal(planFor({ lastSpoke: log, now: 99_001 }).admit, true)
})

test('a banner is planned unless the platform has no notification API at all', () => {
  // The correction this test records: an earlier version treated a `denied` permission as a
  // reason not to plan a banner. In the desktop application the permission reads `denied`
  // while the constructor works — measured — so that reasoning withheld banners the
  // platform would have shown, silently, which is the worst available outcome. Planning now
  // asks only whether the API exists.
  for (const permission of ['denied', 'default', 'granted']) {
    const planned = planFor({ permission: { supported: true, permission, canAsk: false } })
    assert.notEqual(planned.banner, undefined, `a ${permission} page must still get a banner planned`)
    assert.equal(planned.suppressed, undefined)
  }

  // The one state that is genuinely not plannable: no notification API in the environment.
  const unsupported = planFor({ permission: { supported: false, permission: 'unsupported' } })
  assert.equal(unsupported.banner, undefined)
  assert.equal(unsupported.suppressed, 'unsupported')

  // The bell is unaffected by any of it: the two channels do not share a permission.
  assert.notEqual(planFor({ permission: DENIED }).sound, undefined)

  // A user who turned the banner channel off is not "suppressed" — they said no.
  const off = planFor({ settings: resolveSettings({ desktopNotifications: false }) })
  assert.equal(off.banner, undefined)
  assert.equal(off.suppressed, undefined)
})

test('a gain of zero is not planned as a sound', () => {
  const settings = resolveSettings({ masterVolume: 0 })
  const plan = planFor({ settings })
  assert.equal(plan.admit, true)
  assert.equal(plan.sound, undefined, 'a silent gain is not a sound to play')
  assert.notEqual(plan.banner, undefined)
})

test('a banner renders the session, the question, the state, the count and the time', () => {
  const state = { title: '{count} waiting · {title}', body: '{state} at {time}: {summary}' }
  const banner = buildBanner(event(), state, {
    counts: { question: 3 },
    stateLabel: 'Waiting for an answer',
    now: new Date(2026, 0, 2, 9, 5, 0).getTime(),
  })
  assert.equal(banner.title, '3 waiting · Deploy')
  assert.equal(banner.body, 'Waiting for an answer at 09:05: Which file?')
  assert.deepEqual(banner.unknown, [])
})

test('a banner reports a placeholder nobody knows instead of hiding it', () => {
  const banner = buildBanner(event(), { title: '{titel}', body: 'ok' }, { counts: {}, now: 0 })
  assert.equal(banner.title, '{titel}')
  assert.deepEqual(banner.unknown, ['titel'])
})

test('a banner with an empty heading still has one, because a banner with none is not shown', () => {
  const banner = buildBanner(event(), { title: '', body: 'b' }, { counts: {}, now: 0 })
  assert.equal(banner.title, 'Session notification')
})

test('a banner body is fitted rather than cut by whatever the platform does', () => {
  const long = 'x'.repeat(500)
  const banner = buildBanner(event({ summary: long }), { title: 't', body: '{summary}' }, { counts: {}, now: 0 })
  assert.ok(banner.body.length <= BANNER_BODY_LIMIT)
  assert.ok(banner.body.endsWith('…'))
})

test('a banner for a state with no summary is still a usable banner', () => {
  const banner = buildBanner(
    event({ kind: 'done', summary: undefined }),
    { title: '{title} finished', body: 'The turn is complete.' },
    { counts: {}, now: 0 },
  )
  assert.equal(banner.title, 'Deploy finished')
  assert.equal(banner.body, 'The turn is complete.')
})

test('one sound per burst is the first plan that has a sound, not the first plan', () => {
  // The bug this pins: taking the first event and finding it silent would suppress
  // the whole burst, because the silent card comes first in the urgency order.
  const silent = planFor({ settings: resolveSettings({ states: { question: { sound: false } } }) })
  const loud = planFor({ event: event({ kind: 'approval' }) })
  assert.equal(silent.sound, undefined)
  assert.notEqual(loud.sound, undefined)
  assert.equal(firstAudible([silent, loud]), 1)
  assert.equal(firstAudible([silent]), -1)
  assert.equal(firstAudible([]), -1)
})

test('every admitted banner is raised, because two waiting sessions are two facts', () => {
  const one = planFor()
  const two = planFor({ event: event({ kind: 'approval', sessionId: 'b' }) })
  const silent = planFor({ settings: resolveSettings({ states: { done: { notification: false } } }), event: event({ kind: 'done' }) })
  assert.deepEqual(allBannered([one, two, silent]), [0, 1])
  assert.deepEqual(allBannered([]), [])
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
  assert.equal(gapElapsed(1000, 2501, 1500), true)
  // A gap of zero means no limit, which is what the shipped value says.
  assert.equal(gapElapsed(1000, 1000, 0), true)
})

test('a plan describes itself in the words the card shows', () => {
  const says = (key) => key
  const played = describePlan(planFor(), says)
  assert.match(played, /Deploy is asking/u)
  assert.match(played, /bell/u)

  const refused = describePlan(planFor({ settings: resolveSettings({ enabled: false }) }), says)
  assert.match(refused, /master-off/u)

  const silent = describePlan(
    planFor({ settings: resolveSettings({ states: { done: { sound: false, notification: false } } }), event: event({ kind: 'done' }) }),
    says,
  )
  assert.match(silent, /no-channel/u)
})
