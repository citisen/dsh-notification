# dsh-notification

A [dsh](https://github.com/deepseek-ai/deepseek-harness) plugin that tells you when a
session needs you — **built for the desktop application**, and equally at home in the
browser.

The interface already says everything you need to know *while you are looking at it*:
the sidebar has a state per session, the conversation has its own streaming indicators.
What it cannot do is say anything once you are in another application, which is exactly
when a long turn is running. This plugin answers one question from across the room —
*does anything need me?* — through the two channels a backgrounded desktop window
actually has: **its speakers**, and **the operating system's notification centre**.

## What it adds

*Settings → General* gains a **Session notifications** row: a master switch, the global
knobs, and then **one card per state**, each with its own switch, its own bell, its own
volume, its own timbre, its own melody, and its own notification text.

| State | When | Ships |
| --- | --- | --- |
| **Waiting for an answer** | the agent asked a question (`ask_user`) | bell + banner |
| **Waiting for approval** | the agent asked for permission | bell + banner |
| **Waiting for a plan review** | the agent proposed a plan | bell + banner |
| **Ended with an error** | the session's agent reported an error | bell + banner |
| **Finished** | a turn ended and you have not looked at it | bell only |
| **Started** | a turn began | **switched off** |

The last one ships off on purpose. A turn *starting* is not something to interrupt anyone
for — but it is still a state, and a plugin with no way to say so would be deciding a
policy that belongs in a setting.

## The desktop application is the web application

This is worth stating because it is what makes the plugin possible at all. The desktop
build is an Electron shell around the same `dsh-web-app` served from the same loopback
server, loaded through the same client-plugin roster. So:

- the **client-plugin architecture transfers unchanged** — no desktop-specific API, no
  privileged bridge, no second bundle;
- a **desktop notification is the standard Web `Notification` API**, which is why it also
  works in a browser tab;
- there is **no favicon channel and no tab-title channel**, because a desktop window has
  no tab strip. Those were the previous plugin's channels, and dropping them is the whole
  reason this is a new plugin rather than a rename.

## Install

```sh
dsh plugin --profile desktop add @citisen/dsh-notification
```

Then restart the application. `dsh plugin` forwards to pnpm in the profile directory and
aligns `dsh.profile.bundles`; because this package declares `dsh.bundle`, installing it
appends the layer automatically.

### From a local checkout, on Windows

When the profile and the checkout are on **different volumes**, `dsh plugin add <path>` is
unreliable. Link it by hand:

```sh
cd "$DSH_HOME/profiles/desktop"
# add "@citisen/dsh-notification": "link:D:/path/to/dsh-notification" to dependencies
# and "@citisen/dsh-notification" to dsh.profile.bundles, then:
cmd /c mklink /J node_modules\@citisen\dsh-notification D:\path\to\dsh-notification
# and add the row to cordis.patch.yml:
#   - id: notification
#     name: '@citisen/dsh-notification'
```

The row id and the client half's `NOTIFICATION_NAMESPACE` must be the same string,
`notification` — that is how the settings model finds the configuration.

## Settings

The row is controls, not a document, and that is a deliberate reversal. The previous
plugin in this family configured four states through a small language in a code editor,
and the argument for it was real: four states with an appearance *and* a sound are one
table, and a table reads better as a table. There is no appearance here, so the fourth
column holding that table together is gone, and what is left is a form whose fields the
user has to remember the names of.

The two things a document was good at are bought back another way:

- **the melody stays text**, because it is the one field with a real grammar and the one
  field worth generating rather than clicking;
- **every card is total** — nothing is behind a mode, and the card's own switch is what
  collapses it.

### The melody

```
A5:200ms E6:200ms          two notes, each ringing for its own length
G4 G4 G4 Eb4:680ms         four notes; the bare ones use the shipped pacing
A5:120ms -:80ms E6:240ms   a rest is a step that sounds nothing
880 1318.5                 a frequency in Hz, for a pitch with no name
off                        no sound for this state
```

Note names (`A5`, `C#4`, `Bb3`), frequencies, and rests. A written length is the whole
item: it rings that long and the next item starts when it ends. An item that names no
length keeps the shipped pacing — 130 ms of sound, the next starting 90 ms later — which
is what makes `A5 E6` one interval rather than two knocks.

A line the reader cannot use is *reported* and costs only its own item, because a typo in
a settings file must not be able to leave the interface unable to tell you anything.

### Why not a music library

The alternatives were measured rather than assumed:

| Option | Why not |
| --- | --- |
| `abcjs` (5.9 MB unpacked) | renders by **downloading sampled instrument fonts from GitHub at play time**. A desktop notification that needs the network is not a notification. |
| `tone` (5.4 MB unpacked) | declares `standardized-audio-context`, which feature-detects and spawns worklets and dynamic imports. A plugin bundle here is one classic script that may only `require` the shell's own module table. |
| ABC notation, self-parsed | a second, larger language to parse and test, for a sound that lasts under two seconds. Worth revisiting if melodies ever get longer. |

### Timbres

Timbre is a **named preset**, not a waveform — a closed list is something a card can offer
as a choice, while a melody stays something written and worth generating. Eleven ship:
four bare waveforms (`sine`, `triangle`, `square`, `sawtooth`) and seven struck or
plucked recipes whose *partials* are what make them sound like an instrument at all:

```
name       shape     partials  attack  ring   label
sine       sine      0         2ms     200ms  Pure tone
triangle   triangle  0         2ms     200ms  Soft flute
square     square    0         2ms     200ms  Chip
sawtooth   sawtooth  0         2ms     200ms  Buzz
bell       periodic  5         4ms     180ms  Bell
glass      periodic  3         2ms     100ms  Glass
marimba    periodic  3         2ms     84ms   Marimba
pluck      sawtooth  0         3ms     70ms   Pluck
wood       periodic  3         1ms     32ms   Wood block
blip       sine      0         2ms     44ms   Blip
digital    periodic  2         2ms     60ms   Digital
```

### Generating a melody

The melody is the one setting nobody can iterate on by ear in a chat window, and the
failure mode of a generated melody is not a crash — it is a chime that is too long, too
loud, in the wrong octave, or rhythmically not what was intended, discovered minutes later
by a person who was interrupted. So the reader and the scheduler are exposed as a command:

```sh
node scripts/analyze-sound.mjs "G4:170ms G4:170ms G4:170ms Eb4:680ms" --voice bell
node scripts/analyze-sound.mjs "A5:220ms -:80ms E6:400ms" --voice marimba --json
node scripts/analyze-sound.mjs --voices
```

It prints the notes, their pitches and frequencies, their start times, how long each rings,
and the envelope the chosen timbre gives them. `--json` emits the same as data, and a token
the reader cannot use exits non-zero — so a generator can gate on it.

## Privacy and quiet

Two rules exist so the plugin is not annoying in the one situation where it has nothing to
add:

- **the session you are looking at is not news** — if the window is in front and the
  session is the one on screen, the interface *is* the notification;
- **the bell is gated on the window** — `background` (the shipped scope) chimes only while
  the window is hidden or unfocused, `always` removes the gate, `off` mutes the channel
  without touching a card.

A third knob, *do not repeat the same state within*, rate-limits a session that flaps.

## Verification

```sh
npm run check        # build is current + unit tests + both halves
npm run check:all    # plus booting a real profile and driving the real page
```

| Check | Covers |
| --- | --- |
| `node --test` | 115 unit tests over the pure half: melody parsing and scheduling, the state machine's edges, the template vocabulary, the notification permission states, the policy (`admit`, `soundAllowed`), and the engine's plan. |
| `verify-host.mjs` | The host half against the **real schema library**: the patch row id equals the settings namespace, the schema round-trips the shipped defaults, all 57 field paths are `volatile`, and every path a control writes is accepted — the failures that render a settings page on which nothing ever saves. |
| `verify-client.mjs` | The **emitted bundle**: its envelope, that it requires only platform singletons, that both dictionaries have the same keys, that the stylesheet uses design tokens rather than literal colours, the state machine and engine on the shipped artifact, and `apply()` against stub services with the row rendered — one card per state, and the store seat asserted to have the shape the renderer binds to. |
| `verify-profile.mjs` | The **real loader**: a mirror profile composes the row, boots with no failed plugin, and answers on its own port. |
| `live-probe.mjs` | The **real page in a real browser**, driven over the DevTools protocol: it boots a profile, opens the interface, opens the settings dialog, and looks for the card — failing on `slot entry crashed`, on a missing row, or on any uncaught error. |

The first three need nothing but Node. The last two need the desktop application installed
and skip cleanly without it.

### Why the live probe exists

It was added after this plugin shipped its first real bug, and the bug is worth recording
because the other four layers all passed while it was live.

The plugin passed a `defineStore` **handle** as the slot's store seat. A handle carries
`spec` and `create`; the *instance* carries `getSnapshot` and `subscribe`, and the renderer
binds its selector hook to whatever it is handed. So the row registered successfully, the
slot renderer accepted the registration, and the component threw
`getSnapshot is not a function` on its first render. The shell reported
`slot entry crashed in 'settings.general.item'` — a card present in the ledger and absent
from the screen, which is exactly what the user saw: *the plugin list has it, the settings
panel does not*.

Every stub in this repository had modelled the store the way the plugin used it, so all of
them agreed with the bug. Only the real page could disagree, which is the argument for
keeping a layer that needs a browser.

## Development

```sh
npm run build     # src/ -> lib/client.js
npm run watch     # rebuild on save
npm run sound     # the melody analyzer
npm run live      # drive the real GUI and report what it says
```

`src/client.js` is the browser half's entry. It is written as ES modules for readability,
but a DSH client bundle is a **classic script** that may only register a lazy CommonJS
factory with `window.__ModuleLoader__`, so `scripts/build-client.mjs` wraps it in that
envelope, rewrites static imports of the shell's platform singletons into `require`
bindings, and **splices this package's own modules into the factory's single scope** —
recursively, because `client.js` imports `engine.js`, which imports `settings.js`. There
is no JSX anywhere: the build's import rewriting is deliberately narrow, and a
transformation that had to understand JSX is one that could be wrong about it.

### Why the engine has no React and no DOM

Everything with a decision in it lives in a module that touches neither: `states.js`
projects the interface's observables into per-session state and diffs two observations
into events; `engine.js` turns one event plus the resolved settings into a plan;
`sound.js` parses a melody and schedules it; `system.js` owns the permission state. This
is what makes the plugin's behaviour checkable rather than audible — "it stayed quiet
because I was looking at that session" is an assertion, not an observation.

### What the checked facts are

The client services this reads were established from the shipped code rather than from
documentation, because the shapes differ between releases:

- `ctx.uiSession.sessionStatus` is `Map<sessionId, { running, pendingInteraction, completionUnread }>`
  — the single observable the engine reads, and the same one the sidebar renders from.
- `ctx.sessions.list` rows carry `title` (the durable one) and `displayTitle` (synthesized),
  plus `running`, `blank` and `retainedBy.mainView`.
- `pendingInteraction.kind` is `'question' | 'approval' | 'plan-review'`, one class instance
  per session, whose text lives on `questions[0].question`.
- a failure is **an event, not a level**: `ctx.remote.$on('api-session/error', …)`. The
  status entry has no failure bit, so `states.js` remembers the event — and says so, along
  with what that costs (no turn position, no replay across a reconnect).

## Package layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | Node half: the `notification` settings schema, every field `.volatile()`, and `configure({ auto: false })`. |
| `lib/client.js` | Browser half, **generated** from `src/` and served to the interface. |
| `src/client.js` | The only impure module: subscriptions, the two output channels, the settings row. |
| `src/states.js` | Session state and the edges between observations, plus the failure log. |
| `src/engine.js` | One event plus settings → a plan of what to do. |
| `src/sound.js` | Melody grammar, voice presets, and the scheduler. |
| `src/system.js` | The Web Notification channel and its permission states. |
| `src/settings.js` | The configuration's shape, defaults, and policy. |
| `src/templates.js` | The notification text and its placeholder vocabulary. |
| `src/row.js` | The settings row: one card per state. |
| `cordis.patch.yml` | This bundle's profile layer. |

## Known limitations

- **A notification is fire-and-forget.** Nothing can report whether the operating system
  actually drew the banner, so the plugin reports what it can know: whether the constructor
  threw, and whether the permission is granted. The card says "refused", never "sent".
- **The button that asks for permission is the card's test button.** A permission prompt
  with no context is worse than one behind a control that says what it is for.
- **A banner click raises the window and tries to select the session**, by clicking the
  row's own element. The selector is a best effort against markup this plugin does not own;
  a release that renames the attribute costs the navigation, not the notification.
- **`finished` is not reported for the session on screen.** The controller suppresses its
  own unread flag for the main view, so a user who tests this feature by watching the
  session they just ran will not see it fire — which is also the case a notification exists
  for.
- **The failure event has no turn position and is not replayed** across a reconnect, so
  `failed` means "this session's agent reported an error".
- **Audio needs one click to unlock**, which is the browser's autoplay policy and cannot be
  bypassed. The card's audition button is the most convenient click, and it exists partly
  to be it.
- **The row is bilingual** (English and Chinese) with the built-in language pair.

## License

MIT
