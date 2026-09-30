# dsh-notification

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that plays a sound when one of your
sessions needs you — **built for the desktop application**, and it works in the browser too.

While you are looking at the interface it already tells you everything: the sidebar has a state per
session, and the conversation has its own streaming indicators. This plugin adds the other half —
**a chime whenever a state you asked about arrives, whether or not you are looking**: in another
application, with the window behind something else, or sitting right in front of it. If the card is
on, it sounds.

## What it adds

*Settings → General* gains a **Session notifications** row: one master volume, and then one card per
state.

| State | Plays when | Default sound |
| --- | --- | --- |
| **Waiting for an answer** | the agent asked a question | Beethoven, Symphony No. 5 — the fate motif |
| **Waiting for approval** | the agent asked for permission | Bach, Toccata and Fugue in D minor BWV 565 |
| **Waiting for a plan review** | the agent proposed a plan | three taps on one note, then an octave above, held |
| **Ended with an error** | the session's agent reported an error | the *Dies irae* plainchant |
| **Finished** | a turn ended | Beethoven, Symphony No. 9 — "Ode to Joy" |
| **Started** | a turn began | Mozart, Eine kleine Nachtmusik K. 525 — **off by default** |

Every sound is a short phrase from a public-domain classical work, chosen to suit its state. **Started**
is switched off because a turn beginning is not worth interrupting anyone for; turn it on in its card
if you want it.

Each card has its own switch, volume, timbre and melody. One switch, because a card can do one thing:
make a sound. Once that sound is longer than a single blip the melody is worth editing — see
[the melody](#the-melody).

**There is no "when may it ring" rule** — no window focus, no "do not alert me about the session I am
looking at", no minimum gap. A state that matches and a card that is on are the whole condition; to be
quiet, drag the master volume to 0 or switch the card off. The reasoning is
[below](#why-there-are-no-such-switches).

## Install

```sh
dsh plugin --profile desktop add @citisen/dsh-notification
```

Then restart the application. Use `--profile web` for the browser profile.

## Uninstall

```sh
dsh plugin --profile desktop remove @citisen/dsh-notification
```

Quit the application fully first — it manages the `desktop` profile, and the command refuses to touch
a profile that is in use. The command removes the package, its entry in `dsh.profile.bundles`, and the
installed copy of it.

Then delete your settings, which the command cannot reach. The plugin's row carries a `config:` block
holding everything you changed from the defaults, and it lives in your own patch file:

```yaml
# $DSH_HOME/profiles/desktop/cordis.patch.yml
- id: notification
  name: "@citisen/dsh-notification"
  config:
    masterVolume: 1
    # ...and the per-state settings
```

Delete that whole entry. **If you leave it, the plugin is gone but its configuration is not**, and
every start prints this:

```
dsh: [.../cordis.patch.yml] patch: entry "notification" not found
```

It is a warning rather than a failure — the application still starts, and the settings are simply
ignored — but it will say so on every launch until the entry is removed. If you want to keep those
settings before deleting them, copy the block out of the file first.

### If you installed from a local checkout

`pnpm remove` does not prune a directory junction installed with `link:`, so the link survives the
removal and points at your checkout. It does **not** keep the plugin loaded — the package is gone from
the dependency list, the bundles list and the plugin roster — but it sits in `node_modules` and makes
it look as though something is still installed. Delete the link by hand:

```powershell
# removes the link, not the checkout
cmd /c rmdir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@citisen\dsh-notification"
```

`rmdir` on a junction removes the link and leaves `D:\path\to\dsh-notification` untouched. Do **not**
use `Remove-Item -Recurse` if you are unsure: on some PowerShell versions that follows the junction and
deletes the checkout behind it.

## Settings

### Turning it off without uninstalling

Drag the **master volume** to 0: every card goes silent, every setting is kept, and dragging it back
restores the sound. To switch the plugin itself off, use dsh's own plugin manager — that edits the
profile's bundles list and needs an application restart.

Everything lives in one row under *Settings → General*:

- **Master volume** — multiplies each card's own volume, so both numbers matter. **0 is the mute.**
- **The state switcher** — the six states down the left. Each entry shows how many sessions are in
  that state right now, and a switched-off state is dimmed. Selecting one shows its card.

That is the only global setting, because it answers the only global question with an honest answer:
**how loud**. Each card's own switch answers *whether*, and the switches that were removed answered
*are you looking* — which the plugin cannot know, and which it got wrong every time it guessed.

On a card:

| Control | Meaning |
| --- | --- |
| Alert for this state | the card's switch — the only one it has |
| Volume | this card's level, multiplied by the master volume |
| Timbre | one of the eleven voices below |
| Melody | the notes to play — see below |
| Play | plays the sound; speaks only when nothing sounded — see below |
| Reset | puts every field on this card back to its shipped value |

**Play does two things at once**, which is why there is one button and not two. It plays the state's
sound through the real audio path — the actual timbre, the actual melody, the actual product of the
card's volume and the master's — and **the sound is the report**: nothing is printed when it played.
The card speaks only when *nothing* sounded ("the volume is 0, so nothing would sound"), because that
is the one outcome you cannot diagnose by listening. Pressing it on a state that is switched off still
answers the question, by testing the card as though it were on.

The audio line works the same way and appears only while something is wrong: `audio is still locked —
press Play once to unlock it`, or the one line for a build with no Web Audio at all. Once sound works,
the line is gone — there is nothing to report about a thing that is working.

It is also the click that unlocks audio the first time.

## The melody

The melody is written as note names with optional lengths:

```
A5:200ms E6:200ms          two notes, each ringing for its own length
G4 G4 G4 Eb4:680ms         four notes; the bare ones use the shipped pacing
A5:120ms -:80ms E6:240ms   a rest is a step that sounds nothing
880 1318.5                 a frequency in Hz, for a pitch with no name
off                        no sound for this state
```

- **Note names** are `A5`, `C#4`, `Bb3` — any octave, sharps and flats both accepted.
- **A written length is the whole item**: the note rings that long and the next one starts when it
  ends. `s`, `ms` and `m` all work, and a bare number means seconds.
- **An item with no length** keeps the shipped pacing — 130 ms of sound, the next starting 90 ms
  later — which is what makes `A5 E6` one interval rather than two separate knocks.
- **A rest** (`-`) occupies its time and sounds nothing.
- **A frequency in Hz** is accepted wherever a note name is.

Anything the reader cannot understand is reported under the field and costs only its own item, so a
typo never silences the whole melody.

## Timbres

Eleven voices ship. The four waveforms are single-tone; the other seven are built from partials,
which is what makes them sound like an instrument rather than a tone:

| Voice | Sounds like |
| --- | --- |
| `sine` | pure tone — the plainest chime |
| `triangle` | soft flute — gentle, few harmonics |
| `square` | chip — hollow and unmistakably electronic |
| `sawtooth` | buzz — bright and harsh, cuts through noise |
| `bell` | struck metal with a long tail |
| `glass` | high and bright, short |
| `marimba` | a wooden bar, fast even decay |
| `pluck` | a short filtered string |
| `wood` | a click with almost no pitch — the least intrusive |
| `blip` | one very short tone |
| `digital` | a two-partial electric chime |

## Generating a melody

Melodies are plain text, so they can be written by a model and checked without listening. The
analyzer prints exactly what a melody will do:

```sh
node scripts/analyze-sound.mjs "G4:170ms G4:170ms G4:170ms Eb4:680ms" --voice bell
node scripts/analyze-sound.mjs "A5:220ms -:80ms E6:400ms" --voice marimba --json
node scripts/analyze-sound.mjs --voices
```

It reports each note's pitch, frequency, start time and how long it rings, plus the envelope the
chosen timbre gives it. `--json` emits the same as data, and a melody with an unusable token exits
non-zero — so a generator can gate on it.

## Why there are no such switches

Five global rules used to live here, and all five were answering one question: **are you looking right
now?** — *when sound plays* (`while the window is not in front` / `always` / `never`), *stay quiet
about the session I am looking at*, *stay completely quiet while the window is in front*, *minimum gap
between sounds*, and *do not repeat the same state within*.

They are gone for one reason: **guessing wrong cost exactly the notification the plugin exists for.**
One conversation, open in the main view, a long turn, the user in another application — the window was
still visible, so `when sound plays: while the window is not in front` refused the chime. A rule meant
to prevent annoyance prevented the notification instead. The two switch-shaped rules also contradicted
each other: under that same default, *stay quiet about the session I am looking at* could only ever
fire in a situation the scope had already silenced.

What survives was never a time rule and is not one now: **one sound per instant** — when the interface
publishes several state changes at once, the most urgent one is the one you hear. Two changes a second
apart are two events and each gets its own sound. Being quiet is a volume, not a mode.

## Limitations

- **`finished` is the end of a turn, not a verdict on it.** It is read from the session going quiet
  rather than from dsh's unread flag — which dsh suppresses for the session in the main view, so a
  plugin leaning on it could never chime for the conversation you are actually watching. That is also
  the cost: a turn that *errored* ends too, and if the error is reported after the turn is, you may
  hear the chime for **Finished** where **Ended with an error** was meant.
- **The same state can chime on every change into it.** Nothing rate-limits a repeat any more: a
  session flapping between two states sounds each time. Switch its card off, or turn that card down,
  if it is a session you would rather not hear about.
- **`failed` means the session's agent reported an error.** dsh does not forward which turn it was,
  and the event is not replayed after a reconnect.
- **Audio needs one click to unlock** before the first sound. This is the browser's autoplay policy
  and cannot be bypassed; pressing **Play** on any card is the click. The row says "audio not
  initialized yet" until then.
- **The interface is bilingual** (English and Chinese).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the build and the design notes.

## License

MIT
