/**
 * Unit tests for the pure half of the sound module.
 *
 * `scripts/verify-client.mjs` drives the *emitted bundle*, which is the check
 * that the build and the plugin's own wiring are intact. This file is the other
 * half of the pair: it tests the module directly, so a wrong frequency or a
 * wrong envelope point is reported as the arithmetic mistake it is instead of
 * as a failure somewhere downstream of a bundle envelope.
 *
 * Usage:  node --test scripts/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_NOTE_MS,
  DEFAULT_STAGGER_MS,
  DEFAULT_VOICE,
  SILENCE,
  VOICES,
  VOICE_NAMES,
  createPlayer,
  melodyLengthMs,
  noteFrequency,
  parseLength,
  periodicWave,
  readMelody,
  readVoice,
  schedule,
} from '../src/sound.js'

/** How close two floats must be to be the same pitch, in Hz. */
const HZ_TOLERANCE = 0.01

/** Assert two numbers are within a tolerance. @param actual @param expected @param tolerance */
function close(actual, expected, tolerance = HZ_TOLERANCE) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${String(actual)} to be within ${String(tolerance)} of ${String(expected)}`,
  )
}

test('noteFrequency reads the equal-tempered scale against A4 = 440', () => {
  close(noteFrequency('A4'), 440)
  close(noteFrequency('A5'), 880)
  close(noteFrequency('A3'), 220)
  close(noteFrequency('C4'), 261.6256)
  close(noteFrequency('C5'), 523.2511)
  close(noteFrequency('C#4'), 277.1826)
  close(noteFrequency('Db4'), 277.1826, 0.02)
  close(noteFrequency('Bb3'), 233.0819)
  close(noteFrequency('G4'), 391.9954)
})

test('a sharp and its flat spelling are the same pitch', () => {
  for (const [sharp, flat] of [
    ['C#4', 'Db4'],
    ['D#4', 'Eb4'],
    ['F#4', 'Gb4'],
    ['G#4', 'Ab4'],
    ['A#4', 'Bb4'],
  ]) {
    close(noteFrequency(sharp), noteFrequency(flat), 0.0001)
  }
})

test('noteFrequency is case-insensitive and accepts negative octaves', () => {
  close(noteFrequency('a4'), 440)
  close(noteFrequency('A-1'), 13.75)
})

test('noteFrequency refuses what is not a note name', () => {
  for (const token of ['H5', 'A', 'A5x', '', 'A#', '5A', '880']) {
    assert.equal(noteFrequency(token), undefined, `'${token}' must not be a note`)
  }
})

test('parseLength reads units, defaults to seconds, and refuses the out of range', () => {
  assert.equal(parseLength('200ms'), 200)
  assert.equal(parseLength('1.5s'), 1500)
  assert.equal(parseLength('2m'), 120_000 > 30_000 ? undefined : 120_000)
  assert.equal(parseLength('0.5'), 500)
  assert.equal(parseLength('300'), 300_000 > 30_000 ? undefined : 300_000)
  assert.equal(parseLength(''), undefined)
  assert.equal(parseLength('fast'), undefined)
  assert.equal(parseLength('0ms'), undefined)
  assert.equal(parseLength('99s'), undefined)
})

test('a melody of bare notes uses the shipped pacing and overlaps', () => {
  const read = readMelody('A5 E6')
  assert.deepEqual(read.problems, [])
  assert.equal(read.notes.length, 2)
  assert.equal(read.notes[0].startMs, 0)
  assert.equal(read.notes[0].durationMs, DEFAULT_NOTE_MS)
  assert.equal(read.notes[1].startMs, DEFAULT_STAGGER_MS)
  // The point of the shipped pair: the second note starts before the first ends,
  // so the two read as one interval rather than as two separate knocks.
  assert.ok(read.notes[1].startMs < read.notes[0].durationMs)
})

test('a melody with written lengths is a rhythm: each item starts when the last ends', () => {
  const read = readMelody('A5:200ms E6:200ms')
  assert.deepEqual(read.problems, [])
  assert.equal(read.notes[0].startMs, 0)
  assert.equal(read.notes[0].durationMs, 200)
  assert.equal(read.notes[1].startMs, 200)
  assert.equal(read.notes[1].durationMs, 200)
  assert.equal(melodyLengthMs(read.notes), 400)
})

test('a rest occupies its time and sounds nothing', () => {
  const read = readMelody('A5:120ms -:80ms E6:240ms')
  assert.deepEqual(read.problems, [])
  assert.equal(read.notes[1].frequency, undefined)
  assert.equal(read.notes[1].startMs, 120)
  assert.equal(read.notes[2].startMs, 200)
  assert.equal(melodyLengthMs(read.notes), 440)
  // A rest is not silence for the melody: two of the three items still sound.
  assert.equal(read.silent, false)
})

test('a melody of nothing but rests is silent', () => {
  const read = readMelody('-:100ms -:100ms')
  assert.equal(read.silent, true)
})

test('off and an empty melody are silent, without problems', () => {
  for (const text of ['off', 'OFF', '  ', '', undefined, null]) {
    const read = readMelody(text)
    assert.equal(read.silent, true)
    assert.deepEqual(read.notes, [])
    assert.deepEqual(read.problems, [])
  }
})

test('a bare number is a frequency in Hz', () => {
  const read = readMelody('880 1318.5:200ms')
  assert.deepEqual(read.problems, [])
  close(read.notes[0].frequency, 880)
  close(read.notes[1].frequency, 1318.5)
  assert.equal(read.notes[1].durationMs, 200)
})

test('one bad token is reported and the rest of the melody survives', () => {
  const read = readMelody('A5 H5:200ms E6')
  assert.equal(read.problems.length, 1)
  assert.equal(read.problems[0].token, 'H5:200ms')
  // The reader is total: the typo costs its own item and nothing else.
  assert.equal(read.notes.length, 2)
  assert.deepEqual(
    read.notes.map((note) => note.label),
    ['A5', 'E6'],
  )
})

test('an unreadable length is reported as a length problem, not as a bad note', () => {
  const read = readMelody('A5:soon')
  assert.equal(read.problems.length, 1)
  assert.match(read.problems[0].message, /length/u)
  assert.equal(read.notes.length, 0)
})

test('commas separate tokens as well as spaces', () => {
  const read = readMelody('A5, E6, G5')
  assert.deepEqual(read.problems, [])
  assert.equal(read.notes.length, 3)
})

test('the shipped classical phrases parse with no problems', () => {
  const phrase = 'G4:170ms G4:170ms G4:170ms Eb4:680ms'
  const read = readMelody(phrase)
  assert.deepEqual(read.problems, [])
  assert.equal(read.notes.length, 4)
  assert.equal(melodyLengthMs(read.notes), 1190)
  close(read.notes[3].frequency, 311.127)
})

test('every voice is readable and the unknown name falls back', () => {
  for (const name of VOICE_NAMES) {
    const voice = readVoice(name)
    assert.equal(voice.name, name)
    assert.ok(voice.shape !== undefined || voice.partials !== undefined)
  }
  assert.equal(readVoice('tuba').name, DEFAULT_VOICE)
  assert.equal(readVoice(undefined).name, DEFAULT_VOICE)
})

test('every voice declares a distinct label and a hint', () => {
  const labels = new Set()
  for (const [name, voice] of Object.entries(VOICES)) {
    assert.equal(typeof voice.label, 'string', `${name} needs a label`)
    assert.equal(typeof voice.hint, 'string', `${name} needs a hint`)
    assert.ok(!labels.has(voice.label), `${name} reuses the label ${voice.label}`)
    labels.add(voice.label)
  }
})

test('schedule places every note at its absolute time and shapes its envelope', () => {
  const read = readMelody('A5:200ms -:50ms E6:100ms')
  const plan = schedule(read.notes, 'bell', { gain: 0.5, startAt: 10 })
  assert.equal(plan.events.length, 2, 'a rest schedules nothing')
  const [first, second] = plan.events
  assert.equal(first.startedAt, 10)
  assert.equal(first.frequency, 880)
  assert.equal(first.gain, 0.5)
  // The rest occupies 50ms, so the second note starts 250ms after the first.
  assert.equal(second.startedAt, 10.25)
  assert.ok(first.attackEndsAt > first.startedAt, 'the attack must ramp up, never gate')
  assert.ok(first.decayEndsAt > first.attackEndsAt, 'the decay must follow the attack')
  assert.ok(first.stopsAt > first.decayEndsAt, 'the stop must follow the decay')
})

test('a percussive voice decays faster than a ringing one, for the same note', () => {
  const read = readMelody('A4:1000ms')
  const wood = schedule(read.notes, 'wood', { gain: 1 }).events[0]
  const bell = schedule(read.notes, 'bell', { gain: 1 }).events[0]
  assert.ok(
    wood.decayEndsAt - wood.startedAt < bell.decayEndsAt - bell.startedAt,
    'a wood block must not ring as long as a bell',
  )
})

test('a bare waveform voice holds its level and is shaped only by the release', () => {
  const read = readMelody('A4:500ms')
  const event = schedule(read.notes, 'sine', { gain: 1 }).events[0]
  // This is what keeps an existing melody sounding the way it always did: a
  // note with a length and no decay envelope sounds for exactly that length.
  assert.equal(event.decayEndsAt - event.startedAt, 0.5)
  assert.equal(event.partials, undefined)
  assert.equal(event.shape, 'sine')
})

test('schedule refuses nothing and tolerates an empty melody', () => {
  const plan = schedule([], 'bell', { gain: 1 })
  assert.deepEqual(plan.events, [])
  assert.equal(plan.durationMs, 0)
  const off = schedule(readMelody('off').notes, 'bell', { gain: 1 })
  assert.deepEqual(off.events, [])
})

test('periodicWave builds the harmonics the partials name, and nothing else', () => {
  let captured
  const context = {
    sampleRate: 48_000,
    createPeriodicWave: (real, imaginary, options) => {
      captured = { real, imaginary, options }
      return { kind: 'periodic' }
    },
  }
  const wave = periodicWave(context, [
    [1, 1],
    [2.01, 0.5],
    [2.76, 0.28],
    [5.4, 0.14],
  ])
  assert.deepEqual(wave, { kind: 'periodic' })
  // The coefficients travel as Float32, so a literal 0.28 reads back as
  // 0.2800000011920929. Comparing them exactly would be a test about float
  // representation rather than about which partials a voice names.
  close(captured.imaginary[1], 1, 1e-6)
  close(captured.imaginary[2], 0.5, 1e-6)
  close(captured.imaginary[3], 0.28, 1e-6)
  close(captured.imaginary[5], 0.14, 1e-6)
  assert.equal(captured.imaginary[4], 0, 'a partial nobody named must stay silent')
  // A partial is a sine, so the cosine half carries nothing at all.
  assert.ok(captured.real.every((value) => value === 0))
})

test('periodicWave answers undefined for a bare waveform or an unusable partial set', () => {
  const context = { sampleRate: 48_000, createPeriodicWave: () => ({ kind: 'periodic' }) }
  assert.equal(periodicWave(context, undefined), undefined)
  assert.equal(periodicWave(context, []), undefined)
  assert.equal(periodicWave(context, [[0, 0]]), undefined)
})

test('createPlayer schedules through a fake context and reports its own state', () => {
  const started = []
  const gains = []
  const waveBuilds = []
  const fake = function FakeContext() {
    this.state = 'running'
    this.currentTime = 3
    this.sampleRate = 48_000
    this.destination = { kind: 'destination' }
    this.closed = false
    this.resumed = 0
    this.createGain = () => {
      const node = {
        kind: 'gain',
        gain: { value: 1, setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined, exponentialRampToValueAtTime: () => undefined },
        connect: () => undefined,
      }
      gains.push(node)
      return node
    }
    this.createPeriodicWave = (real, imaginary) => {
      waveBuilds.push(Array.from(imaginary))
      return { kind: 'periodic' }
    }
    this.createOscillator = () => {
      const node = {
        kind: 'oscillator',
        type: 'sine',
        usedWave: false,
        frequency: { setValueAtTime: () => undefined },
        setPeriodicWave: () => {
          node.usedWave = true
        },
        connect: () => undefined,
        start: (at) => started.push(at),
        stop: () => undefined,
      }
      oscillators.push(node)
      return node
    }
    this.createBiquadFilter = () => ({
      type: 'lowpass',
      frequency: { setValueAtTime: () => undefined },
      connect: () => undefined,
    })
    this.close = () => {
      this.closed = true
      return Promise.resolve()
    }
  }
  fake.prototype.resume = function resume() {
    this.resumed += 1
    return Promise.resolve()
  }

  const oscillators = []
  const player = createPlayer({ AudioContextClass: fake, master: 0.5 })
  assert.deepEqual(player.state(), { available: true, state: 'uninitialized', master: 0.5 })

  assert.equal(player.play('A5:200ms E6:200ms', 'bell', 0.8), true)
  assert.equal(started.length, 2)
  assert.equal(started[0], 3)
  assert.equal(started[1], 3.2)
  // The context plus one envelope node per note.
  assert.equal(gains.length, 3)
  // A partial voice plays through a built wave, and the wave is built once for
  // the melody even though both notes use it — that reuse is the reason the
  // player caches by partial set.
  assert.equal(waveBuilds.length, 1)
  assert.ok(oscillators.every((node) => node.usedWave))

  // A bare waveform reaches `oscillator.type` instead, and builds no wave.
  assert.equal(player.play('A5', 'sine', 1), true)
  assert.equal(waveBuilds.length, 1)
  assert.equal(oscillators.at(-1).usedWave, false)
  assert.equal(oscillators.at(-1).type, 'sine')

  player.setMaster(0.25)
  assert.equal(player.state().master, 0.25)
  assert.equal(player.state().state, 'running')

  player.dispose()
  assert.equal(player.state().state, 'uninitialized')
})

test('a silent melody schedules nothing, and a suspended context refuses to play', () => {
  const suspended = function Suspended() {
    this.state = 'suspended'
    this.currentTime = 0
    this.sampleRate = 48_000
    this.destination = {}
    this.createGain = () => ({ gain: { value: 1 }, connect: () => undefined })
  }
  suspended.prototype.resume = () => Promise.resolve()
  const player = createPlayer({ AudioContextClass: suspended })
  assert.equal(player.play('A5', 'bell', 1), false, 'a suspended context must drop the chime')
  assert.equal(player.play('off', 'bell', 1), false)
})

test('a player with no Web Audio at all still reports itself and never throws', () => {
  const player = createPlayer({})
  assert.equal(player.state().available, false)
  assert.equal(player.play('A5', 'bell', 1), false)
  player.resume()
  player.setMaster(0.3)
  player.dispose()
  assert.equal(player.state().master, 0.3)
})

test('SILENCE is small enough to be inaudible and large enough to ramp toward', () => {
  assert.ok(SILENCE > 0)
  assert.ok(SILENCE < 0.001)
})
