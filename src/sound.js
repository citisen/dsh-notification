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
export function noteFrequency(text) {
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
export function parseLength(text) {
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
export const DEFAULT_NOTE_MS = 130
/** How far apart two items start when the melody does not say, in milliseconds. */
export const DEFAULT_STAGGER_MS = 90

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
export function readMelody(text) {
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
export function melodyLengthMs(notes) {
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
export const VOICES = {
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
export const VOICE_NAMES = Object.keys(VOICES)

/** The voice a state uses when it names none. */
export const DEFAULT_VOICE = 'sine'

/**
 * Read a voice name.
 * @param name - the written name.
 * @returns the voice and its name, falling back to {@link DEFAULT_VOICE}.
 */
export function readVoice(name) {
  const chosen = VOICES[name]
  if (chosen === undefined) return { name: DEFAULT_VOICE, ...VOICES[DEFAULT_VOICE] }
  return { name, ...chosen }
}

// ─── scheduling, as a pure function ──────────────────────────────────────────

/** How long the release ramp lasts, in milliseconds, regardless of note length. */
export const RELEASE_MS = 18
/** The gain an exponential ramp may not reach, so the ramp never targets zero. */
export const SILENCE = 0.0001
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
export function schedule(notes, voice, options) {
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
export function periodicWave(context, partials) {
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
export function createPlayer(options = {}) {
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
