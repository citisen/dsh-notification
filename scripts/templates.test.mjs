/**
 * Unit tests for the notification text: the template vocabulary and honest
 * length handling.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { TEMPLATE_FIELDS, clockTime, fitLine, renderTemplate, unknownFields } from '../src/templates.js'

test('a template fills its named holes', () => {
  const { text, unknown } = renderTemplate('{title} needs an answer', { title: 'Refactor the parser' })
  assert.equal(text, 'Refactor the parser needs an answer')
  assert.deepEqual(unknown, [])
})

test('every documented field is reachable, so the card lists exactly the vocabulary', () => {
  const context = {
    title: 'T',
    summary: 'S',
    state: 'Waiting',
    count: 3,
    time: '09:15',
  }
  for (const field of TEMPLATE_FIELDS) {
    const { text } = renderTemplate(`{${field.name}}`, context)
    assert.notEqual(text, `{${field.name}}`, `${field.name} must be a known field`)
    assert.ok(text.length > 0)
  }
  assert.equal(TEMPLATE_FIELDS.length, Object.keys(context).length)
})

test('an unknown placeholder is left visible and reported, never silently dropped', () => {
  const { text, unknown } = renderTemplate('{title} — {wat}', { title: 'X' })
  // Visible, because a gap in the sentence looks like the plugin's own wording
  // and nobody reports it as a bug.
  assert.equal(text, 'X — {wat}')
  assert.deepEqual(unknown, ['wat'])
  assert.deepEqual(unknownFields('{a} {b} {a}'), ['a', 'b'])
})

test('a known field with no value renders as nothing rather than as undefined', () => {
  assert.equal(renderTemplate('a{summary}b', { summary: undefined }).text, 'ab')
  assert.equal(renderTemplate('a{summary}b', { summary: null }).text, 'ab')
})

test('a number and a string are both usable as a value', () => {
  assert.equal(renderTemplate('{count} waiting', { count: 3 }).text, '3 waiting')
  assert.equal(renderTemplate('{count} waiting', { count: '3' }).text, '3 waiting')
})

test('a template with no placeholders is returned unchanged', () => {
  assert.equal(renderTemplate('Nothing to report', {}).text, 'Nothing to report')
  assert.equal(renderTemplate('', {}).text, '')
  assert.equal(renderTemplate(undefined, {}).text, '')
})

test('fitLine collapses whitespace, keeps short text, and breaks at a word', () => {
  assert.equal(fitLine('a  b\n c'), 'a b c')
  assert.equal(fitLine('short', 20), 'short')
  const long = fitLine('the quick brown fox jumps over the lazy dog', 20)
  assert.ok(long.length <= 20, `'${long}' must fit in 20 characters`)
  assert.ok(long.endsWith('…'))
  assert.ok(!long.slice(0, -1).endsWith(' '), 'no space before the ellipsis')
  // A single token with no boundary to break on is cut rather than discarded.
  const token = fitLine('a'.repeat(40), 20)
  assert.equal(token.length, 20)
})

test('clockTime is HH:MM from a supplied clock', () => {
  const noon = new Date(2026, 0, 2, 9, 5, 0).getTime()
  assert.equal(clockTime(noon), '09:05')
  const late = new Date(2026, 0, 2, 23, 59, 0).getTime()
  assert.equal(clockTime(late), '23:59')
})
