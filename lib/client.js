window.__ModuleLoader__.load({
	id: "@citisen/dsh-notification",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let _react = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		const React = _react;
		const defineStore = _deepseek_ai_dsh_client_store.defineStore;

// ─── src/states.js ───────────────────────────────────────────────────
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
const STATE_KINDS = ['question', 'approval', 'plan', 'failed', 'done', 'running']

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
const OBSERVED_KINDS = [IDLE, ...STATE_KINDS]

/**
 * The kinds that mean "this cannot move until you do something".
 *
 * The tabbed plugin this replaces had two of them and called the group
 * "blocked". Asserting on the group rather than on the individual names is what
 * keeps a future fourth kind from silently escaping an "is anything urgent"
 * check — and it is what a future "do not disturb unless it is urgent" setting
 * would read.
 */
const BLOCKING_KINDS = ['question', 'approval', 'plan']

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
function createFailureLog() {
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
function stateOf(entry) {
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
  // One limit worth naming, because it changes what the interface can honestly
  // promise: the controller suppresses this flag for the session the main view is
  // showing, and clears it the moment a session becomes that one. So "finished"
  // is reported for the sessions the user is *not* looking at — which is the case
  // a notification exists for, and also exactly the case a user testing the
  // feature by watching the session they just ran will not see.
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
function sessionTitle(row, sessionId) {
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
function interactionSummary(entry) {
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
function observe(status, list, failures) {
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
function tally(observed) {
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
 * @param previous - the previous observation, or undefined before the first.
 * @param next - the current observation.
 * @returns events, most urgent first: `{ kind, sessionId, title, summary, isMain, previous }`.
 */
function diffStatus(previous, next) {
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
    // A session going quiet is a state change without an event: there is no card
    // for "nothing is happening", so there is nothing to play and nothing to
    // show. It is still a change of state — the transition out of it is what
    // produces the `running` event.
    if (entry.kind === IDLE) continue
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
function firstOf(events) {
  return Array.isArray(events) && events.length > 0 ? events[0] : undefined
}

// ─── src/sound.js ────────────────────────────────────────────────────
/**
 * Sound: what a state rings, and how it is synthesized.
 *
 * This module is pure except for {@link createPlayer}, and that split is the
 * whole point. A notification sound is 0.3–2 seconds of audio, so the two things
 * worth getting right are *which notes, when* and *what timbre* — and both are
 * decisions, not DSP. {@link readMelody} turns text into notes, {@link schedule}
 * turns notes plus a voice into a list of absolute envelope points, and only
 * {@link createPlayer} touches `AudioContext`. Everything above that line runs
 * in Node with no browser and no clock, which is what makes a machine-generated
 * melody checkable: the analysis in `scripts/verify-client.mjs` calls the same
 * two functions the plugin calls and prints the notes and their timing.
 *
 * ## Why this syntax and not a music library
 *
 * The melody is written as notes and durations:
 *
 *     A5:200ms E6:200ms          two notes, each ringing for its own length
 *     G4 G4 G4 Eb4:680ms         four notes; the three without a length use the
 *                                shipped pacing, the last one rings 680ms
 *     A5:120ms -:80ms E6:240ms   a rest is a step that sounds nothing
 *
 * That grammar existed in the previous plugin in this family and survived a
 * version of being wrong in public, which is the strongest argument for keeping
 * it: note names and durations are not a new language, they are how music is
 * written, and both halves of a generation loop already know them. The
 * alternatives were measured rather than assumed. ABC notation and a MIDI-grade
 * library such as `abcjs` (5.9 MB unpacked) both render by *downloading sampled
 * instrument fonts from GitHub at play time* — a desktop notification that
 * needs the network is not a notification. `tone` (5.4 MB unpacked) declares
 * `standardized-audio-context`, which feature-detects and spawns worklets, and
 * a plugin bundle here is a single classic script that can only `require` the
 * shell's own module table; compiling a library that reaches for `new Worker`
 * and dynamic imports into it is a bet with a real chance of losing, in the one
 * code path that has to work when everything else is quiet.
 *
 * What this module adds over that inherited grammar is the half that was
 * missing: **timbre is a named preset**, not just four raw waveforms. See
 * {@link VOICES}.
 *
 * @module dsh-notification/sound
 */

// ─── notes ───────────────────────────────────────────────────────────────────

/**
 * Semitone offsets of the note names, with the two spellings music needs.
 *
 * `B` shares its offset with `Cb` and `E` with `Fb`, which is not a flourish:
 * a melody written in the key of F has Bb in it, and a reader that rejected the
 * spelling would report a correct line as a mistake.
 */
const NOTE_OFFSETS = {
  C: 0,
  'C#': 1,
  Db: 1,
  D: 2,
  'D#': 3,
  Eb: 3,
  E: 4,
  Fb: 4,
  'E#': 5,
  F: 5,
  'F#': 6,
  Gb: 6,
  G: 7,
  'G#': 8,
  Ab: 8,
  A: 9,
  'A#': 10,
  Bb: 10,
  B: 11,
  Cb: 11,
}

/**
 * A note name: a letter, an optional accidental, then an octave.
 *
 * Anchored at both ends so a token like `H5` or `A5x` fails rather than being
 * read as its first three characters — the failure a sloppy pattern produces is
 * a melody that plays the wrong notes with no diagnostic anywhere.
 */
const NOTE_NAME = /^([A-Ga-g])([#b]?)(-?\d+)$/

/** Equal temperament, so a name and a frequency are two spellings of one pitch. */
const A4_HZ = 440
/** The octave of {@link A4_HZ}; MIDI 69 is the same pitch. */
const A4_MIDI = 69

/**
 * Turn a note name into a frequency, or undefined.
 *
 * Equal temperament with A4 = 440 Hz, which is what every tuner and every
 * generated melody will assume. A name that is not a note is *not* an error
 * here — {@link readMelody} decides what an unreadable token means, and this
 * only answers the narrower question "is this a pitch".
 *
 * @param text - the token, e.g. `A5`, `C#4`, `Bb3`.
 * @returns the frequency in Hz, or undefined when the token is not a note name.
 */
function noteFrequency(text) {
  const match = NOTE_NAME.exec(text.trim())
  if (match === null) return undefined
  const [, letter, accidental, octave] = match
  const offset = NOTE_OFFSETS[`${letter.toUpperCase()}${accidental}`]
  if (offset === undefined) return undefined
  // MIDI is 12 semitones per octave with C-1 at 0, so a name maps to a number and
  // the frequency follows from the one reference pitch. Deriving it this way
  // rather than from a table means every octave is reachable, including the
  // negative ones a typo produces.
  const midi = (Number.parseInt(octave, 10) + 1) * 12 + offset
  return A4_HZ * 2 ** ((midi - A4_MIDI) / 12)
}

/** The longest and shortest a written length may be, in milliseconds. */
const LENGTH_MIN_MS = 1
const LENGTH_MAX_MS = 30_000

/**
 * Parse a `:length` suffix, or undefined when there is none.
 *
 * Durations accept `ms`, `s`, and `m`, and a bare number means seconds — the
 * same rule the rest of the plugin's durations follow, because a settings file
 * with two duration grammars in it is a settings file whose reader is wrong
 * half the time. A length outside {@link LENGTH_MIN_MS}..{@link LENGTH_MAX_MS}
 * is refused by returning undefined, which the caller turns into a diagnostic.
 *
 * @param text - the text after the colon.
 * @returns milliseconds, or undefined when it is absent or out of range.
 */
function parseLength(text) {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)?$/i.exec(trimmed)
  if (match === null) return undefined
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return undefined
  const unit = (match[2] ?? 's').toLowerCase()
  const ms = unit === 'ms' ? value : unit === 'm' ? value * 60_000 : value * 1000
  if (ms < LENGTH_MIN_MS || ms > LENGTH_MAX_MS) return undefined
  return Math.round(ms)
}

/**
 * How long a note rings when the melody does not say, in milliseconds.
 *
 * The previous plugin in this family shipped these two numbers, and a melody
 * written then still sounds the same through this reader — which matters more
 * than either number being well chosen.
 */
const DEFAULT_NOTE_MS = 130
/** How far apart two items start when the melody does not say, in milliseconds. */
const DEFAULT_STAGGER_MS = 90

/**
 * Read a melody.
 *
 * Total, and the failures are reported rather than thrown: a settings file with
 * a typo in it must not be able to leave the interface unable to tell the user
 * anything. Every token that is not `off` is either a note, a rest (`-`), or a
 * problem, and a problem leaves the rest of the melody intact.
 *
 * A written length is the *whole* item: the note rings for it and the next item
 * starts when it ends. An item that names none keeps the shipped pair — it rings
 * {@link DEFAULT_NOTE_MS} and the next starts {@link DEFAULT_STAGGER_MS} later —
 * so two bare notes overlap into one interval rather than reading as two knocks.
 * That asymmetry is deliberate and is the only way one grammar can express both
 * `A5 E6` (an interval) and `A5:200ms E6:200ms` (a rhythm).
 *
 * @param text - the melody text, or `off`.
 * @returns `{ silent, notes, problems }` — notes are `{ label, frequency, startMs, durationMs }`,
 *   or `frequency: undefined` for a rest, which still occupies its time.
 */
function readMelody(text) {
  const source = typeof text === 'string' ? text : ''
  const trimmed = source.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'off') {
    return { silent: true, notes: [], problems: [] }
  }

  const notes = []
  const problems = []
  let startMs = 0
  // Whitespace-separated, with commas accepted as separators too: a melody
  // copied out of a chat message arrives with either, and refusing one of them
  // would be a diagnostic about punctuation rather than about the music.
  for (const token of trimmed.split(/[\s,]+/)) {
    if (token === '') continue
    const colon = token.indexOf(':')
    const head = colon === -1 ? token : token.slice(0, colon)
    const tail = colon === -1 ? undefined : token.slice(colon + 1)

    let lengthMs
    if (tail !== undefined) {
      lengthMs = parseLength(tail)
      if (lengthMs === undefined) {
        problems.push({ token, message: `unreadable length '${tail}'` })
        continue
      }
    }

    if (head === '-') {
      notes.push({ label: 'rest', frequency: undefined, startMs, durationMs: lengthMs ?? DEFAULT_STAGGER_MS })
      startMs += lengthMs ?? DEFAULT_STAGGER_MS
      continue
    }

    let frequency = noteFrequency(head)
    let label = head
    if (frequency === undefined) {
      // A bare number is a frequency in Hz, which is the escape hatch for a
      // pitch with no name — and it is also how a melody generated from a
      // spectrum is written back out.
      const hz = Number.parseFloat(head)
      if (Number.isFinite(hz) && hz > 0 && hz < 30_000) {
        frequency = hz
        label = `${String(hz)}Hz`
      } else {
        problems.push({ token, message: `'${head}' is not a note name or a frequency` })
        continue
      }
    }

    notes.push({ label, frequency, startMs, durationMs: lengthMs ?? DEFAULT_NOTE_MS })
    startMs += lengthMs ?? DEFAULT_STAGGER_MS
  }

  return { silent: notes.every((note) => note.frequency === undefined), notes, problems }
}

/**
 * How long the melody lasts, in milliseconds — its last note's release included.
 * @param notes - notes from {@link readMelody}.
 * @returns the total, or 0 for an empty melody.
 */
function melodyLengthMs(notes) {
  let end = 0
  for (const note of notes ?? []) {
    end = Math.max(end, note.startMs + note.durationMs)
  }
  return end
}

// ─── voices ──────────────────────────────────────────────────────────────────

/**
 * The timbres a state may name.
 *
 * Each voice is a recipe rather than a waveform, because "what does it sound
 * like" is not answerable by `sine`/`square`: a bell and a marimba are both
 * struck and both bright, and the difference is the *partials* and how fast they
 * die. A recipe is five numbers and a shape, which keeps a voice something a
 * settings card can *choose* (a closed list, safe to pick from) while a melody
 * stays something written (open, and worth generating).
 *
 * `partials` are `[ratio, amplitude]` pairs against the fundamental. Ratios off
 * the harmonic series — 2.76, 5.4 — are what make a struck bar read as metal
 * instead of as an organ, and they are why a pure oscillator type cannot express
 * these voices at all.
 *
 * `decay` is the fraction of the note's length over which the sound falls to
 * silence; `attack` is the ramp in seconds that keeps the start from clicking.
 * `lowpass` is the filter corner in Hz, applied per note.
 *
 * The four bare oscillator types stay available (`sine`, `triangle`, `square`,
 * `sawtooth`) because they are what the previous plugin offered and what a
 * user's existing melody expects.
 */
const VOICES = {
  sine: {
    label: 'Pure tone',
    hint: 'a single sine wave — the plainest possible chime',
    shape: 'sine',
  },
  triangle: { label: 'Soft flute', hint: 'a triangle wave: gentle, few harmonics', shape: 'triangle' },
  square: { label: 'Chip', hint: 'a square wave: hollow and unmistakably electronic', shape: 'square' },
  sawtooth: { label: 'Buzz', hint: 'a sawtooth wave: bright and harsh, cuts through noise', shape: 'sawtooth' },
  bell: {
    label: 'Bell',
    hint: 'inharmonic partials with a long tail — a struck metal bell',
    partials: [
      [1, 1],
      [2.01, 0.5],
      [2.76, 0.28],
      [5.4, 0.14],
      [8.93, 0.07],
    ],
    decay: 0.9,
    attack: 0.004,
  },
  glass: {
    label: 'Glass',
    hint: 'high inharmonic partials, short and bright — a finger on a rim',
    partials: [
      [2.76, 1],
      [5.4, 0.4],
      [8.93, 0.18],
    ],
    decay: 0.5,
    attack: 0.002,
  },
  marimba: {
    label: 'Marimba',
    hint: 'a wooden bar: a strong fundamental, a fast even decay',
    partials: [
      [1, 1],
      [3.9, 0.25],
      [9.2, 0.08],
    ],
    decay: 0.42,
    attack: 0.002,
  },
  pluck: {
    label: 'Pluck',
    hint: 'a short filtered string, for a melody with several notes',
    shape: 'sawtooth',
    decay: 0.35,
    attack: 0.003,
    lowpass: 2600,
  },
  wood: {
    label: 'Wood block',
    hint: 'a click with almost no pitch — the least intrusive of the set',
    partials: [
      [1, 1],
      [1.6, 0.55],
      [2.3, 0.2],
    ],
    decay: 0.16,
    attack: 0.001,
    lowpass: 3200,
  },
  blip: {
    label: 'Blip',
    hint: 'one very short tone — the shortest alert here',
    shape: 'sine',
    decay: 0.22,
    attack: 0.002,
  },
  digital: {
    label: 'Digital',
    hint: 'a two-partial electric chime',
    partials: [
      [1, 1],
      [2, 0.35],
    ],
    decay: 0.3,
    attack: 0.002,
  },
}

/** The voice names, in the order a card lists them. */
const VOICE_NAMES = Object.keys(VOICES)

/** The voice a state uses when it names none. */
const DEFAULT_VOICE = 'sine'

/**
 * Read a voice name.
 * @param name - the written name.
 * @returns the voice and its name, falling back to {@link DEFAULT_VOICE}.
 */
function readVoice(name) {
  const chosen = VOICES[name]
  if (chosen === undefined) return { name: DEFAULT_VOICE, ...VOICES[DEFAULT_VOICE] }
  return { name, ...chosen }
}

// ─── scheduling, as a pure function ──────────────────────────────────────────

/** How long the release ramp lasts, in milliseconds, regardless of note length. */
const RELEASE_MS = 18
/** The gain an exponential ramp may not reach, so the ramp never targets zero. */
const SILENCE = 0.0001
/** How many decimals a scheduled time is rounded to, so tests compare cleanly. */
const TIME_DECIMALS = 4

/**
 * Round to a fixed number of decimals.
 * @param value - the number.
 * @returns the rounded number.
 */
function round(value) {
  const factor = 10 ** TIME_DECIMALS
  return Math.round(value * factor) / factor
}

/**
 * Turn notes and a voice into the complete set of absolute envelope points.
 *
 * This is the function the tests and the browser share, and it is deliberately
 * the *whole* decision: which oscillator settings, at which second, ramping to
 * which gain, and when it stops. What is left to {@link createPlayer} is API
 * calls, and API calls are the part a stub can only pretend to check.
 *
 * The envelope is percussive rather than sustained, because a notification is a
 * strike and not a note held: gain rises from zero over `attack`, falls
 * exponentially toward silence over `decay × length`, and the last
 * {@link RELEASE_MS} ramp to {@link SILENCE} is what stops the tail abruptly
 * without a click. An exponential ramp cannot reach zero, which is exactly why
 * the final target is a small number instead of `0`.
 *
 * @param notes - notes from {@link readMelody}.
 * @param voice - a voice from {@link VOICES}, or a name.
 * @param options - `{ gain, startAt }`: the linear gain (0–1) and the context
 *   time the melody starts at.
 * @returns one event per sounding note: `{ frequency, startedAt, attackEndsAt,
 *   decayEndsAt, stopsAt, gain, shape, partials, lowpass }`, and a `durationMs`
 *   for the whole melody. Rests produce no event but still occupy their time.
 */
function schedule(notes, voice, options) {
  const resolved = typeof voice === 'string' ? readVoice(voice) : (voice ?? readVoice(undefined))
  const startAt = options?.startAt ?? 0
  const gain = options?.gain ?? 1
  const events = []

  for (const note of notes ?? []) {
    if (typeof note?.frequency !== 'number') continue
    const begin = startAt + note.startMs / 1000
    const lengthSeconds = note.durationMs / 1000
    const releaseSeconds = Math.min(RELEASE_MS / 1000, lengthSeconds)
    const decaySeconds = Math.max(
      // A voice with no declared decay holds its level and is shaped only by the
      // release, which is what "a note with a length" means for the bare
      // waveforms — the sound the previous plugin made.
      (resolved.decay ?? 1) * lengthSeconds,
      releaseSeconds,
    )
    const decayEndsAt = begin + decaySeconds
    events.push({
      frequency: note.frequency,
      startedAt: round(begin),
      attackEndsAt: round(begin + (resolved.attack ?? 0.002)),
      decayEndsAt: round(decayEndsAt),
      stopsAt: round(Math.max(decayEndsAt, begin + lengthSeconds) + releaseSeconds),
      gain: round(gain),
      shape: resolved.shape ?? 'sine',
      partials: resolved.partials,
      lowpass: resolved.lowpass,
    })
  }

  return { events, durationMs: melodyLengthMs(notes) }
}

/**
 * Build the periodic wave an event's partials describe, or undefined for a bare
 * oscillator type.
 *
 * The real coefficients are all zero: a partial is a *sine* at a ratio, so it
 * belongs in the imaginary array, and index `k` is the `k`-th harmonic. Ratios
 * off the harmonic series therefore land between indices — which is the reason
 * a struck bell cannot be built from an oscillator type no matter how it is
 * detuned.
 *
 * @param context - an `AudioContext`.
 * @param partials - `[ratio, amplitude]` pairs.
 * @returns the `PeriodicWave`, or undefined when there are no usable partials.
 */
function periodicWave(context, partials) {
  if (!Array.isArray(partials) || partials.length === 0) return undefined
  let highest = 1
  for (const [ratio] of partials) {
    const index = Math.round(ratio)
    if (Number.isFinite(index) && index > highest) highest = index
  }
  // Harmonics above the Nyquist frequency alias into a whistle, and a 8.93
  // partial of a high note is exactly that case. The cap is the context's own
  // sample rate, so the wave stays inside the band the device can reproduce.
  const nyquistHarmonic = Math.floor((context?.sampleRate ?? 44_100) / 2 / 1000)
  const highestHarmonic = Math.max(1, Math.min(highest, Math.max(1, nyquistHarmonic)))
  const real = new Float32Array(highestHarmonic + 1)
  const imaginary = new Float32Array(highestHarmonic + 1)
  for (const [ratio, amplitude] of partials) {
    const index = Math.round(ratio)
    if (index < 1 || index > highestHarmonic) continue
    imaginary[index] = amplitude
  }
  if (imaginary.every((value) => value === 0)) return undefined
  return context.createPeriodicWave(real, imaginary, { disableNormalization: false })
}

// ─── the player ──────────────────────────────────────────────────────────────

/**
 * A chime player over Web Audio, or a silent one when there is no Web Audio.
 *
 * The browser's autoplay policy is the constraint that shapes this class: before
 * any user gesture the context is created suspended, and `resume()` alone is not
 * enough to make it audible. A chime requested inside that window is **dropped**
 * rather than queued — a chime that arrives two minutes late, after the click
 * that finally unlocked audio, is worse than no chime. A settings card's
 * audition button is therefore not just a preview: it is the gesture that
 * unlocks audio for the session.
 *
 * The master gain is a property of the player rather than of a scheduled event,
 * so the master volume can be moved while a sound is ringing and a change does
 * not invalidate anything already scheduled.
 *
 * @param options - `{ AudioContextClass, master }`, injectable so tests drive a
 *   fake context and so the master volume can start where the settings say.
 * @returns the player: `{ play, start, resume, setMaster, state, dispose }`.
 */
function createPlayer(options = {}) {
  const { AudioContextClass } = options
  let context
  let master
  let masterGain = typeof options.master === 'number' ? options.master : 1
  /**
   * Waves already built, keyed by the partial set that produced them.
   *
   * A melody repeats notes — the shipped question theme is three G4s in a row —
   * and every repeat would otherwise build the same `PeriodicWave` again. The
   * key is the partial list flattened, because two voices that name the same
   * partials *are* the same wave.
   */
  const waves = new Map()

  /**
   * The wave for one event's partials, built once per distinct partial set.
   * @param audio - the live context.
   * @param partials - the event's partials.
   * @returns the wave, or undefined for a bare oscillator type.
   */
  const waveFor = (audio, partials) => {
    if (!Array.isArray(partials) || partials.length === 0) return undefined
    const key = partials.flat().join(',')
    if (!waves.has(key)) waves.set(key, periodicWave(audio, partials))
    return waves.get(key)
  }

  /** Build the context lazily, and never let a construction failure escape. */
  const ensure = () => {
    if (context !== undefined) return context
    if (AudioContextClass === undefined) return undefined
    try {
      context = new AudioContextClass()
      master = context.createGain()
      master.gain.value = masterGain
      master.connect(context.destination)
    } catch {
      context = undefined
      master = undefined
    }
    waves.clear()
    return context
  }

  const player = {
    /** Ask the browser to start the clock. Safe to call any time, any number of times. */
    resume() {
      const audio = ensure()
      if (audio === undefined) return
      try {
        if (audio.state === 'suspended') void audio.resume()
      } catch {
        /* a refused resume is the autoplay policy, not an error worth surfacing */
      }
    },

    /**
     * The player's own view of the world, for the settings row to print.
     * @returns `{ available, state, master }`.
     */
    state() {
      const audio = context
      return {
        available: AudioContextClass !== undefined,
        state: audio === undefined ? 'uninitialized' : (audio.state ?? 'unknown'),
        master: masterGain,
      }
    },

    /**
     * Move the master volume, now and for everything after.
     * @param value - 0–1.
     * @returns {void}
     */
    setMaster(value) {
      if (!Number.isFinite(value)) return
      masterGain = Math.min(1, Math.max(0, value))
      if (master === undefined) return
      try {
        master.gain.value = masterGain
      } catch {
        /* a closed context: the next ensure() builds a new one with this value */
      }
    },

    /**
     * Play one melody with one voice.
     * @param melody - the melody text.
     * @param voiceName - the voice name.
     * @param gain - this state's own gain, 0–1, multiplied by the master.
     * @returns whether a sound was actually scheduled.
     */
    play(melody, voiceName, gain) {
      const audio = ensure()
      if (audio === undefined || master === undefined) return false
      player.resume()
      if (audio.state === 'suspended') return false
      const read = typeof melody === 'string' ? readMelody(melody) : melody
      if (read?.silent === true) return false
      const level = typeof gain === 'number' ? Math.min(1, Math.max(0, gain)) : 1
      const plan = schedule(read.notes, voiceName, { gain: level, startAt: audio.currentTime })
      for (const event of plan.events) {
        const oscillator = audio.createOscillator()
        const envelope = audio.createGain()
        // The wave is resolved per event rather than once for the melody: a voice
        // is a recipe for one note, and a reader that hoisted it out of the loop
        // would silently give every note the first note's timbre.
        const wave = waveFor(audio, event.partials)
        if (wave !== undefined) {
          oscillator.setPeriodicWave(wave)
        } else {
          oscillator.type = event.shape
        }
        oscillator.frequency.setValueAtTime(event.frequency, event.startedAt)
        // A bare gate on a tone clicks; the attack and the release are what make
        // it read as a chime rather than as a pop, on any voice.
        envelope.gain.setValueAtTime(SILENCE, event.startedAt)
        envelope.gain.linearRampToValueAtTime(event.gain, event.attackEndsAt)
        envelope.gain.exponentialRampToValueAtTime(SILENCE, event.decayEndsAt)
        oscillator.connect(envelope)
        if (event.lowpass === undefined) {
          envelope.connect(master)
        } else {
          const filter = audio.createBiquadFilter()
          filter.type = 'lowpass'
          filter.frequency.setValueAtTime(event.lowpass, event.startedAt)
          envelope.connect(filter)
          filter.connect(master)
        }
        oscillator.start(event.startedAt)
        oscillator.stop(event.stopsAt)
      }
      return plan.events.length > 0
    },

    /** Alias of {@link play} under the name the settings card uses for a one-off. */
    start(melody, voiceName, gain) {
      return player.play(melody, voiceName, gain)
    },

    /** Release the audio hardware. */
    dispose() {
      const audio = context
      context = undefined
      master = undefined
      waves.clear()
      if (audio === undefined) return
      try {
        void audio.close()
      } catch {
        /* already closed, or the browser refuses; nothing to do */
      }
    },
  }

  return player
}

// ─── src/settings.js ─────────────────────────────────────────────────
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




/**
 * When a sound is allowed to be audible at all.
 *
 * `background` is the shipped value and the reasoning is the same one the tabbed
 * plugin recorded: while the user is looking at the interface, the interface has
 * already said what happened, and a chime on top of that is noise. `always` is
 * for a user who wants the feedback regardless, and `off` mutes the bell channel
 * without touching any card.
 */
const SOUND_SCOPES = ['off', 'background', 'always']

/**
 * The per-state defaults.
 *
 * The melodies are the four public-domain phrases the previous plugin shipped,
 * kept note for note, plus a fifth for the failure state. That is not inertia:
 * a user who has lived with this plugin's sounds for months should not have them
 * change under an upgrade, and the phrases were chosen for what their state means
 * — a knock at the door for a question, a grave descent for a decision, a quiet
 * resolution for completion. The failure phrase is new, and it is deliberately
 * the only one that goes *down* and ends unresolved, because that is what it is
 * reporting.
 *
 * `notification` ships on for the three states that mean "a person must act", and
 * off for `done` and `running`. The reasoning is the feature's own: a system
 * banner is an interruption with a claim on the whole desktop, so it belongs to
 * the states where the session genuinely cannot proceed without the user. A card
 * can always turn it on for the others.
 */
const STATE_DEFAULTS = {
  question: {
    enabled: true,
    sound: true,
    volume: 0.7,
    voice: 'bell',
    melody: 'G4:170ms G4:170ms G4:170ms Eb4:680ms',
    notification: true,
    title: '{title} is asking',
    body: '{summary}',
  },
  approval: {
    enabled: true,
    sound: true,
    volume: 0.6,
    voice: 'bell',
    melody: 'A5:350ms G5:95ms F5:95ms E5:95ms D5:95ms C#5:95ms D5:500ms',
    notification: true,
    title: '{title} needs a decision',
    body: '{summary}',
  },
  plan: {
    enabled: true,
    sound: true,
    volume: 0.6,
    voice: 'marimba',
    melody: 'C5:120ms E5:120ms G5:120ms C6:420ms',
    notification: true,
    title: '{title} has a plan to review',
    body: 'Read it, then approve or ask for changes.',
  },
  failed: {
    enabled: true,
    sound: true,
    volume: 0.5,
    voice: 'wood',
    melody: 'A4:160ms F4:160ms D4:420ms',
    notification: true,
    title: '{title} failed',
    body: 'The turn ended with an error.',
  },
  done: {
    enabled: true,
    sound: true,
    volume: 0.35,
    voice: 'marimba',
    melody: 'E4:230ms E4:230ms F4:230ms G4:230ms G4:230ms F4:230ms E4:230ms D4:460ms',
    notification: false,
    title: '{title} finished',
    body: 'The turn is complete.',
  },
  running: {
    // The one card that ships switched off, and the reason the card exists at
    // all: a turn *starting* is not something to interrupt anyone for, so the
    // shipped answer is no. A user who wants feedback that work began turns it
    // on, and that is a decision the card can express rather than a policy the
    // engine has to guess.
    enabled: false,
    sound: false,
    volume: 0.3,
    voice: 'pluck',
    melody: 'C5:90ms G5:140ms',
    notification: false,
    title: '{title} started',
    body: 'A turn is running.',
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
const GLOBAL_DEFAULTS = {
  enabled: true,
  masterVolume: 0.8,
  soundScope: 'background',
  minGapMs: 1500,
  skipFocusedSession: true,
  skipWhenVisible: false,
  desktopNotifications: true,
  repeatMs: 0,
}

/** The settings-schema version, so a future migration has something to read. */
const SETTINGS_VERSION = 1

/**
 * The field roster, in the order a card lists it.
 *
 * This table is the contract between three things that cannot import each other:
 * the settings card that renders a control, the engine that reads the value, and
 * the host-half schema that decides what may be stored. It is written down once
 * here and asserted by the tests, which is the only way a fourth writer can be
 * prevented from inventing a field nobody reads.
 */
const STATE_FIELDS = [
  { id: 'enabled', kind: 'boolean', label: 'Alert for this state', hint: 'the card’s own master switch' },
  { id: 'sound', kind: 'boolean', label: 'Play a sound', hint: 'this state’s bell' },
  { id: 'volume', kind: 'number', min: 0, max: 1, label: 'Volume', hint: 'this state’s own level' },
  { id: 'voice', kind: 'choice', values: VOICE_NAMES, label: 'Timbre', hint: 'what it sounds like' },
  { id: 'melody', kind: 'melody', label: 'Melody', hint: 'note names and lengths; off for silence' },
  { id: 'notification', kind: 'boolean', label: 'System notification', hint: 'a desktop banner as well' },
  { id: 'title', kind: 'template', label: 'Notification title', hint: 'the banner’s heading' },
  { id: 'body', kind: 'template', label: 'Notification body', hint: 'the banner’s text' },
]

/** The global field roster, in the order the section lists it. */
const GLOBAL_FIELDS = [
  { id: 'enabled', kind: 'boolean', label: 'Enable notifications', hint: 'the plugin’s master switch' },
  { id: 'masterVolume', kind: 'number', min: 0, max: 1, label: 'Master volume', hint: 'applies to every state’s sound' },
  { id: 'soundScope', kind: 'choice', values: SOUND_SCOPES, label: 'When sound plays', hint: 'the bell channel' },
  { id: 'minGapMs', kind: 'number', min: 0, max: 30_000, label: 'Minimum gap between sounds', hint: 'milliseconds' },
  { id: 'skipFocusedSession', kind: 'boolean', label: 'Stay quiet about the session you are looking at', hint: 'it is already on screen' },
  { id: 'skipWhenVisible', kind: 'boolean', label: 'Stay quiet while the window is in front', hint: 'no sound and no banner while you are here' },
  { id: 'desktopNotifications', kind: 'boolean', label: 'Allow system notifications', hint: 'the banner channel' },
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
function coerceField(field, value) {
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
 *   skipFocusedSession, skipWhenVisible, desktopNotifications, repeatMs, states }`.
 */
function resolveSettings(section) {
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
function defaultSection() {
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
 * @param facts - `{ isMain, phase, now, lastSpokenAt, hasSound, hasNotification }`.
 * @returns `{ allowed, reason }`: whether anything should happen, and why not.
 */
function admit(kind, settings, facts) {
  const state = settings?.states?.[kind]
  if (settings?.enabled !== true) return { allowed: false, reason: 'master-off' }
  if (state === undefined) return { allowed: false, reason: 'unknown-state' }
  if (state.enabled !== true) return { allowed: false, reason: 'card-off' }
  const wantsSound = state.sound === true && settings.soundScope !== 'off'
  const wantsNotification = state.notification === true && settings.desktopNotifications !== false
  if (!wantsSound && !wantsNotification) return { allowed: false, reason: 'no-channel' }
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
function soundAllowed(settings, facts) {
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
function stateGain(settings, kind) {
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
function stateVoice(settings, kind) {
  const voice = settings?.states?.[kind]?.voice
  return VOICE_NAMES.includes(voice) ? voice : DEFAULT_VOICE
}

// ─── src/templates.js ────────────────────────────────────────────────
/**
 * Templates: the text a notification carries, and the words a user can put in it.
 *
 * A per-state reminder text is only useful if it can say *which* session it is
 * about, so the template is a string with named holes in it:
 *
 *     {title} needs an answer        →  "Refactor the parser needs an answer"
 *     {count} sessions are waiting   →  "3 sessions are waiting"
 *
 * The vocabulary is a closed, documented list rather than an expression language,
 * and that is the deliberate part: this text is edited in a settings card by a
 * person who is looking at the list of words right next to the field, and a
 * template engine with conditionals in it would make "why is my notification
 * empty" unanswerable. A placeholder nobody knows is *reported*, not silently
 * dropped, and the renderer never throws: a broken template must still produce a
 * notification rather than a missing one.
 *
 * @module dsh-notification/templates
 */

/**
 * The words a template may use.
 *
 * `title` and `summary` are the session's own text and are the reason the
 * feature exists — a notification that says only "a session finished" makes the
 * user open the window to find out which one, which is exactly the work the
 * notification was supposed to save.
 */
const TEMPLATE_FIELDS = [
  { name: 'title', hint: 'the session title' },
  { name: 'summary', hint: "a pending interaction's own text, when it has one" },
  { name: 'state', hint: 'this state in the interface language' },
  { name: 'count', hint: 'how many sessions are in this state right now' },
  { name: 'time', hint: 'the local time, as HH:MM' },
]

/** `{name}`, the only placeholder syntax. */
const PLACEHOLDER = /\{([a-zA-Z0-9_-]+)\}/gu

/**
 * Render one template.
 *
 * Unknown placeholders are left in the text exactly as written and reported, so
 * the card can underline them: leaving them visible is what makes a typo
 * self-diagnosing, whereas dropping them produces a notification with a silent
 * gap in the sentence — the failure mode nobody reports as a bug because it
 * looks like the plugin's own wording.
 *
 * @param template - the template text.
 * @param context - `{ title, summary, state, count, time }`, any of them absent.
 * @returns `{ text, unknown }`: the rendered text and the names nobody knows.
 */
function renderTemplate(template, context = {}) {
  const source = typeof template === 'string' ? template : ''
  const unknown = []
  const text = source.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(context, name)) {
      if (!unknown.includes(name)) unknown.push(name)
      return whole
    }
    const value = context[name]
    return value === undefined || value === null ? '' : String(value)
  })
  return { text, unknown }
}

/**
 * Which of a template's placeholders are unknown.
 * @param template - the template text.
 * @returns the names, in first-appearance order.
 */
function unknownFields(template) {
  return renderTemplate(template, {}).unknown
}

/**
 * Fit a rendered line into a notification body without cutting a word in half.
 *
 * Desktop notification bodies are truncated by the operating system at a length
 * this process cannot see, and a title cut mid-word reads as a bug in the
 * plugin. Trimming here, at a word boundary and with an ellipsis, makes the
 * decision visible and testable instead of leaving it to whatever the platform
 * does.
 *
 * @param text - the rendered text.
 * @param limit - the maximum length, in characters.
 * @returns the text, shortened if it had to be.
 */
function fitLine(text, limit = 120) {
  const collapsed = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, Math.max(1, limit - 1))
  const boundary = cut.lastIndexOf(' ')
  // Only break on a word when that does not throw most of the text away: a
  // single very long token (a path, a URL) has no boundary to break on.
  const body = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return `${body.trimEnd()}…`
}

/**
 * The local time as `HH:MM`, from a clock the caller supplies.
 *
 * The clock is a parameter rather than `new Date()` so this is testable, which
 * is the same reason every other decision in this plugin takes its inputs as
 * arguments.
 *
 * @param now - epoch milliseconds.
 * @returns the time.
 */
function clockTime(now) {
  const date = new Date(now)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

// ─── src/row.js ──────────────────────────────────────────────────────
/**
 * The settings row: one card per state, plus the switches that apply to all of
 * them.
 *
 * This is the file the previous plugin in this family got wrong, and the mistake
 * is worth naming because the fix is the shape of everything below. That plugin
 * made its configuration a *document* — a small language, edited in a code editor
 * — on the argument that four states each with an appearance and a sound are
 * really one table, and that a table reads better as a table. The argument was
 * defensible for the thing it was configuring, and it is wrong for this one: a
 * notification has no appearance, so there is no fourth column holding the
 * controls together, and what is left is a form whose fields the user has to
 * remember the names of.
 *
 * So the configuration is controls, grouped into a card per state, and the two
 * things a document was good at are bought back another way:
 *
 * - **The melody stays text**, because it is the one field with a real grammar
 *   and the one field worth generating rather than clicking. `scripts/
 *   analyze-sound.mjs` is its editor-side counterpart: it answers what a melody
 *   will sound like without playing it.
 * - **The card is total**, so nothing is hidden behind a mode: every switch, every
 *   level, and both notification strings are visible at once for the state being
 *   edited. The `enabled` switch is what collapses a card, and it is the user's
 *   choice rather than the interface's.
 *
 * There is no JSX anywhere in this plugin. A client bundle here is a classic
 * script whose imports are rewritten by a hand-written build step, and a
 * transformation that has to understand JSX is a transformation that can be wrong
 * about it. `React.createElement` is what the build can already prove it handles.
 *
 * @module dsh-notification/row
 */







/** The element factory, aliased because `h` reads better than `React.createElement`. */
const h = React.createElement

/**
 * The plugin's own class prefix, so its stylesheet cannot collide with another
 * plugin's and so every element it owns is identifiable in a page it does not own.
 */
const STYLE_PREFIX = 'dsh-notification'

/** A class name in this plugin's namespace. @param name - the suffix. @returns the class. */
function cn(name) {
  return `${STYLE_PREFIX}-${name}`
}

/**
 * The stylesheet for the row.
 *
 * Every colour is a design token rather than a literal, which is what makes the
 * row follow the interface's theme instead of the operating system's — the two are
 * not the same thing, and a settings page that ignores the theme switch reads as a
 * control that wandered in from somewhere else.
 */
const ROW_CSS = [
  `.${cn('row')}{flex-direction:column;gap:16px;display:flex;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}`,
  `.${cn('head')}{flex-direction:column;gap:4px;display:flex}`,
  `.${cn('title')}{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}`,
  `.${cn('desc')}{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`,
  `.${cn('section')}{flex-direction:column;gap:8px;display:flex}`,
  `.${cn('sectionTitle')}{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}`,
  `.${cn('sectionHint')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('card')}{flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:12px;display:flex}`,
  `.${cn('card')}[data-off="true"]{opacity:.66}`,
  `.${cn('cardHead')}{align-items:center;justify-content:space-between;gap:12px;display:flex}`,
  `.${cn('cardTitle')}{flex-direction:column;gap:2px;min-width:0;display:flex}`,
  `.${cn('cardName')}{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}`,
  `.${cn('cardCount')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('check')}{align-items:center;gap:8px;display:flex;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}`,
  `.${cn('check')} input{cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('field')}{flex-direction:column;gap:4px;display:flex;min-width:0}`,
  `.${cn('label')}{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}`,
  `.${cn('input')}{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;padding:5px 8px}`,
  `.${cn('input')}:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('input')}[data-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}`,
  `.${cn('row2')}{align-items:flex-end;gap:8px;display:flex;flex-wrap:wrap}`,
  `.${cn('range')}{flex:1;min-width:120px;accent-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('value')}{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}`,
  `.${cn('actions')}{align-items:center;gap:8px;flex-wrap:wrap;display:flex}`,
  `.${cn('button')}{border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:8px;padding:4px 10px;font-family:inherit;font-size:11px;line-height:16px}`,
  `.${cn('button')}:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
  `.${cn('button')}:disabled{opacity:.5;cursor:default}`,
  `.${cn('problems')}{flex-direction:column;gap:2px;display:flex}`,
  `.${cn('problem')}{color:var(--dsw-alias-state-warn-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px}`,
  `.${cn('note')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('tokens')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('tokens')} code{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}`,
  `.${cn('warning')}{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px}`,
  `.${cn('grid')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}`,
].join('')

/**
 * The interface-language copy for this row.
 *
 * `zh` is the key-set source of truth and the English dictionary is compared
 * against it by the tests, which is how a translation that lost a key fails on the
 * command line rather than rendering `notification.melody` to a user.
 */
const zh = {
  'notification.title': '会话通知',
  'notification.description':
    '会话状态变化时告诉你 —— 每个状态一张卡片，各自决定响不响、响多大、什么音色、系统通知说什么',
  'notification.master': '总开关',
  'notification.masterHint': '关掉之后所有卡片都不再出声、不再弹通知',
  'notification.globals': '全局设置',
  'notification.cards': '状态卡片',
  'notification.cardsHint': '每个状态独立开关。关掉的卡片灰显，但仍然可以编辑。',
  'notification.enabled': '启用这个状态',
  'notification.sound': '播放提示音',
  'notification.volume': '音量',
  'notification.voice': '音色',
  'notification.melody': '旋律',
  'notification.melodyHint': '音名加时值，例如 A5:200ms E6:200ms；off 表示不出声',
  'notification.notification': '系统通知',
  'notification.bannerTitle': '通知标题',
  'notification.bannerBody': '通知正文',
  'notification.templateHint': '可用字段：',
  'notification.unknownField': '这个字段不认识，会原样显示',
  'notification.audition': '试听',
  'notification.test': '测试通知',
  'notification.reset': '恢复默认',
  'notification.masterVolume': '总音量',
  'notification.masterVolumeHint': '与各卡片自己的音量相乘',
  'notification.soundScope': '什么时候出声',
  'notification.soundScope.off': '从不出声',
  'notification.soundScope.background': '窗口不在前台时',
  'notification.soundScope.always': '总是',
  'notification.minGap': '两次提示音的最小间隔',
  'notification.repeat': '同一状态的最短重复间隔',
  'notification.skipFocused': '不要提醒我正在看的那个会话',
  'notification.skipVisible': '窗口在前台时完全安静',
  'notification.desktopNotifications': '允许系统通知',
  'notification.permission': '系统通知权限',
  'notification.permission.granted': '已授权',
  'notification.permission.denied': '已被拒绝 —— 需要在系统设置里允许',
  'notification.permission.default': '尚未询问',
  'notification.permission.unsupported': '这个环境不支持系统通知',
  'notification.permission.ask': '请求授权',
  'notification.testResult.shown': '已发出',
  'notification.testResult.empty': '标题是空的，没有发出',
  'notification.testResult.threw': '系统拒绝了这条通知',
  'notification.testResult.skipped': '这次不会触发',
  'notification.testResult.silent': '没有通道会响应',
  'notification.audio': '音频',
  'notification.audio.locked': '音频还没解锁 —— 点一次「试听」即可',
  'notification.audio.unavailable': '这个环境没有 Web Audio，只有系统通知可用',
  'notification.audio.running': '音频就绪',
  'notification.audio.uninitialized': '音频尚未初始化',
  'notification.problems': '这些内容读不出来：',
  'notification.ms': '毫秒',
  'notification.state.question': '等待回答',
  'notification.state.approval': '等待审批',
  'notification.state.plan': '等待审阅计划',
  'notification.state.failed': '执行出错',
  'notification.state.done': '执行完成',
  'notification.state.running': '开始执行',
}

/** English dictionary, checked complete against the `zh` key set by the tests. */
const en = {
  'notification.title': 'Session notifications',
  'notification.description':
    'Tells you when a session changes state — one card per state, each deciding whether to sound, how loud, in what timbre, and what a desktop banner says',
  'notification.master': 'Master switch',
  'notification.masterHint': 'Switched off, no card sounds and no banner appears',
  'notification.globals': 'Global settings',
  'notification.cards': 'State cards',
  'notification.cardsHint': 'Each state is switched on and off on its own. A card that is off is dimmed but still editable.',
  'notification.enabled': 'Alert for this state',
  'notification.sound': 'Play a sound',
  'notification.volume': 'Volume',
  'notification.voice': 'Timbre',
  'notification.melody': 'Melody',
  'notification.melodyHint': 'note names with lengths, e.g. A5:200ms E6:200ms; off for silence',
  'notification.notification': 'System notification',
  'notification.bannerTitle': 'Notification title',
  'notification.bannerBody': 'Notification body',
  'notification.templateHint': 'available fields: ',
  'notification.unknownField': 'this field is not known, so it is shown as written',
  'notification.audition': 'Play',
  'notification.test': 'Test notification',
  'notification.reset': 'Reset',
  'notification.masterVolume': 'Master volume',
  'notification.masterVolumeHint': 'multiplied by each card’s own level',
  'notification.soundScope': 'When sound plays',
  'notification.soundScope.off': 'never',
  'notification.soundScope.background': 'while the window is not in front',
  'notification.soundScope.always': 'always',
  'notification.minGap': 'Minimum gap between sounds',
  'notification.repeat': 'Do not repeat the same state within',
  'notification.skipFocused': 'Stay quiet about the session I am looking at',
  'notification.skipVisible': 'Stay completely quiet while the window is in front',
  'notification.desktopNotifications': 'Allow system notifications',
  'notification.permission': 'System notification permission',
  'notification.permission.granted': 'granted',
  'notification.permission.denied': 'refused — allow it in your system settings',
  'notification.permission.default': 'not asked yet',
  'notification.permission.unsupported': 'this environment has no system notifications',
  'notification.permission.ask': 'Ask for permission',
  'notification.testResult.shown': 'sent',
  'notification.testResult.empty': 'the title is empty, so nothing was sent',
  'notification.testResult.threw': 'the system refused the notification',
  'notification.testResult.skipped': 'nothing would happen for this state',
  'notification.testResult.silent': 'neither channel would respond',
  'notification.audio': 'Audio',
  'notification.audio.locked': 'audio is still locked — press Play once to unlock it',
  'notification.audio.unavailable': 'no Web Audio here, so only system notifications are available',
  'notification.audio.running': 'audio ready',
  'notification.audio.uninitialized': 'audio not initialized yet',
  'notification.problems': 'These cannot be read:',
  'notification.ms': 'ms',
  'notification.state.question': 'Waiting for an answer',
  'notification.state.approval': 'Waiting for approval',
  'notification.state.plan': 'Waiting for a plan review',
  'notification.state.failed': 'Ended with an error',
  'notification.state.done': 'Finished',
  'notification.state.running': 'Started',
}

/**
 * Every key the row's copy must have, for the test that compares the two
 * dictionaries. Derived from `zh` so a key added to one language and forgotten in
 * the other is a failing assertion.
 */
const MESSAGE_KEYS = Object.keys(zh)

/**
 * A labelled checkbox.
 *
 * Deliberately not the `Switch` from `@deepseek-ai/dsh-client-ui-primitives`,
 * even though that package exports exactly this control. The shipped authoring
 * rule for a third-party bundle is explicit that a client plugin must not
 * `require` a Harness client package: those modules "change without notice", a
 * plain-JavaScript plugin gets no type check, and a component that throws blanks
 * the slot it was registered into. The rule's own remedy is to copy the control
 * and style it from the `--dsw-*` tokens, which is what this file does for every
 * control it needs. The primitives remain the design reference.
 *
 * @param props - `{ t, checked, onChange, labelKey, id }`.
 * @returns the control element.
 */
function Check({ t, checked, onChange, labelKey, id }) {
  return h(
    'label',
    { className: cn('check'), htmlFor: id },
    h('input', {
      id,
      type: 'checkbox',
      checked: checked === true,
      onChange: (event) => {
        onChange(event.target.checked)
      },
    }),
    t(labelKey),
  )
}

/**
 * A labelled slider with its value beside it.
 *
 * A range input rather than a primitive, because the primitives package
 * deliberately ships no slider (its catalog lists buttons, switches, tabs, text
 * inputs, and no numeric control), and a plugin that invented one would be
 * inventing a control rather than borrowing one. The native range input is themed
 * through `accent-color`, so it follows the interface rather than the OS.
 *
 * @param props - `{ t, labelKey, value, min, max, step, onChange, format }`.
 * @returns the field element.
 */
function Slider({ t, labelKey, value, min, max, step, onChange, format }) {
  const shown = typeof format === 'function' ? format(value) : String(value)
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h(
      'div',
      { className: cn('row2') },
      h('input', {
        className: cn('range'),
        type: 'range',
        min,
        max,
        step,
        value,
        onChange: (event) => {
          onChange(Number.parseFloat(event.target.value))
        },
      }),
      h('span', { className: cn('value') }, shown),
    ),
  )
}

/**
 * A labelled one-line text input.
 *
 * @param props - `{ t, labelKey, value, onChange, placeholder, invalid }`.
 * @returns the field element.
 */
function TextField({ t, labelKey, value, onChange, placeholder, invalid }) {
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h('input', {
      className: cn('input'),
      type: 'text',
      value,
      placeholder,
      spellCheck: false,
      'data-invalid': invalid === true ? 'true' : undefined,
      onChange: (event) => {
        onChange(event.target.value)
      },
    }),
  )
}

/**
 * A labelled dropdown over a closed set of names.
 *
 * @param props - `{ t, labelKey, value, options, onChange, describe }`.
 * @returns the field element.
 */
function Choice({ t, labelKey, value, options, onChange, describe }) {
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h(
      'select',
      {
        className: cn('input'),
        value,
        onChange: (event) => {
          onChange(event.target.value)
        },
      },
      ...options.map((name) =>
        h('option', { key: name, value: name }, describe === undefined ? name : describe(name)),
      ),
    ),
  )
}

/**
 * One state's card.
 *
 * @param props - `{ t, kind, state, count, defaults, onChange, onAudition, onTest }`.
 * @returns the card element.
 */
function StateCard({ t, kind, state, count, defaults, onChange, onAudition, onTest }) {
  const off = state.enabled !== true
  const melody = typeof state.melody === 'string' ? state.melody : ''
  const unknown = [...unknownFields(state.title), ...unknownFields(state.body)]
  const uniqueUnknown = [...new Set(unknown)]
  /** Write one field of this card. @param field @param value */
  const set = (field, value) => {
    onChange(kind, field, value)
  }

  return h(
    'div',
    { className: cn('card'), 'data-off': off ? 'true' : 'false', 'data-state': kind },
    h(
      'div',
      { className: cn('cardHead') },
      h(
        'div',
        { className: cn('cardTitle') },
        h('div', { className: cn('cardName') }, t(`notification.state.${kind}`)),
        h(
          'div',
          { className: cn('cardCount') },
          count === undefined ? '' : `${String(count)}`,
        ),
      ),
      Check({ t, id: `dsh-notification-${kind}-enabled`, checked: !off, onChange: (value) => { set('enabled', value) }, labelKey: 'notification.enabled' }),
    ),
    h(
      'div',
      { className: cn('row2') },
      Check({ t, id: `dsh-notification-${kind}-sound`, checked: state.sound === true, onChange: (value) => { set('sound', value) }, labelKey: 'notification.sound' }),
      Check({ t, id: `dsh-notification-${kind}-notification`, checked: state.notification === true, onChange: (value) => { set('notification', value) }, labelKey: 'notification.notification' }),
    ),
    h(
      'div',
      { className: cn('grid') },
      h(Slider, {
        t,
        labelKey: 'notification.volume',
        value: state.volume,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (value) => {
          set('volume', value)
        },
        format: (value) => `${String(Math.round(value * 100))}%`,
      }),
      h(Choice, {
        t,
        labelKey: 'notification.voice',
        value: state.voice,
        options: VOICE_NAMES,
        onChange: (value) => {
          set('voice', value)
        },
        describe: (name) => VOICES[name]?.label ?? name,
      }),
    ),
    h(TextField, {
      t,
      labelKey: 'notification.melody',
      value: melody,
      placeholder: defaults.melody,
      onChange: (value) => {
        set('melody', value)
      },
    }),
    h('div', { className: cn('note') }, t('notification.melodyHint')),
    h(TextField, {
      t,
      labelKey: 'notification.bannerTitle',
      value: state.title,
      placeholder: defaults.title,
      onChange: (value) => {
        set('title', value)
      },
    }),
    h(TextField, {
      t,
      labelKey: 'notification.bannerBody',
      value: state.body,
      placeholder: defaults.body,
      onChange: (value) => {
        set('body', value)
      },
    }),
    h(
      'div',
      { className: cn('tokens') },
      t('notification.templateHint'),
      ...TEMPLATE_FIELDS.flatMap((field, index) => [
        index === 0 ? null : ' · ',
        h('code', { key: field.name, title: field.hint }, `{${field.name}}`),
      ]).filter((node) => node !== null),
    ),
    uniqueUnknown.length === 0
      ? null
      : h(
          'div',
          { className: cn('warning') },
          `${t('notification.unknownField')}: ${uniqueUnknown.map((name) => `{${name}}`).join(', ')}`,
        ),
    h(
      'div',
      { className: cn('actions') },
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onAudition(kind)
          },
        },
        t('notification.audition'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onTest(kind)
          },
        },
        t('notification.test'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onChange(kind, undefined, undefined, true)
          },
        },
        t('notification.reset'),
      ),
    ),
  )
}

/**
 * The row: the master switches, then one card per state.
 *
 * `useNotification` is the store hook the slot registry injects — the plugin's own
 * live configuration, so every control reads what the engine is actually running on
 * rather than a copy this component made. The rest of the props are the actions and
 * the two pieces of *state* that are not configuration: whether the system will
 * show a banner, and whether audio has been unlocked.
 *
 * @param props - `{ t, useNotification, onChange, onAudition, onTest, onReset, onAskPermission, permission, audio }`.
 * @returns the row element.
 */
function NotificationRow({
  t,
  useNotification,
  permission,
  audio,
  onChange,
  onAudition,
  onTest,
  onReset,
  onAskPermission,
}) {
  // One selector over the whole store: the row renders a handful of cards and a
  // dozen controls, and a per-field subscription would be more machinery than the
  // work it saves.
  const state = useNotification((snapshot) => snapshot)
  const settings = state?.settings ?? resolveSettings(undefined)
  const counts = state?.counts ?? {}
  /** Write one global field. @param field @param value */
  const setGlobal = (field, value) => {
    onChange(undefined, field, value)
  }
  const permissionKey = `notification.permission.${permission?.permission ?? 'unsupported'}`
  const audioKey =
    audio?.available === false
      ? 'notification.audio.unavailable'
      : audio?.state === 'running'
        ? 'notification.audio.running'
        : audio?.state === 'suspended'
          ? 'notification.audio.locked'
          : 'notification.audio.uninitialized'

  return h(
    'div',
    { className: cn('row') },
    h(
      'div',
      { className: cn('head') },
      h('div', { className: cn('title') }, t('notification.title')),
      h('div', { className: cn('desc') }, t('notification.description')),
    ),

    Check({
      t,
      id: 'dsh-notification-master',
      checked: settings.enabled === true,
      onChange: (value) => {
        setGlobal('enabled', value)
      },
      labelKey: 'notification.master',
    }),
    h('div', { className: cn('note') }, t('notification.masterHint')),

    h(
      'div',
      { className: cn('section') },
      h('div', { className: cn('sectionTitle') }, t('notification.globals')),
      h(
        'div',
        { className: cn('grid') },
        h(Slider, {
          t,
          labelKey: 'notification.masterVolume',
          value: settings.masterVolume,
          min: 0,
          max: 1,
          step: 0.05,
          onChange: (value) => {
            setGlobal('masterVolume', value)
          },
          format: (value) => `${String(Math.round(value * 100))}%`,
        }),
        h(Choice, {
          t,
          labelKey: 'notification.soundScope',
          value: settings.soundScope,
          options: SOUND_SCOPES,
          onChange: (value) => {
            setGlobal('soundScope', value)
          },
          describe: (name) => t(`notification.soundScope.${name}`),
        }),
        h(Slider, {
          t,
          labelKey: 'notification.minGap',
          value: settings.minGapMs,
          min: 0,
          max: 10_000,
          step: 100,
          onChange: (value) => {
            setGlobal('minGapMs', value)
          },
          format: (value) => `${String(value)} ${t('notification.ms')}`,
        }),
        h(Slider, {
          t,
          labelKey: 'notification.repeat',
          value: settings.repeatMs,
          min: 0,
          max: 60_000,
          step: 500,
          onChange: (value) => {
            setGlobal('repeatMs', value)
          },
          format: (value) => `${String(value)} ${t('notification.ms')}`,
        }),
      ),
      h(
        'div',
        { className: cn('row2') },
        Check({
          t,
          id: 'dsh-notification-desktop',
          checked: settings.desktopNotifications === true,
          onChange: (value) => {
            setGlobal('desktopNotifications', value)
          },
          labelKey: 'notification.desktopNotifications',
        }),
        Check({
          t,
          id: 'dsh-notification-skip-focused',
          checked: settings.skipFocusedSession === true,
          onChange: (value) => {
            setGlobal('skipFocusedSession', value)
          },
          labelKey: 'notification.skipFocused',
        }),
        Check({
          t,
          id: 'dsh-notification-skip-visible',
          checked: settings.skipWhenVisible === true,
          onChange: (value) => {
            setGlobal('skipWhenVisible', value)
          },
          labelKey: 'notification.skipVisible',
        }),
      ),
      h(
        'div',
        { className: cn('actions') },
        h('span', { className: cn('note') }, `${t('notification.permission')}: ${t(permissionKey)}`),
        permission?.canAsk === true
          ? h(
              'button',
              {
                type: 'button',
                className: cn('button'),
                onClick: () => {
                  onAskPermission()
                },
              },
              t('notification.permission.ask'),
            )
          : null,
        h('span', { className: cn('note') }, `${t('notification.audio')}: ${t(audioKey)}`),
      ),
    ),

    h(
      'div',
      { className: cn('section') },
      h('div', { className: cn('sectionTitle') }, t('notification.cards')),
      h('div', { className: cn('sectionHint') }, t('notification.cardsHint')),
      ...STATE_KINDS.map((kind) =>
        h(StateCard, {
          key: kind,
          t,
          kind,
          state: settings.states[kind],
          count: counts[kind],
          defaults: STATE_DEFAULTS[kind],
          onChange,
          onAudition,
          onTest,
        }),
      ),
    ),

    h(
      'div',
      { className: cn('actions') },
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onReset()
          },
        },
        t('notification.reset'),
      ),
    ),
  )
}

// ─── src/system.js ───────────────────────────────────────────────────
/**
 * System notifications: the OS-level banner, and everything that can go wrong
 * with it.
 *
 * The desktop application is an Electron shell around the ordinary web
 * interface, so the channel available to a plugin is the standard Web
 * `Notification` API — there is no privileged bridge for this, and that is a
 * finding rather than an assumption: the shell's preload exposes exactly
 * `protocolVersion`, `browser`, `deviceInfo`, `keyboard`, `shortcuts` and
 * `updates` to the page, and its own use of Electron's `Notification` class is
 * reserved for a mandatory-update prompt. So this module speaks the web API, and
 * so does the web profile, which is why the feature is not desktop-only.
 *
 * Three things about that API shape this file, and all three are the kind of
 * detail that is invisible until it is wrong in front of a user:
 *
 * 1. **Permission may be `default`.** A page that has never asked may not show a
 *    banner, and Electron does not ask on its own. So the request is made from a
 *    *user gesture* — the card's own test button — and the ask is not made at
 *    plugin start, where a prompt with no context would appear before the user
 *    has any idea what is asking.
 * 2. **A notification is fire-and-forget.** Nothing can report whether the OS
 *    actually drew it, so this module reports what it *can* know: whether the
 *    constructor threw, and whether the object reported an error. A card that
 *    said "sent" about a banner the user never saw would be worse than one that
 *    says "no permission".
 * 3. **`onclick` is the whole point of a banner.** A notification that cannot
 *    take you to the session it is about is a nag. The click handler is a
 *    parameter here, never a default, because only the caller knows how to focus
 *    the right conversation.
 *
 * @module dsh-notification/system
 */

/**
 * What the system notification channel is currently able to do.
 *
 * The four cases are kept apart because they need different words in the
 * interface: the API is missing entirely, the user refused, the user has never
 * been asked, or it will work. Collapsing "refused" and "never asked" into one
 * "unavailable" is the version that leaves a user with no idea that a permission
 * prompt exists.
 *
 * @param view - the object `Notification` class hangs off, for testability.
 * @returns `{ supported, permission, canAsk }`.
 */
function permissionState(view) {
  const NotificationClass = view?.Notification
  if (typeof NotificationClass !== 'function') {
    return { supported: false, permission: 'unsupported', canAsk: false }
  }
  const permission = typeof NotificationClass.permission === 'string' ? NotificationClass.permission : 'default'
  return {
    supported: true,
    permission,
    // `requestPermission` is the only way out of `default`, and a build without
    // it (an old Electron, a hardened page) must not be offered a button that
    // cannot work.
    canAsk: permission === 'default' && typeof NotificationClass.requestPermission === 'function',
  }
}

/**
 * Ask for notification permission, from a user gesture.
 *
 * Called from the card's test button and nowhere else. The result is returned
 * rather than stored, because the class's own `permission` property is the
 * source of truth the interface reads — a cached copy is one more thing that can
 * disagree with the browser.
 *
 * @param view - the object `Notification` class hangs off.
 * @returns `{ permission }` — the permission after the ask, or the current one
 *   when asking was impossible.
 */
async function requestPermission(view) {
  const state = permissionState(view)
  if (!state.supported) return { permission: state.permission }
  if (state.permission !== 'default') return { permission: state.permission }
  const NotificationClass = view.Notification
  if (typeof NotificationClass.requestPermission !== 'function') return { permission: state.permission }
  try {
    const granted = await NotificationClass.requestPermission()
    // The return value and the property can disagree on an old implementation,
    // and the property is what the next `show` will be judged by.
    const after = typeof NotificationClass.permission === 'string' ? NotificationClass.permission : granted
    return { permission: after ?? 'default' }
  } catch (error) {
    return { permission: state.permission, error: messageOf(error) }
  }
}

/**
 * A notification's options, built from the fields this plugin actually sets.
 *
 * `silent: true` is asserted on every banner, and it is not a preference: the
 * plugin makes its own sound, with its own volume and its own voice, and an OS
 * notification that *also* plays the system chime makes the configured volume a
 * lie. On Windows the flag is honoured; where it is not, the two sounds overlap
 * and the plugin's is the one the settings describe.
 *
 * @param options - `{ title, body, tag, onClick, data }`.
 * @returns the constructor options.
 */
function notificationOptions(options) {
  const settings = {
    body: options?.body ?? '',
    silent: true,
    tag: options?.tag,
    data: options?.data,
  }
  // `undefined` values are dropped rather than passed: an explicit `tag:
  // undefined` is not the same thing as no tag on every implementation, and an
  // absent tag is what makes two banners for the same session replace each other.
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
}

/**
 * The notifier: one banner per call, with the outcome reported honestly.
 *
 * @param options - `{ view, onClick }`, where `view` is `window` by default and
 *   `onClick` receives the banner's `data` when the user clicks it.
 * @returns `{ show, permission, request, closeAll }`.
 */
function createNotifier(options = {}) {
  const view = options.view ?? globalThis
  const onClick = options.onClick
  /** The banners this plugin raised and has not seen close, so a state that
   * resolves can take its own banner away instead of leaving it on screen. */
  const live = new Set()

  const notifier = {
    /** @returns the permission state, read live from the browser each time. */
    permission() {
      return permissionState(view)
    },

    /** @returns the permission after an ask made from a user gesture. */
    request() {
      return requestPermission(view)
    },

    /**
     * Show one banner.
     * @param input - `{ title, body, tag, data }`.
     * @returns `{ shown, reason }`: whether a banner was created, and why not
     *   when it was not.
     */
    show(input) {
      const state = permissionState(view)
      if (!state.supported) return { shown: false, reason: 'unsupported' }
      if (state.permission !== 'granted') return { shown: false, reason: state.permission }
      const title = typeof input?.title === 'string' ? input.title : ''
      if (title.trim() === '') return { shown: false, reason: 'empty' }
      let banner
      try {
        banner = new view.Notification(title, notificationOptions(input))
      } catch (error) {
        // A constructor that throws is a real outcome — a platform that refuses
        // banners from this origin — and the card must be able to say so.
        return { shown: false, reason: 'threw', error: messageOf(error) }
      }
      live.add(banner)
      const release = () => live.delete(banner)
      for (const event of ['close', 'error']) {
        try {
          banner.addEventListener?.(event, release)
        } catch {
          /* a banner without addEventListener still shows; only cleanup is lost */
        }
      }
      if (typeof onClick === 'function') {
        try {
          banner.addEventListener?.('click', () => {
            release()
            onClick(input?.data, input)
          })
        } catch {
          /* the banner is up; a click that does nothing is better than no banner */
        }
      }
      return { shown: true, reason: 'shown' }
    },

    /**
     * Take down every banner this notifier raised.
     *
     * Called when the plugin is disposed and when the settings are turned off:
     * a banner left behind by a plugin that no longer exists is a click that
     * goes nowhere.
     * @returns how many were closed.
     */
    closeAll() {
      let closed = 0
      for (const banner of live) {
        try {
          banner.close()
          closed += 1
        } catch {
          /* already gone */
        }
      }
      live.clear()
      return closed
    },

    /** @returns how many banners this notifier believes are still up. */
    liveCount() {
      return live.size
    },
  }

  return notifier
}

/**
 * A short, human-readable message from a thrown value.
 * @param error - whatever was thrown.
 * @returns the message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

// ─── src/engine.js ───────────────────────────────────────────────────
/**
 * The engine: what one session-status change should actually do.
 *
 * Everything upstream of this file produces facts and everything downstream
 * performs effects, and this is the one place where a fact becomes a decision. It
 * is a pure function of its inputs — the event, the resolved settings, the
 * permission state, the clock, the last time each session spoke — which is what
 * lets the entire behaviour of the plugin be asserted as a table instead of
 * observed in a room.
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




/**
 * How high a banner's body may be before it is trimmed.
 *
 * Chosen to be shorter than what any tested platform truncates at rather than to
 * match one, because the plugin cannot see the limit and a body cut mid-word reads
 * as a bug in the plugin. {@link fitLine} breaks at a word and adds an ellipsis, so
 * the shortening is visible in the text rather than implied by the platform.
 */
const BANNER_BODY_LIMIT = 120

/**
 * What one change should do.
 *
 * @param input - the facts:
 *   - `event` — one event from the state machine: `{ kind, sessionId, title, summary, isMain, previous }`.
 *   - `settings` — resolved settings.
 *   - `counts` — how many sessions are in each state, for the `{count}` placeholder.
 *   - `stateLabel` — the state's name in the interface language.
 *   - `permission` — `{ supported, permission }` for the banner channel.
 *   - `visibility` — `{ visible, focused }` or nothing when the document cannot say.
 *   - `now` — epoch milliseconds.
 *   - `lastSpoke` — `Map<sessionId, epochMs>`, the caller's own memory.
 * @returns `{ admit, reason, sound, banner }` — the plan.
 */
function planEvent(input) {
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
    return { admit: false, reason: verdict.reason, sound: undefined, banner: undefined }
  }

  const state = settings.states[event.kind]
  const gain = stateGain(settings, event.kind)
  const voice = stateVoice(settings, event.kind)

  // The sound: two gates in series, and they answer different questions. `admit`
  // said this state is configured to make a noise at all; this says whether now is
  // a moment it may be audible. A chime admitted while the window was hidden and
  // played while the user is reading the screen is exactly the case the
  // `background` scope exists to prevent, and the two moments can differ because a
  // plan is made and then performed.
  const wantsSound = state.sound === true && settings.soundScope !== 'off'
  const mayBeAudible = soundAllowed(settings, input.visibility ?? {})
  const sound =
    wantsSound && mayBeAudible && gain > 0
      ? { melody: state.melody, voice, gain, kind: event.kind }
      : undefined

  // The banner. `permission` is read at plan time rather than at show time so the
  // plan can say *why* there is no banner, which is the difference between a card
  // that says "refused" and one that silently does nothing.
  const wantsBanner = state.notification === true && settings.desktopNotifications !== false
  const banner =
    wantsBanner && input.permission?.permission === 'granted'
      ? buildBanner(event, state, {
          counts: input.counts ?? {},
          stateLabel: input.stateLabel ?? event.kind,
          now: now ?? 0,
        })
      : undefined

  return {
    admit: true,
    reason: 'allowed',
    // A plan that says "allowed" with neither channel means the state's own
    // switches were turned off between `admit` and here — which cannot happen in
    // one pass, but is the shape a caller extending this should keep honest.
    sound,
    banner,
    suppressed: wantsBanner && banner === undefined ? input.permission?.permission ?? 'unsupported' : undefined,
  }
}

/**
 * Render a state's banner from its templates.
 *
 * The two strings are the user's, so this is where a template becomes text: the
 * session's own title and the pending question's own words fill the holes, and the
 * result is fitted to a length a desktop banner can show. A title that renders
 * empty falls back to the plugin's own name, because a banner with no heading is
 * not shown at all and a silently missing notification is the worst outcome
 * available.
 *
 * @param event - the event.
 * @param state - that state's settings.
 * @param context - `{ counts, stateLabel, now }`.
 * @returns `{ title, body, tag, data, unknown }`.
 */
function buildBanner(event, state, context) {
  const values = {
    title: event.title,
    summary: event.summary ?? '',
    state: context.stateLabel,
    count: context.counts?.[event.kind] ?? 0,
    time: clockTime(context.now ?? 0),
  }
  const title = renderTemplate(state.title, values)
  const body = renderTemplate(state.body, values)
  return {
    title: fitLine(title.text, 64) || 'Session notification',
    body: fitLine(body.text, BANNER_BODY_LIMIT),
    // The tag is per state and per session, which is what makes two banners about
    // the same session replace each other instead of stacking up — the behaviour a
    // user wants from a status channel, and the reason the OS-level `tag` exists.
    tag: `${event.kind}:${event.sessionId}`,
    data: { sessionId: event.sessionId, kind: event.kind, url: context.url },
    unknown: [...new Set([...title.unknown, ...body.unknown])],
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
function createSpeechLog() {
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
function gapElapsed(lastSoundAt, now, minGapMs) {
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
function firstAudible(plans) {
  for (let index = 0; index < plans.length; index += 1) {
    if (plans[index]?.sound !== undefined) return index
  }
  return -1
}

/**
 * Which of a burst's events should raise a banner.
 *
 * Every admitted banner, rather than one per burst: a banner is not an
 * interruption that competes with another banner the way two chimes compete, and a
 * user who has three sessions waiting is better served by three banners than by
 * one that names the first. The platform stacks or replaces them by their tags,
 * which is a decision it is better at than this plugin is.
 *
 * @param plans - the plans from {@link planEvent}.
 * @returns the indices of the plans that should raise a banner.
 */
function allBannered(plans) {
  const chosen = []
  for (let index = 0; index < plans.length; index += 1) {
    if (plans[index]?.banner !== undefined) chosen.push(index)
  }
  return chosen
}

/**
 * A one-line description of a plan, for the settings card and for the log.
 *
 * The row shows the same decision the engine makes, so a user who presses a test
 * button sees the outcome rather than a promise: "sound bell at 0.56" and "banner
 * refused (default)" are answers, and "sent" is not.
 *
 * @param plan - a plan from {@link planEvent}.
 * @param t - the translator, for the reasons that need words.
 * @returns the description.
 */
function describePlan(plan, t) {
  if (plan?.admit !== true) return `${t('notification.testResult.skipped')} (${String(plan?.reason ?? 'unknown')})`
  const parts = []
  if (plan.sound !== undefined) {
    parts.push(`${t('notification.sound')}: ${plan.sound.voice} @ ${String(Math.round(plan.sound.gain * 100))}%`)
  }
  if (plan.banner !== undefined) parts.push(`${t('notification.notification')}: ${plan.banner.title}`)
  if (parts.length === 0) parts.push(t('notification.testResult.silent'))
  return parts.join(' · ')
}
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











/**
 * The plugin's identity, substituted by `scripts/build-client.mjs` with the real
 * package name. It stamps the stylesheet this plugin owns and heads its
 * diagnostics, so a bundle mounted under another name says so.
 */
const PLUGIN_ID = "@citisen/dsh-notification"

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
 * makes the instance, whose own `getSnapshot`, `subscribe` and `actions` are what a
 * non-React caller uses. The **handle** is what the slot registry takes as a store
 * seat, and the renderer synthesizes the selector hook from it. So this returns both
 * — and reading through `getSnapshot`/`actions` rather than through a projection is
 * what keeps the requirement discoverable: a projection would silently depend on
 * `create()` happening to expose the actions at its top level, which it does not.
 *
 * @returns `{ handle, getSnapshot, sync, setCounts }`.
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
  const instance = handle.create()
  return {
    handle,
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
const inject = ['slots', 'locale', 'configForms', 'sessions', 'uiSession']

/**
 * Client plugin body: resolve the configuration, watch every session, and register
 * the settings row that configures what watching means.
 *
 * @param ctx - client cordis context.
 */
function apply(ctx) {
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
          hooks: { notification: store.handle },
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
		exports.apply = apply;
		exports.inject = inject;
		exports.NOTIFICATION_NAMESPACE = NOTIFICATION_NAMESPACE;
		exports.LOCALE_NAMESPACE = LOCALE_NAMESPACE;
		exports.PLUGIN_ID = PLUGIN_ID;
		exports.ROW_CSS = ROW_CSS;
		exports.zh = zh;
		exports.en = en;
		exports.MESSAGE_KEYS = MESSAGE_KEYS;
		exports.createRowStore = createRowStore;
		exports.readSources = readSources;
		exports.readVisibility = readVisibility;
		exports.focusSession = focusSession;
		exports.installStyles = installStyles;
		exports.installEngine = installEngine;
		exports.STATE_KINDS = STATE_KINDS;
		exports.OBSERVED_KINDS = OBSERVED_KINDS;
		exports.BLOCKING_KINDS = BLOCKING_KINDS;
		exports.stateOf = stateOf;
		exports.sessionTitle = sessionTitle;
		exports.interactionSummary = interactionSummary;
		exports.observe = observe;
		exports.tally = tally;
		exports.diffStatus = diffStatus;
		exports.firstOf = firstOf;
		exports.createFailureLog = createFailureLog;
		exports.VOICES = VOICES;
		exports.VOICE_NAMES = VOICE_NAMES;
		exports.DEFAULT_VOICE = DEFAULT_VOICE;
		exports.DEFAULT_NOTE_MS = DEFAULT_NOTE_MS;
		exports.DEFAULT_STAGGER_MS = DEFAULT_STAGGER_MS;
		exports.RELEASE_MS = RELEASE_MS;
		exports.SILENCE = SILENCE;
		exports.noteFrequency = noteFrequency;
		exports.parseLength = parseLength;
		exports.readMelody = readMelody;
		exports.melodyLengthMs = melodyLengthMs;
		exports.readVoice = readVoice;
		exports.schedule = schedule;
		exports.periodicWave = periodicWave;
		exports.createPlayer = createPlayer;
		exports.permissionState = permissionState;
		exports.requestPermission = requestPermission;
		exports.notificationOptions = notificationOptions;
		exports.createNotifier = createNotifier;
		exports.BANNER_BODY_LIMIT = BANNER_BODY_LIMIT;
		exports.planEvent = planEvent;
		exports.buildBanner = buildBanner;
		exports.createSpeechLog = createSpeechLog;
		exports.gapElapsed = gapElapsed;
		exports.firstAudible = firstAudible;
		exports.allBannered = allBannered;
		exports.describePlan = describePlan;
		exports.SOUND_SCOPES = SOUND_SCOPES;
		exports.STATE_FIELDS = STATE_FIELDS;
		exports.GLOBAL_FIELDS = GLOBAL_FIELDS;
		exports.STATE_DEFAULTS = STATE_DEFAULTS;
		exports.GLOBAL_DEFAULTS = GLOBAL_DEFAULTS;
		exports.SETTINGS_VERSION = SETTINGS_VERSION;
		exports.coerceField = coerceField;
		exports.resolveSettings = resolveSettings;
		exports.defaultSection = defaultSection;
		exports.admit = admit;
		exports.soundAllowed = soundAllowed;
		exports.stateGain = stateGain;
		exports.stateVoice = stateVoice;
		exports.TEMPLATE_FIELDS = TEMPLATE_FIELDS;
		exports.renderTemplate = renderTemplate;
		exports.unknownFields = unknownFields;
		exports.fitLine = fitLine;
		exports.clockTime = clockTime;
		return module.exports;
	}
});
