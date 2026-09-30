# dsh-notification

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that plays a sound when one of your
sessions needs you — **built for the desktop application**, and it works in the browser too.

While you are looking at the interface it already tells you everything: the sidebar has a state per
session, and the conversation has its own streaming indicators. What it cannot do is tell you
anything once you are in another application, which is exactly when a long turn is running. This
plugin plays a chime you can hear from across the room.

## What it adds

*Settings → General* gains a **Session notifications** row: a master switch, the global settings,
and then one card per state.

| State | Plays when | Default sound |
| --- | --- | --- |
| **Waiting for an answer** | the agent asked a question | Beethoven, Symphony No. 5 — the fate motif |
| **Waiting for approval** | the agent asked for permission | Bach, Toccata and Fugue in D minor BWV 565 |
| **Waiting for a plan review** | the agent proposed a plan | an ascending C-major arpeggio |
| **Ended with an error** | the session's agent reported an error | the *Dies irae* plainchant |
| **Finished** | a turn ended and you have not looked at it | Beethoven, Symphony No. 9 — "Ode to Joy" |
| **Started** | a turn began | Mozart, Eine kleine Nachtmusik K. 525 — **off by default** |

Every sound is a short phrase from a public-domain classical work, chosen to suit its state. **Started**
is switched off because a turn beginning is not worth interrupting anyone for; turn it on in its card
if you want it.

Each card has its own switch, volume, timbre and melody, and once a sound is longer than a single
blip the melody is worth editing — see [the melody](#the-melody).

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
    soundScope: always
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

Everything lives in one row under *Settings → General*:

- **Master switch** — off means no card makes a sound.
- **Master volume** — multiplies each card's own volume, so both numbers matter.
- **When sound plays** — `background` (the default) chimes only while the window is hidden or
  unfocused, `always` chimes regardless, `off` mutes every card without changing any of them.
- **Minimum gap between sounds** — stops several chimes landing on top of each other, in
  milliseconds.
- **Do not repeat the same state within** — rate-limits a session that flaps between states.
- **Stay quiet about the session I am looking at**, **Stay completely quiet while the window is in
  front** — see [Privacy and quiet](#privacy-and-quiet).
- **The state switcher** — the six states down the left. Each entry shows how many sessions are in
  that state right now, and a switched-off state is dimmed. Selecting one shows its card.

On a card:

| Control | Meaning |
| --- | --- |
| Alert for this state | the card's own switch |
| Play a sound | whether this state makes any noise |
| Volume | this card's level, multiplied by the master volume |
| Timbre | one of the eleven voices below |
| Melody | the notes to play — see below |
| Play | plays the sound and reports what happened — see below |
| Reset | puts every field on this card back to its shipped value |

**Play does two things at once**, which is why there is one button and not two. It plays the state's
sound through the real audio path — the actual timbre, the actual melody, the actual product of the
card's volume and the master's — and then prints a line under the card saying what the engine made of
the request: `Play a sound: marimba @ 100%`, or the reason nothing would happen. Pressing it on a state
that is switched off still answers the question, by testing the card as though it were on.

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

## Privacy and quiet

Two rules keep the plugin quiet in the one situation where it has nothing to add:

- **the session you are looking at is not news** — if the window is in front and that session is on
  screen, the interface already told you;
- **the bell is gated on the window** — the default `background` scope only chimes while the window
  is hidden or unfocused.

Both can be turned off if you want the feedback anyway.

## Limitations

- **`finished` does not fire for the session on screen.** dsh suppresses its unread flag for the
  session in the main view, so testing this by watching the session you just ran will not make a
  sound — which is the case the chime is for.
- **`failed` means the session's agent reported an error.** dsh does not forward which turn it was,
  and the event is not replayed after a reconnect.
- **Audio needs one click to unlock** before the first sound. This is the browser's autoplay policy
  and cannot be bypassed; pressing **Play** on any card is the click. The row says "audio not
  initialized yet" until then.
- **The interface is bilingual** (English and Chinese).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the build, the verification layers, and the design notes.

## License

MIT
