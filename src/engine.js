/**
 * The engine: what one session-status change should actually do.
 *
 * Everything upstream of this file produces facts and everything downstream
 * performs effects, and this is the one place where a fact becomes a decision. It
 * is a pure function of its inputs — the event and the resolved settings, and
 * nothing else — which is what lets the entire behaviour of the plugin be asserted
 * as a table instead of observed in a room.
 *
 * ## Why the decision is separated from the effect
 *
 * The previous plugin in this family made its sound decision inside its audio
 * callback and its title decision inside a DOM write. Both worked, and neither
 * could be tested: the only way to know what it had decided was to have been in the
 * room when it decided it. A plan is a value, so it can be printed, compared, and
 * asserted on — "this card is off, so this event never reaches the speakers" is a
 * check rather than a claim.
 *
 * ## There is nothing in here but the card
 *
 * No clock, no window, no memory of what spoke last — and that is the current shape of the policy
 * rather than an accident of it. Every rule that used to live here and answer *whether* — the sound
 * scope, the focused session, the minimum gap between sounds, the repeat interval — was a way of
 * deciding that a real state change was not worth reporting, and every one of them could silence the
 * notification this plugin exists for. The card's own switch is the only answer the plugin can give
 * honestly; the reasoning is written out in `settings.js`. What is left to compute here is the gain,
 * which is arithmetic, and the burst rule, which is about one *moment* rather than about time passing.
 *
 * @module dsh-notification/engine
 */

import { admit, stateGain, stateVoice } from './settings.js'

/**
 * What one change should do.
 *
 * @param input - the facts:
 *   - `event` — one event from the state machine.
 *   - `settings` — resolved settings.
 * @returns `{ admit, reason, sound }` — the plan. `sound` is undefined when the plan
 *   would make no noise, either because `admit` refused it or because a volume is at
 *   0; `reason` names which of the two it was.
 */
export function planEvent(input) {
  const { event, settings } = input
  const verdict = admit(event.kind, settings)

  if (verdict.allowed !== true) {
    return { admit: false, reason: verdict.reason, sound: undefined }
  }

  const state = settings.states[event.kind]
  const gain = stateGain(settings, event.kind)
  const voice = stateVoice(settings, event.kind)

  // A gain of zero is the one thing left that makes an admitted event silent, and it is not a rule: it
  // is the product of two volumes the user can see on the screen. It gets a reason of its own rather
  // than being folded into `allowed`, because the row prints that reason — "the volume is 0" is an
  // answer, and a line that looked as though it had played something would not be.
  const sound = gain > 0 ? { melody: state.melody, voice, gain, kind: event.kind } : undefined

  return {
    admit: true,
    reason: sound === undefined ? 'volume-zero' : 'allowed',
    sound,
  }
}

/**
 * Which of a burst's events should actually make a noise.
 *
 * One sound per burst, and a burst is what the interface published at one moment — not a clock and not
 * a rate limit. Two sessions reaching a state at the same instant are one thing happening to the user,
 * and three chimes in a row is what a malfunction sounds like. Two state changes a second apart are
 * two things, and each gets its own sound, because this plugin no longer decides that a real change
 * was not worth reporting — see the note in `settings.js` for what was removed and why.
 *
 * The events arrive already ordered most urgent first, so this takes the first one that *has* a
 * sound — walking past a state whose card is silent rather than letting that silence suppress the
 * burst, which is the bug a `find` on the first event alone would produce. The silence it walks past
 * can only be a switched-off card or a volume at 0; nothing else makes a plan inaudible any more.
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
 * What there is to say about a plan, for the card. Usually nothing.
 *
 * A preview that played needs no sentence: the sound *is* the answer, and a line under the button
 * reading "Audio: marimba @ 100%" only repeats back what the user just heard, in a vocabulary the rest
 * of the row does not use. What is worth a line is the case where pressing the button made no sound at
 * all, because that is the one the user cannot diagnose by listening — a volume at 0, or a card that is
 * switched off. The card's own name and its controls are already on screen, so the sentence does not
 * have to introduce them.
 *
 * The percentage `stateGain` computes is therefore no longer printed anywhere. It is still what the
 * sound plays at; it was only ever a figure nobody needed a number for.
 *
 * @param plan - a plan from {@link planEvent}.
 * @param t - the translator, for the reasons that need words.
 * @returns the line to print, or undefined when the plan played.
 */
export function describePlan(plan, t) {
  if (plan?.sound !== undefined) return undefined
  if (plan?.admit !== true) return `${t('notification.testResult.skipped')} (${String(plan?.reason ?? 'unknown')})`
  return plan.reason === 'volume-zero'
    ? t('notification.testResult.volumeZero')
    : t('notification.testResult.silent')
}
