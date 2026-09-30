/**
 * States: what every session is doing, and which changes are worth a sound.
 *
 * This module is a pair of pure functions and the vocabulary between them, and
 * nothing here touches the DOM, the clock, or the audio graph. The plugin's
 * whole notion of "something happened" is {@link diffStatus}, which takes the
 * two snapshots it is given and returns the events between them — so a
 * regression is a failing assertion rather than a chime that did not happen in a
 * room nobody was in.
 *
 * ## Why edge-triggered
 *
 * The interface publishes *levels*: a session is running, or a session has a
 * pending question. A notification is an *edge*: the moment a session entered
 * that state. Trusting the level is the classic version of this bug — a store
 * notification arriving for an unrelated reason re-reads "this session is
 * waiting" and chimes again. The previous plugin in this family shipped that
 * mistake once already. Every event here therefore exists only when the previous
 * snapshot said something different, and the first snapshot after a page load is
 * a *baseline* rather than an event: what is already on screen when the plugin
 * starts is known, not news.
 *
 * @module dsh-notification/states
 */

/**
 * The states a card can be written for, most urgent first.
 *
 * `question`, `approval` and `plan` are three kinds of "a human must act", kept
 * apart because they want different sounds — a plan review is a reading task, a
 * permission request is a decision, and an ordinary question is an answer. They
 * are also kept apart from `running`, which is the one state a session may be in
 * without anyone needing to be told.
 */
export const STATE_KINDS = ['question', 'approval', 'plan', 'failed', 'done', 'running']

/**
 * The state of a session that is present and doing nothing.
 *
 * It is not a card — nobody wants a sound for "this session is idle" — but it
 * has to be a *state*, and that is a correction this module needed. With idle
 * sessions simply absent from an observation, a session that went from idle to
 * running was indistinguishable from a session the plugin had never seen, and
 * the "a new session is not news" rule then suppressed the event. A conversation
 * sitting open and then starting a turn is the most ordinary thing that happens
 * in this interface, and a version that could not see it would have no
 * notifications at all.
 */
const IDLE = 'idle'

/** Every state an observation may hold: {@link IDLE} and the cards alike. */
export const OBSERVED_KINDS = [IDLE, ...STATE_KINDS]

/**
 * The kinds that mean "this cannot move until you do something".
 *
 * The tabbed plugin this replaces had two of them and called the group
 * "blocked". Asserting on the group rather than on the individual names is what
 * keeps a future fourth kind from silently escaping an "is anything urgent"
 * check — and it is what a future "do not disturb unless it is urgent" setting
 * would read.
 */
export const BLOCKING_KINDS = ['question', 'approval', 'plan']

/**
 * Records which sessions have hit an error since the plugin started watching.
 *
 * ## Why a failure needs its own bookkeeping
 *
 * Everything else in this module is derived from `uiSession.sessionStatus`, which
 * publishes levels. A failure is not one of those levels: the session-level
 * snapshot a plugin can read without retaining a session carries no turn outcome
 * at all, and the status entry's own `running` bit simply goes back to false,
 * which is indistinguishable from a turn that finished cleanly.
 *
 * What the interface *does* publish is `api-session/error` — a forwarded remote
 * event carrying `(sessionId, message)` — and the session controller relays it
 * into its own `lastAgentError`. So the failure channel is an *event*, and a
 * state machine built on levels has to remember it. This map is that memory, and
 * it is deliberately small: an entry lives until the session moves again.
 *
 * Three honest limits, so the interface can describe the feature accurately
 * rather than overpromising:
 *
 * - The event carries no turn position, so this says "this session's agent hit an
 *   error", not "this turn failed". For the turn-scoped answer a plugin would have
 *   to retain the session and read the durable `turn/end` reason — a much larger
 *   amount of machinery for a distinction a notification cannot express anyway.
 * - The relay is a best-effort forwarded event and is not replayed across a
 *   reconnect, so an error raised while the window was closed is not seen.
 * - `lastAgentError` is cleared by the session's own next prompt, so this forgets
 *   as soon as the session moves — which is the behaviour a user wants.
 */
export function createFailureLog() {
  const entries = new Map()
  return {
    /**
     * Note an error for a session.
     * @param sessionId - the session.
     * @param message - the error text the event carried, if any.
     * @param now - the time, from the caller's clock.
     * @returns {void}
     */
    record(sessionId, message, now) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      entries.set(sessionId, { at: typeof now === 'number' ? now : 0, message: typeof message === 'string' ? message : '' })
    },

    /**
     * Forget a session's error, because it moved.
     * @param sessionId - the session.
     * @returns whether anything was forgotten.
     */
    clear(sessionId) {
      return entries.delete(sessionId)
    },

    /** @param sessionId - the session. @returns its recorded error, or undefined. */
    get(sessionId) {
      return entries.get(sessionId)
    },

    /** @returns whether a session is currently marked as failed. */
    has(sessionId) {
      return entries.has(sessionId)
    },

    /** @returns the session ids currently marked, newest first. */
    ids() {
      return [...entries.entries()].sort(([, left], [, right]) => right.at - left.at).map(([id]) => id)
    },

    /** @returns how many sessions are marked. */
    size() {
      return entries.size
    },

    /** Drop ids that are no longer in a list of live sessions. @param live - the ids. */
    retainOnly(live) {
      const kept = new Set(live)
      for (const id of [...entries.keys()]) {
        if (!kept.has(id)) entries.delete(id)
      }
    },
  }
}

/**
 * The pending-interaction kinds the session status publishes, against the state
 * each one puts its session in.
 *
 * The wire kinds and the state names are deliberately not the same strings. The
 * wire says what the *agent* sent (`question`, `approval`, `plan-review`); the
 * state says what the *user* is being asked to do. Keeping the mapping in one
 * table means a kind this build has never seen is a reported miss rather than a
 * silent "no notification".
 */
const PENDING_KINDS = {
  question: 'question',
  approval: 'approval',
  'plan-review': 'plan',
  plan: 'plan',
}

/**
 * The state a session status entry puts its session in, or undefined for a
 * session that is doing nothing worth telling anyone about.
 *
 * The precedence is the whole point, and it is one line: a session that is
 * running *and* waiting for an answer is **waiting**, because the running part
 * is not the part that needs the user. A pending interaction that arrived with
 * an unknown kind still blocks — it is a person being asked for something, and
 * a build that ignored it would be quiet exactly when it mattered most — so an
 * unknown kind falls back to `question` rather than to silence.
 *
 * @param entry - one value from the session-status map.
 * @returns a state kind, or undefined.
 */
export function stateOf(entry) {
  if (entry === null || entry === undefined) return undefined
  const interaction = entry.pendingInteraction
  if (interaction !== null && interaction !== undefined) {
    const kind = typeof interaction === 'string' ? interaction : interaction.kind
    return PENDING_KINDS[kind] ?? 'question'
  }
  if (entry.running === true) return 'running'
  // `completionUnread` is the controller's own "a turn ended and you have not
  // looked at it" flag. It is the reason this plugin does not have to guess a
  // completion window: the interface already knows, and clears it when the
  // session is looked at.
  //
  // One limit is worth naming, because it is why {@link diffStatus} does not read
  // completion from this flag alone: the controller **suppresses** it for the
  // session the main view is showing, and clears it the moment a session becomes
  // that one. So the flag can only ever report "finished" for the sessions the
  // user is *not* looking at — which excludes the single most ordinary way this
  // plugin is used: one conversation, open in the main view, a long turn, the user
  // in another application. `diffStatus` therefore reads the end of a turn from the
  // edge out of `running` instead, and what is left of this flag is the sessions the
  // interface has decided the user has not seen.
  if (entry.completionUnread === true) return 'done'
  return undefined
}

/**
 * The title to show for a session.
 *
 * The list row carries two candidates and they are not interchangeable. `title`
 * is the durable one and is present only once the session-title projection holds
 * a non-empty string; `displayTitle` is always present but is *synthesized* —
 * the projection, else the workspace directory's name, else the raw id. Reading
 * the pair in that order is the difference between a notification that says
 * "Refactor the parser" and one that says "dsh-notification".
 *
 * The three older spellings are kept as a fallback because this plugin is
 * version-tolerant by design: a release that renames the field should cost the
 * plugin nothing. Falling back to the id's tail is deliberate — "Session 4f2a"
 * is a worse label than a real title and a much better one than "undefined"
 * inside a notification.
 *
 * @param row - the list row for the session, if any.
 * @param sessionId - the session id.
 * @returns the label.
 */
export function sessionTitle(row, sessionId) {
  for (const key of ['title', 'displayTitle', 'label', 'name']) {
    const value = row?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  const tail = String(sessionId ?? '').replace(/^session-/u, '')
  return tail === '' ? 'Session' : `Session ${tail.slice(0, 8)}`
}

/**
 * The first line of whatever text the pending interaction carries.
 *
 * The two publishers of a pending interaction carry their text differently, and
 * neither spelling is obvious: an approval has a `toolName` and a `reason`, while
 * a question or a plan review has a `questions` array of
 * `{ id, question, detail?, header?, options? }`. The question's own text is the
 * most useful thing a notification can say, so this asks for the shapes that
 * exist rather than for one of them.
 *
 * The interaction is only ever *read*: it is a class instance whose methods
 * settle the request, and copying or serializing it would both lose those methods
 * and risk invoking a getter that reports state the caller has no business
 * touching.
 *
 * @param entry - one value from the session-status map.
 * @returns a single line, or undefined when the interaction carries no text.
 */
export function interactionSummary(entry) {
  const interaction = entry?.pendingInteraction
  if (interaction === null || interaction === undefined || typeof interaction === 'string') {
    return undefined
  }

  /** @param value - a candidate string. @returns it collapsed, or undefined. */
  const single = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim().replace(/\s+/gu, ' ').slice(0, 300) : undefined

  // A question or plan review: the first question's text, and its detail when the
  // question itself is a heading rather than a sentence.
  const questions = interaction.questions
  if (Array.isArray(questions) && questions.length > 0) {
    const first = questions[0]
    const text = single(first?.question) ?? single(first?.detail)
    if (text !== undefined) {
      return questions.length > 1 ? `${text} (+${String(questions.length - 1)} more)` : text
    }
  }

  // An approval: what the agent wants to do, and why.
  return (
    single(interaction.displayReason) ??
    single(interaction.reason) ??
    single(interaction.toolName) ??
    single(interaction.text) ??
    single(interaction.title) ??
    single(interaction.prompt) ??
    single(interaction.message)
  )
}

/**
 * Every session's state, from the two snapshots the interface publishes.
 *
 * The status map is the source of truth for *what* a session is doing, and the
 * list is consulted only for the things the status map does not carry: whether a
 * session is still there, whether it is blank, and what to call it. A session
 * present in the list but absent from the status map is idle, which is the
 * ordinary state of most sessions most of the time.
 *
 * @param status - the `sessionStatus` snapshot, `Map<id, entry>`.
 * @param list - the `sessions.list` snapshot, `{ ids, byId }`.
 * @param failures - a failure log from {@link createFailureLog}, or nothing.
 * @returns `{ byId, order }`: an entry per non-blank session — including the idle
 *   ones, which is what makes a later change into `running` visible — and the ids
 *   in the order the list presented them.
 */
export function observe(status, list, failures) {
  const byId = new Map()
  const order = []
  const ids = Array.isArray(list?.ids) ? list.ids : []
  for (const id of ids) {
    const row = list?.byId?.[id]
    // A blank session — created and never used — is not information, and it is
    // the one case left out entirely: it has no state, so it can never change
    // into one, and alarming about it would mean a sound every time someone
    // opens a new conversation.
    if (row !== undefined && row.blank === true) continue
    const entry = status?.get?.(id) ?? status?.[id]
    let kind = stateOf(entry) ?? IDLE
    // A failure outranks everything except a *new* demand on the user. The
    // reasoning: a recorded error is the outcome of the last turn, so it is the
    // most recent thing that is true about the session — but a question that
    // arrived afterwards is a live ask, and the user's attention belongs there.
    // The other two live states do lose to it, because `running` after an error
    // is a retry the user did not ask to be told about, and a `done` that never
    // got its own flag is exactly the case the error explains.
    if (failures?.has?.(id) === true) {
      const interaction = entry?.pendingInteraction
      if (interaction === null || interaction === undefined) kind = 'failed'
    }
    byId.set(id, {
      kind,
      title: sessionTitle(row, id),
      summary: interactionSummary(entry),
      failure: failures?.get?.(id),
      // The facts a rules layer needs, kept as facts rather than as a
      // pre-computed decision: whether to *speak* about a session is policy, and
      // policy belongs where the settings are.
      isMain: (row?.retainedBy?.mainView ?? 0) > 0,
    })
    order.push(id)
  }
  return { byId, order }
}

/**
 * Count how many sessions are in each state a card can be written for.
 *
 * {@link IDLE} is left out on purpose: the count exists so a card can say how
 * many sessions are in *its* state, and "four sessions are open" is not a state
 * anyone needs to be told about.
 *
 * @param observed - the result of {@link observe}.
 * @returns a record from card state kind to count.
 */
export function tally(observed) {
  const counts = {}
  for (const kind of STATE_KINDS) counts[kind] = 0
  for (const entry of observed?.byId?.values?.() ?? []) {
    if (!(entry.kind in counts)) continue
    counts[entry.kind] += 1
  }
  return counts
}

/**
 * The events between two observations.
 *
 * Each event is one edge, and it carries the facts a notification needs rather
 * than a rendered string: rendering belongs to the layer that knows the locale
 * and the user's template, and a state machine that produced sentences could not
 * be tested against a table of transitions.
 *
 * `running` is deliberately reported as an event even though the shipped default
 * says nothing about it. A turn *starting* is not worth a chime, which is why
 * its card ships disabled — but it is an edge like any other, and a plugin that
 * could not speak about it if asked would be deciding policy in the wrong place.
 *
 * `done` has two sources and they produce one event shape. The interface's own
 * unread flag (`completionUnread`, via {@link stateOf}) covers the sessions the
 * user is not looking at; the edge *out of* `running` covers everything else,
 * including the session on screen — see the note in the body, which is the whole
 * reason that edge exists.
 *
 * @param previous - the previous observation, or undefined before the first.
 * @param next - the current observation.
 * @returns events, most urgent first: `{ kind, sessionId, title, summary, isMain, previous }`.
 */
export function diffStatus(previous, next) {
  const events = []
  for (const id of next?.order ?? []) {
    const entry = next.byId.get(id)
    const before = previous?.byId?.get(id)
    // The first observation is a baseline, never a set of events: what is
    // already on screen when the plugin starts is known, not news.
    if (previous === undefined) continue
    // A session the plugin has never seen is the same situation one level down.
    // A conversation created while the plugin was running is new to the plugin,
    // and its first state is not a change *into* that state. `undefined` here
    // means genuinely unseen, because an idle session is recorded as
    // {@link IDLE} rather than left out.
    if (before === undefined) continue
    if (before.kind === entry.kind) continue
    // A session going quiet is normally a state change without an event: there is no
    // card for "nothing is happening", so there is nothing to play and nothing to
    // show. The one exception is the edge *out of* `running`, which is a turn
    // ending — and it has to be read from the edge rather than from
    // `completionUnread`, because the controller suppresses that flag for the
    // session the main view is showing (see {@link stateOf}). One conversation,
    // open in the main view, is the ordinary way this plugin is used, so a
    // completion the plugin could only see for *other* sessions would be no
    // completion at all. What matters here is the difference between the two facts:
    // the flag is the interface's bookkeeping about what the *user* has seen, and
    // the edge is what *this session* did.
    //
    // This is the weaker of the two facts, and naming what it cannot say is the
    // honest way to keep it: a turn that errored also ends, and the level a plugin
    // can read carries no outcome, so a failure that arrives after the running flag
    // falls is briefly indistinguishable from a clean finish. The failure log
    // refines it in the case that matters most — the error event is usually
    // forwarded with the turn's own end — and nothing else about the decision
    // changes: `admit` is asked afterwards, and all it asks is whether this state's
    // card is switched on.
    if (entry.kind === IDLE) {
      if (before.kind === 'running') {
        events.push({
          kind: 'done',
          sessionId: id,
          title: entry.title,
          summary: entry.summary,
          isMain: entry.isMain,
          previous: before.kind,
        })
      }
      continue
    }
    events.push({
      kind: entry.kind,
      sessionId: id,
      title: entry.title,
      summary: entry.summary,
      isMain: entry.isMain,
      previous: before.kind,
    })
  }
  // Most urgent first, so a burst that is thinned to one sound keeps the sound
  // that mattered. The order is the roster's own, which is the one place the
  // precedence is written down.
  return events.sort((left, right) => STATE_KINDS.indexOf(left.kind) - STATE_KINDS.indexOf(right.kind))
}

/**
 * The event a state's own melody should be played for, out of a burst.
 *
 * Agents ask several questions in a row, and three chimes in three seconds reads
 * as a malfunction. The rule the previous plugin shipped — one sound per burst —
 * is kept, and so is the reason it is expressed over the *event list* rather
 * than over the clock: a caller that has already decided which events are
 * eligible can thin them here, where the decision is testable.
 *
 * @param events - events from {@link diffStatus}, already filtered by policy.
 * @returns the first event, or undefined.
 */
export function firstOf(events) {
  return Array.isArray(events) && events.length > 0 ? events[0] : undefined
}
