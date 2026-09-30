/**
 * Analyze a melody: what it will sound like, without listening to it.
 *
 * This exists because of *how* the melodies for this plugin get written. A
 * notification sound is the one setting nobody can iterate on by ear in a chat
 * window, and the failure mode of a generated melody is not a crash — it is a
 * chime that is too long, too loud, in the wrong octave, or rhythmically not what
 * was intended, discovered minutes later by a person who was interrupted. So the
 * reader and the scheduler are exposed as a command that answers those questions
 * as text and as JSON:
 *
 *     node scripts/analyze-sound.mjs "G4:170ms G4:170ms G4:170ms Eb4:680ms" --voice bell
 *     node scripts/analyze-sound.mjs "A5 E6" --json
 *     node scripts/analyze-sound.mjs --voices
 *
 * The report is derived from the *same* {@link readMelody} and {@link schedule}
 * the browser calls, so there is no second opinion about what a melody means: if
 * this says the chime lasts 1.19 seconds, then the chime lasts 1.19 seconds.
 *
 * Usage:
 *   node scripts/analyze-sound.mjs <melody> [--voice <name>] [--gain <0..1>] [--json]
 *   node scripts/analyze-sound.mjs --voices [--json]
 *
 * Exit code is 1 when the melody has problems, so a generator can gate on it.
 */

import { VOICES, VOICE_NAMES, readMelody, schedule } from '../src/sound.js'

/**
 * A message and the exit code to leave with.
 * @param text - the line to print to stderr.
 * @param code - the exit code.
 * @returns never.
 */
function bail(text, code) {
  console.error(text)
  process.exit(code)
}

/**
 * Read `--flag value` from the arguments.
 * @param args - the argument list.
 * @param flag - the flag name, without dashes.
 * @returns the value, or undefined.
 */
function flagValue(args, flag) {
  const index = args.indexOf(`--${flag}`)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) bail(`--${flag} needs a value`, 2)
  return value
}

/**
 * A note's name from its frequency, for the report.
 *
 * Rounded to the nearest cent so a melody written in Hz still reads as a pitch
 * when it is one — the point is that a generated spectrum can be checked by eye
 * against what was intended.
 *
 * @param frequency - the frequency in Hz.
 * @returns the name, or the number when it is not a named pitch.
 */
function pitchName(frequency) {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
  const midi = Math.round(69 + 12 * Math.log2(frequency / 440))
  if (midi < 0 || midi > 127) return `${frequency.toFixed(2)}Hz`
  const name = names[((midi % 12) + 12) % 12]
  const octave = Math.floor(midi / 12) - 1
  const exact = 440 * 2 ** ((midi - 69) / 12)
  // Within a twentieth of a semitone is "that pitch"; further off is reported as
  // both, because a detuned partial or a Hz-written melody is not a typo.
  const cents = Math.abs(1200 * Math.log2(frequency / exact))
  return cents < 5 ? `${name}${String(octave)}` : `${name}${String(octave)}${cents > 20 ? ` (${frequency.toFixed(1)}Hz)` : ''}`
}

/** Pad a value for the fixed-width tables. @param value @param width */
function pad(value, width) {
  return String(value).padEnd(width)
}

/**
 * Describe one voice: its recipe, and what that recipe does to a 200ms note.
 * @param name - the voice name.
 * @returns a report record.
 */
function describeVoice(name) {
  const voice = VOICES[name]
  const read = readMelody('A4:200ms')
  const event = schedule(read.notes, name, { gain: 1 }).events[0]
  const partials = (voice.partials ?? []).map(([ratio, amplitude]) => ({ ratio, amplitude }))
  return {
    name,
    label: voice.label,
    hint: voice.hint,
    shape: voice.shape ?? (partials.length > 0 ? 'periodic' : 'sine'),
    partials,
    // The highest partial content, which is what "bright" means in practice.
    partialsCount: partials.length,
    attackMs: Math.round((voice.attack ?? 0.002) * 1000),
    decayFraction: voice.decay ?? 1,
    lowpass: voice.lowpass ?? null,
    // The envelope a caller can check without running the scheduler themselves.
    ringMs200: Math.round((event.decayEndsAt - event.startedAt) * 1000),
    stopsMs200: Math.round((event.stopsAt - event.startedAt) * 1000),
  }
}

const args = process.argv.slice(2)
const asJson = args.includes('--json')

if (args.includes('--voices') || args.length === 0) {
  const voices = VOICE_NAMES.map((name) => describeVoice(name))
  if (asJson) {
    console.log(JSON.stringify({ voices }, null, 2))
    process.exit(0)
  }
  console.log('voices — a 200ms A4 through each recipe\n')
  console.log(`${pad('name', 10)} ${pad('shape', 9)} ${pad('partials', 9)} ${pad('attack', 7)} ${pad('ring', 6)} ${pad('stop', 6)} label`)
  for (const voice of voices) {
    console.log(
      `${pad(voice.name, 10)} ${pad(voice.shape, 9)} ${pad(voice.partialsCount, 9)} ${pad(`${String(voice.attackMs)}ms`, 7)} ${pad(`${String(voice.ringMs200)}ms`, 6)} ${pad(`${String(voice.stopsMs200)}ms`, 6)} ${voice.label}`,
    )
  }
  console.log('\nring = how long the sound is still audible; stop = when the oscillator is released.')
  console.log('a bare waveform holds its level for the written length (ring == 200ms).')
  process.exit(0)
}

// The melody is every positional argument that is not a flag or a flag's value.
const FLAGS = new Set(['--voice', '--gain', '--json', '--voices'])
const melodyParts = []
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (FLAGS.has(arg)) {
    if (arg !== '--json' && arg !== '--voices') index += 1
    continue
  }
  melodyParts.push(arg)
}
const melody = melodyParts.join(' ').trim()
if (melody === '') bail('analyze-sound: pass a melody, or --voices to list the timbres', 2)

const voiceName = flagValue(args, 'voice') ?? 'sine'
const gainRaw = flagValue(args, 'gain')
const gain = gainRaw === undefined ? 1 : Number.parseFloat(gainRaw)
if (!Number.isFinite(gain) || gain < 0 || gain > 1) bail(`--gain must be between 0 and 1, got '${String(gainRaw)}'`, 2)
if (!(voiceName in VOICES)) {
  bail(`unknown voice '${voiceName}'; the timbres are: ${VOICE_NAMES.join(', ')}`, 2)
}

const read = readMelody(melody)
const plan = schedule(read.notes, voiceName, { gain })
const voice = describeVoice(voiceName)

const notes = read.notes.map((note) => ({
  label: note.label,
  name: note.frequency === undefined ? 'rest' : pitchName(note.frequency),
  frequency: note.frequency === undefined ? null : Number(note.frequency.toFixed(3)),
  startMs: note.startMs,
  durationMs: note.durationMs,
}))
const events = plan.events.map((event) => ({
  frequency: Number(event.frequency.toFixed(3)),
  name: pitchName(event.frequency),
  startedAt: event.startedAt,
  attackEndsAt: event.attackEndsAt,
  decayEndsAt: event.decayEndsAt,
  stopsAt: event.stopsAt,
  gain: event.gain,
}))

const report = {
  melody,
  voice: voiceName,
  gain,
  silent: read.silent,
  durationMs: plan.durationMs,
  noteCount: notes.filter((note) => note.frequency !== null).length,
  restCount: notes.filter((note) => note.frequency === null).length,
  problems: read.problems,
  notes,
  events,
  voiceRecipe: voice,
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log(`melody: ${melody}`)
  console.log(`voice:  ${voiceName} — ${voice.label} (${voice.hint})`)
  console.log(`gain:   ${String(gain)}`)
  console.log(
    `length: ${String(plan.durationMs)}ms, ${String(report.noteCount)} note(s), ${String(report.restCount)} rest(s)${read.silent ? ' — SILENT' : ''}\n`,
  )
  console.log(`${pad('#', 3)} ${pad('token', 14)} ${pad('pitch', 12)} ${pad('freq', 10)} ${pad('start', 8)} ${pad('rings', 8)}`)
  read.notes.forEach((note, index) => {
    const name = note.frequency === undefined ? 'rest' : pitchName(note.frequency)
    const frequency = note.frequency === undefined ? '—' : note.frequency.toFixed(2)
    console.log(
      `${pad(index + 1, 3)} ${pad(note.label, 14)} ${pad(name, 12)} ${pad(frequency, 10)} ${pad(`${String(note.startMs)}ms`, 8)} ${pad(`${String(note.durationMs)}ms`, 8)}`,
    )
  })
  if (events.length > 0) {
    // Milliseconds, as integers, for the reason the note table uses them: a 4ms
    // attack printed as `0.00s` is a table that hides the thing it exists to show.
    console.log(`\nenvelope — how each note is shaped by ${voiceName} (ms from the start):`)
    console.log(`${pad('#', 3)} ${pad('pitch', 10)} ${pad('starts', 9)} ${pad('attack', 9)} ${pad('decays', 9)} ${pad('stops', 9)}`)
    events.forEach((event, index) => {
      const base = event.startedAt * 1000
      const ms = (value) => `${String(Math.round(value * 1000 - base))}ms`
      console.log(
        `${pad(index + 1, 3)} ${pad(event.name, 10)} ${pad(ms(event.startedAt), 9)} ${pad(ms(event.attackEndsAt), 9)} ${pad(ms(event.decayEndsAt), 9)} ${pad(ms(event.stopsAt), 9)}`,
      )
    })
    console.log('attack = the ramp that stops the start from clicking; decays = when it has fallen to silence.')
  }
  if (read.problems.length > 0) {
    console.log(`\nproblems — these tokens do nothing:`)
    for (const problem of read.problems) console.log(`  ${problem.token}: ${problem.message}`)
  }
}

process.exit(read.problems.length > 0 ? 1 : 0)
