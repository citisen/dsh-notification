/**
 * The engine: what one session-status change should actually do.
 *
 * Everything upstream of this file produces facts and everything downstream
 * performs effects, and this is the one place where a fact becomes a decision. It
 * is a pure function of its inputs — the event, the resolved settings, the clock,
 * the last time each session spoke — which is what lets the entire behaviour of
 * the plugin be asserted as a table instead of observed in a room.
 *
 * ## Why the decision is separated from the effect
 *
 * The previous plugin in this family made its sound decision inside its audio
 * callback and its title decision inside a DOM write. Both worked, and neither
 * could be tested: the only way to know whether a chime was suppressed while the
 * window had focus was to have the window focused. A plan is a value, so it can be
 * printed, compared, and asserted on — and `scripts/verify-client.mjs` drives this
 * function against a stub notifier and a stub player, which is why "the master
 * switch silences everything" is a check rather than a claim.
 *
 * @module dsh-notification/engine
 */

import { admit, soundAllowed, stateGain, stateVoice } from './settings.js'

/**
 * What one change should do.
 *
 * @param input - the facts:
 *   - `event` — one event from the state machine.
 *   - `settings` — resolved settings.
 *   - `counts` — how many sessions are in each state.
 *   - `visibility` — `{ visible, focused }`, or nothing when the document cannot say.
 *   - `now` — epoch milliseconds.
 *   - `lastSpoke` — the speech log, the caller's own memory of when each session last made a noise.
 * @returns `{ admit, reason, sound }` — the plan.
 */
export function planEvent(input) {
  const { event, settings, now } = input
  // The caller's own memory of when this session last made a noise, read once so
  // the rate limit and the plan cannot disagree about it. It has to reach `admit`
  // as an explicit field rather than as a sub-object spread: `admit` tests it for
  // being a number, and a missing key is what makes the rule inert.
  const lastSpokenAt = input.lastSpoke?.lastAt?.(event.sessionId)

  const verdict = admit(event.kind, settings, {
    isMain: event.isMain,
    // The focused-session rule is only meaningful when the interface can actually
    // say what the window is doing. A build that cannot must not silently claim
    // the session is focused — that would mute the plugin entirely — nor claim it
    // is not — that would chime about the session on screen. So the fact is derived
    // from the window *and* the session: both have to be true.
    skipFocusedSession:
      input.visibility !== undefined && input.visibility.focused === true && input.visibility.visible === true,
    now,
    lastSpokenAt,
  })

  if (verdict.allowed !== true) {
    return { admit: false, reason: verdict.reason, sound: undefined }
  }

  const state = settings.states[event.kind]
  const gain = stateGain(settings, event.kind)
  const voice = stateVoice(settings, event.kind)

  // The sound: `admit` has already refused a globally muted plugin and a card whose bell is off, so
  // what is left to decide is whether now is a moment the sound may be *heard*. A chime admitted while
  // the window was hidden and played while the user is reading the screen is exactly the case the
  // `background` scope exists to prevent, and the two moments can differ because a plan is made and
  // then performed.
  const mayBeAudible = soundAllowed(settings, input.visibility ?? {})
  const sound = mayBeAudible && gain > 0 ? { melody: state.melody, voice, gain, kind: event.kind } : undefined

  return {
    admit: true,
    reason: 'allowed',
    sound,
  }
}


/**
 * The engine's own bookkeeping: when each session last spoke.
 *
 * A rate limit that lives in the caller is a rate limit that survives a settings
 * change and a re-render, and that is the point — `repeatMs` is about the user's
 * attention, not about one component's lifetime. It is exposed as an object rather
 * than as a bare `Map` so the rule ("remember, and forget sessions that are gone")
 * is written once.
 *
 * @returns `{ note, lastAt, forget, prune, size }`.
 */
export function createSpeechLog() {
  const spoken = new Map()
  return {
    /**
     * Remember that a session spoke.
     * @param sessionId - the session.
     * @param now - the time, from the caller's clock.
     * @returns {void}
     */
    note(sessionId, now) {
      spoken.set(sessionId, now)
    },

    /** @param sessionId - the session. @returns when it last spoke, or undefined. */
    lastAt(sessionId) {
      return spoken.get(sessionId)
    },

    /** @param sessionId - the session. @returns whether anything was forgotten. */
    forget(sessionId) {
      return spoken.delete(sessionId)
    },

    /**
     * Drop sessions that are no longer present.
     *
     * Called when a session is removed, or a long-lived install would accumulate
     * one entry per session ever run.
     * @param live - the live session ids.
     * @returns {void}
     */
    prune(live) {
      const kept = new Set(live)
      for (const id of [...spoken.keys()]) {
        if (!kept.has(id)) spoken.delete(id)
      }
    },

    /** @returns how many sessions are remembered. */
    size() {
      return spoken.size
    },
  }
}

/**
 * The minimum gap between two sounds, as a decision over a clock.
 *
 * Deliberately a function of *time* rather than of timers: a background window
 * throttles `setTimeout` to the minute, so a gap scheduled with a timer fires late
 * or not at all, while a gap measured against `Date.now()` is exact whenever it is
 * asked. This is the same reasoning the previous plugin recorded, kept because it
 * was right.
 *
 * @param lastSoundAt - when the last sound played, or undefined.
 * @param now - the current time.
 * @param minGapMs - the configured gap.
 * @returns whether a sound may play now.
 */
export function gapElapsed(lastSoundAt, now, minGapMs) {
  if (typeof lastSoundAt !== 'number') return true
  const gap = typeof minGapMs === 'number' ? minGapMs : 0
  return now - lastSoundAt >= gap
}

/**
 * Which of a burst's events should actually make a noise.
 *
 * One sound per burst is the rule, and the reason is audible rather than
 * theoretical: agents ask several questions in a row, and three chimes in three
 * seconds reads as a malfunction. The events arrive already ordered most urgent
 * first, so this takes the first one that *has* a sound — walking past a state
 * whose card is silent rather than letting that silence suppress the burst, which
 * is the bug a `find` on the first event alone would produce.
 *
 * @param plans - the plans from {@link planEvent}, in event order.
 * @returns the index of the plan that should play, or -1.
 */
export function firstAudible(plans) {
  for (let index = 0; index < plans.length; index += 1) {
    if (plans[index]?.sound !== undefined) return index
  }
  return -1
}


/**
 * A one-line description of a plan, for the card and for the log.
 *
 * The row shows the same decision the engine makes, so a user who presses *Play* sees the outcome
 * rather than a promise: "Sound: marimba @ 56%" is an answer. The reason is printed with it when
 * nothing would happen, because the reasons need different actions from the user — a card switched off
 * is fixed on the card, and a global mute is fixed in the global settings.
 *
 * The percentage is `stateGain`'s, which is the product of the card's level and the master's. Printing
 * the product rather than either input is what makes the line answer "how loud will it actually be".
 *
 * @param plan - a plan from {@link planEvent}.
 * @param t - the translator, for the reasons that need words.
 * @returns the description.
 */
export function describePlan(plan, t) {
  if (plan?.admit !== true) return `${t('notification.testResult.skipped')} (${String(plan?.reason ?? 'unknown')})`
  if (plan.sound === undefined) return t('notification.testResult.silent')
  return `${t('notification.audio')}: ${plan.sound.voice} @ ${String(Math.round(plan.sound.gain * 100))}%`
}
