/**
 * Unit tests for the state machine: what every session is doing, and which
 * changes are worth a sound.
 *
 * The transitions here are the plugin's entire notion of "something happened",
 * so they are asserted as a table rather than exercised through the interface.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BLOCKING_KINDS,
  OBSERVED_KINDS,
  STATE_KINDS,
  createFailureLog,
  diffStatus,
  firstOf,
  interactionSummary,
  observe,
  sessionTitle,
  stateOf,
  tally,
} from '../src/states.js'

/**
 * A `sessionStatus` snapshot from plain entries.
 * @param entries - `[id, entry]` pairs.
 * @returns a `Map`, the shape the real observable publishes.
 */
function status(entries) {
  return new Map(entries)
}

/**
 * A `sessions.list` snapshot from plain rows.
 * @param rows - `[id, row]` pairs.
 * @returns `{ phase, ids, byId }`.
 */
function list(rows) {
  return {
    phase: 'ready',
    ids: rows.map(([id]) => id),
    byId: Object.fromEntries(rows.map(([id, row]) => [id, row ?? {}])),
  }
}

test('a running session reads as running', () => {
  assert.equal(stateOf({ running: true, pendingInteraction: undefined, completionUnread: false }), 'running')
})

test('a pending interaction outranks running', () => {
  // The precedence that matters most: the running part is not the part that
  // needs the user, so the state must be the question.
  assert.equal(
    stateOf({ running: true, pendingInteraction: { kind: 'question' }, completionUnread: false }),
    'question',
  )
  assert.equal(
    stateOf({ running: true, pendingInteraction: { kind: 'approval' }, completionUnread: false }),
    'approval',
  )
})

test('every known pending kind maps to its own state', () => {
  assert.equal(stateOf({ pendingInteraction: { kind: 'question' } }), 'question')
  assert.equal(stateOf({ pendingInteraction: { kind: 'approval' } }), 'approval')
  assert.equal(stateOf({ pendingInteraction: { kind: 'plan-review' } }), 'plan')
})

test('an unknown pending kind still blocks rather than falling silent', () => {
  // A build that ignored a future kind would be quiet exactly when a person was
  // being asked for something.
  assert.equal(stateOf({ pendingInteraction: { kind: 'brand-new-kind' } }), 'question')
  assert.equal(stateOf({ pendingInteraction: 'question' }), 'question')
})

test('completionUnread reads as done', () => {
  assert.equal(stateOf({ running: false, completionUnread: true }), 'done')
  // A running session is running, whatever else the entry says: `failed` is not
  // a field the status entry carries, so a stray one must not be believed.
  assert.equal(stateOf({ running: true, failed: true }), 'running')
})

test('a session doing nothing has no state', () => {
  for (const entry of [
    { running: false, completionUnread: false },
    { running: undefined, pendingInteraction: undefined, completionUnread: false },
    {},
    undefined,
  ]) {
    assert.equal(stateOf(entry), undefined)
  }
})

test('a blank session is not information and is left out entirely', () => {
  const observed = observe(status([['a', { running: true }]]), list([['a', { blank: true }]]))
  assert.equal(observed.byId.size, 0)
  assert.deepEqual(observed.order, [])
})

test('an idle session is recorded as a state, not left out', () => {
  // This is the distinction the caller depends on: an idle session that starts
  // running is a change, while a session the plugin has never seen is not.
  const observed = observe(status([['a', {}]]), list([['a', {}]]))
  assert.equal(observed.byId.size, 1)
  assert.equal(observed.byId.get('a').kind, 'idle')
  assert.deepEqual(observed.order, ['a'])
})

test('observe keeps the list order and the facts a policy layer needs', () => {
  const observed = observe(
    status([
      ['a', { running: true }],
      ['b', { pendingInteraction: { kind: 'question', text: 'Which file?' } }],
      ['c', { completionUnread: true }],
    ]),
    list([
      ['a', { title: 'Refactor the parser' }],
      ['b', { title: 'Deploy' }],
      ['c', { title: 'Review', retainedBy: { mainView: 1 } }],
    ]),
  )
  assert.deepEqual(observed.order, ['a', 'b', 'c'])
  assert.equal(observed.byId.get('a').kind, 'running')
  assert.equal(observed.byId.get('b').title, 'Deploy')
  assert.equal(observed.byId.get('b').summary, 'Which file?')
  assert.equal(observed.byId.get('c').isMain, true)
  assert.equal(observed.byId.get('b').isMain, false)
})

test('a session whose row is missing still gets a usable label', () => {
  const observed = observe(
    status([['session-4f2ab19c-0000', { running: true }]]),
    list([['session-4f2ab19c-0000', {}]]),
  )
  assert.equal(observed.byId.get('session-4f2ab19c-0000').title, 'Session 4f2ab19c')
})

test('sessionTitle reads the spellings that have existed and prefers a real title', () => {
  // The pair that actually ships: `title` is the durable one and is present only
  // once the title projection holds something; `displayTitle` is always present
  // but is synthesized from the workspace directory or the id.
  assert.equal(sessionTitle({ title: 'Refactor the parser', displayTitle: 'dsh-notification' }, 'id'), 'Refactor the parser')
  assert.equal(sessionTitle({ displayTitle: 'dsh-notification' }, 'id'), 'dsh-notification')
  assert.equal(sessionTitle({ label: 'B' }, 'id'), 'B')
  assert.equal(sessionTitle({ name: 'C' }, 'id'), 'C')
  assert.equal(sessionTitle({ title: '   ', displayTitle: 'Fallback' }, 'id'), 'Fallback')
  assert.equal(sessionTitle({ title: '   ' }, 'id'), 'Session id')
  assert.equal(sessionTitle(undefined, 'session-abcd1234efgh'), 'Session abcd1234')
})

test('interactionSummary reads a question out of the questions array', () => {
  // A question's text lives on the first item of `questions`, not on the
  // interaction itself — the spelling that a plausible guess gets wrong.
  assert.equal(
    interactionSummary({
      pendingInteraction: { kind: 'question', questions: [{ id: '1', question: 'Which\n  file   exactly?' }] },
    }),
    'Which file exactly?',
  )
  assert.equal(
    interactionSummary({
      pendingInteraction: { kind: 'question', questions: [{ question: 'A' }, { question: 'B' }, { question: 'C' }] },
    }),
    'A (+2 more)',
  )
  // A plan review's question is often a heading, with the substance in `detail`.
  assert.equal(
    interactionSummary({ pendingInteraction: { kind: 'plan-review', questions: [{ question: '', detail: 'Step one' }] } }),
    'Step one',
  )
})

test('interactionSummary reads an approval out of its own fields', () => {
  assert.equal(
    interactionSummary({ pendingInteraction: { kind: 'approval', displayReason: 'wants to run rm -rf' } }),
    'wants to run rm -rf',
  )
  assert.equal(
    interactionSummary({ pendingInteraction: { kind: 'approval', toolName: 'Bash' } }),
    'Bash',
  )
})

test('interactionSummary answers nothing for an interaction with no text', () => {
  assert.equal(interactionSummary({ pendingInteraction: { kind: 'question' } }), undefined)
  assert.equal(interactionSummary({ pendingInteraction: 'question' }), undefined)
  assert.equal(interactionSummary({}), undefined)
})

test('the failure log remembers an error until the session moves', () => {
  const failures = createFailureLog()
  assert.equal(failures.size(), 0)
  failures.record('a', 'boom', 1000)
  assert.equal(failures.has('a'), true)
  assert.deepEqual(failures.get('a'), { at: 1000, message: 'boom' })
  assert.equal(failures.clear('a'), true)
  assert.equal(failures.has('a'), false)
  assert.equal(failures.clear('a'), false)
})

test('the failure log refuses an empty id and keeps the newest first', () => {
  const failures = createFailureLog()
  failures.record('', 'x', 1)
  failures.record(undefined, 'x', 1)
  assert.equal(failures.size(), 0)
  failures.record('old', 'x', 10)
  failures.record('new', 'y', 20)
  assert.deepEqual(failures.ids(), ['new', 'old'])
})

test('the failure log drops sessions that are gone', () => {
  const failures = createFailureLog()
  failures.record('a', 'x', 1)
  failures.record('b', 'y', 1)
  failures.retainOnly(['b'])
  assert.deepEqual(failures.ids(), ['b'])
})

test('a recorded failure shows as the failed state', () => {
  const failures = createFailureLog()
  failures.record('a', 'boom', 1000)
  const observed = observe(status([['a', {}]]), list([['a', { title: 'Deploy' }]]), failures)
  assert.equal(observed.byId.get('a').kind, 'failed')
  assert.equal(observed.byId.get('a').failure.message, 'boom')
  // Without a log the same session is simply idle: the status entry carries no
  // failure bit, which is the whole reason the log exists.
  assert.equal(observe(status([['a', {}]]), list([['a', {}]])).byId.get('a').kind, 'idle')
})

test('a live question outranks a recorded failure, but a stray running bit does not', () => {
  const failures = createFailureLog()
  failures.record('a', 'boom', 1000)
  failures.record('b', 'boom', 1000)
  const observed = observe(
    status([
      ['a', { pendingInteraction: { kind: 'question', questions: [{ question: 'Now what?' }] } }],
      ['b', { running: true }],
    ]),
    list([['a', {}], ['b', {}]]),
    failures,
  )
  assert.equal(observed.byId.get('a').kind, 'question', 'a live ask is where attention belongs')
  assert.equal(observed.byId.get('b').kind, 'failed', 'a retry is not the news the error is')
})

test('a failure that clears produces an edge back to idle', () => {
  const failures = createFailureLog()
  const before = observe(status([['a', {}]]), list([['a', {}]]))
  failures.record('a', 'boom', 1000)
  const failed = observe(status([['a', {}]]), list([['a', {}]]), failures)
  assert.deepEqual(
    diffStatus(before, failed).map((event) => event.kind),
    ['failed'],
  )
  failures.clear('a')
  const cleared = observe(status([['a', {}]]), list([['a', {}]]), failures)
  // Back to idle is a state change with no event, which is what makes the next
  // failure able to fire again.
  assert.deepEqual(diffStatus(failed, cleared), [])
})

test('tally counts every state kind, including the empty ones', () => {
  const observed = observe(
    status([
      ['a', { running: true }],
      ['b', { running: true }],
      ['c', { completionUnread: true }],
      ['d', {}],
    ]),
    list([['a', {}], ['b', {}], ['c', {}], ['d', {}]]),
  )
  const counts = tally(observed)
  assert.deepEqual(counts, {
    question: 0,
    approval: 0,
    plan: 0,
    failed: 0,
    done: 1,
    running: 2,
  })
  // An idle session contributes to no card, which is what keeps "4 sessions
  // open" from reading as four things needing attention.
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 3)
})

test('a session that starts a turn fires the running edge, and one that never existed does not', () => {
  const known = observe(status([['a', {}]]), list([['a', { title: 'Deploy' }]]))
  const started = observe(status([['a', { running: true }]]), list([['a', { title: 'Deploy' }]]))
  assert.deepEqual(
    diffStatus(known, started).map((event) => event.kind),
    ['running'],
  )

  const created = observe(status([['b', { running: true }]]), list([['b', { title: 'New' }]]))
  assert.deepEqual(diffStatus(known, created), [], 'a session the plugin never saw is not news')
  assert.deepEqual(diffStatus(undefined, created), [], 'nor is the first observation at all')
})

test('the first observation is a baseline and produces no events', () => {
  const first = observe(status([['a', { running: true }]]), list([['a', {}]]))
  assert.deepEqual(diffStatus(undefined, first), [])
})

test('an unchanged state produces no event, however often it is observed', () => {
  const first = observe(status([['a', { running: true }]]), list([['a', {}]]))
  const second = observe(status([['a', { running: true }]]), list([['a', {}]]))
  assert.deepEqual(diffStatus(first, second), [])
  // The bug this pins: a notification that re-reads the level instead of the
  // edge chimes again on every unrelated store notification.
  assert.deepEqual(diffStatus(second, first), [])
})

test('a session created while the plugin runs is new, not a change into a state', () => {
  const before = observe(status([['a', { running: true }]]), list([['a', {}]]))
  const after = observe(
    status([
      ['a', { running: true }],
      ['b', { pendingInteraction: { kind: 'question' } }],
    ]),
    list([['a', {}], ['b', {}]]),
  )
  assert.deepEqual(diffStatus(before, after), [])
})

test('each transition is reported once, with the state it came from', () => {
  const idle = observe(status([['a', {}]]), list([['a', {}]]))
  const running = observe(status([['a', { running: true }]]), list([['a', {}]]))
  const waiting = observe(
    status([['a', { running: true, pendingInteraction: { kind: 'question', text: 'Which?' } }]]),
    list([['a', { title: 'Deploy' }]]),
  )
  const answered = observe(status([['a', { running: true }]]), list([['a', { title: 'Deploy' }]]))
  const finished = observe(
    status([['a', { running: false, completionUnread: true }]]),
    list([['a', { title: 'Deploy' }]]),
  )

  assert.deepEqual(
    diffStatus(idle, running).map((event) => [event.kind, event.previous]),
    [['running', 'idle']],
  )
  assert.deepEqual(
    diffStatus(running, waiting).map((event) => [event.kind, event.previous]),
    [['question', 'running']],
  )
  // Back to running is an edge too: the user answered.
  assert.deepEqual(
    diffStatus(waiting, answered).map((event) => [event.kind, event.previous]),
    [['running', 'question']],
  )
  const done = diffStatus(answered, finished)
  assert.deepEqual(
    done.map((event) => [event.kind, event.previous]),
    [['done', 'running']],
  )
  // The event carries the facts a notification renders, not a rendered string.
  assert.equal(done[0].title, 'Deploy')
  assert.equal(done[0].sessionId, 'a')
})

test('a burst of completions is ordered most urgent first', () => {
  const before = observe(
    status([
      ['a', { running: true }],
      ['b', { running: true }],
      ['c', { running: true }],
    ]),
    list([['a', {}], ['b', {}], ['c', {}]]),
  )
  const after = observe(
    status([
      ['a', { running: false, completionUnread: true }],
      ['b', { pendingInteraction: { kind: 'approval' } }],
      ['c', { pendingInteraction: { kind: 'question' } }],
    ]),
    list([['a', {}], ['b', {}], ['c', {}]]),
  )
  assert.deepEqual(
    diffStatus(before, after).map((event) => event.kind),
    ['question', 'approval', 'done'],
  )
})

test('one sound per burst is the first eligible event', () => {
  const events = [{ kind: 'question' }, { kind: 'done' }]
  assert.equal(firstOf(events).kind, 'question')
  assert.equal(firstOf([]), undefined)
  assert.equal(firstOf(undefined), undefined)
})

test('the state roster and the blocking group stay consistent', () => {
  for (const kind of BLOCKING_KINDS) {
    assert.ok(STATE_KINDS.includes(kind), `${kind} must be a card`)
  }
  // Most urgent first, which is the order a burst is thinned in.
  assert.deepEqual(STATE_KINDS.slice(0, 3), ['question', 'approval', 'plan'])
  assert.equal(STATE_KINDS.at(-1), 'running')
  // Idle is observable but is not a card: a state every session is in most of
  // the time is not something anyone wants a setting for.
  assert.ok(OBSERVED_KINDS.includes('idle'))
  assert.ok(!STATE_KINDS.includes('idle'))
})
