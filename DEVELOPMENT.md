# dsh-notification — development

Everything here is for working on the plugin. Users want [the README](README.md).

## Commands

```sh
npm run build      # src/ -> lib/client.js
npm run watch      # rebuild on save
npm run test       # unit tests over the pure half
npm run sound      # the melody analyzer
npm run live       # drive the real GUI and report what it says
npm run check      # build current + tests + both halves verified
npm run check:all  # plus booting a real profile and driving the real page
```

## How the bundle is built

`src/client.js` is the browser half's entry, written as ES modules for readability. A DSH client
bundle is a **classic script** that may only register a lazy CommonJS factory with
`window.__ModuleLoader__`, so `scripts/build-client.mjs`:

1. wraps the compiled source in that envelope, exporting the names the verifier drives;
2. rewrites static imports of the shell's platform singletons into the factory's `require` form —
   the only way a bundle may reach React or the client store;
3. **splices this package's own modules into the factory's single scope**, recursively, because
   `client.js` imports `engine.js`, which imports `settings.js`. There is no second `<script>` and no
   second roster row.

There is no JSX anywhere. The import rewriting is deliberately narrow and fails loudly on anything it
cannot express, because a hand-written bundle has no bundler behind it — so `React.createElement` is
used directly rather than a transformation that would have to understand JSX.

## Verification

| Check | Covers |
| --- | --- |
| `node --test` | The pure half: melody parsing and scheduling, the state machine's edges, the template vocabulary, the notification permission states, the policy (`admit`, `soundAllowed`), and the engine's plan. |
| `verify-host.mjs` | The host half against the **real schema library**: the patch row id equals the settings namespace, the schema round-trips the shipped defaults, every field path is `volatile`, and every path a control writes is accepted — the failures that render a settings page on which nothing ever saves. |
| `verify-client.mjs` | The **emitted bundle**: its envelope, that it requires only platform singletons, that both dictionaries have the same keys, that the stylesheet uses design tokens rather than literal colours, the state machine and engine on the shipped artifact, and `apply()` against stub services with the row rendered and its layout asserted. |
| `verify-profile.mjs` | The **real loader**: a mirror profile composes the row, boots with no failed plugin, and answers on its own port. |
| `live-probe.mjs` | The **real page in a real browser**, driven over the DevTools protocol: it boots a profile, opens the interface, opens the settings dialog, drives every entry of the state switcher, and fails on `slot entry crashed`, on a missing row, on an empty number field, or on any uncaught error. |

The first three need nothing but Node. The last two need the desktop application installed and skip
cleanly without it.

### Why the live probe exists

It was added after this plugin shipped its first real bug, and the four other layers all passed while
it was live.

The row passed a `defineStore` **handle** as the slot's store seat. A handle carries `spec` and
`create`; the *instance* carries `getSnapshot` and `subscribe`, and the renderer binds its selector
hook to whatever it is handed. So the row registered successfully, the slot renderer accepted the
registration, and the component threw `getSnapshot is not a function` on its first render. The shell
reported `slot entry crashed in 'settings.general.item'` — a card in the ledger and absent from the
screen, which is what the user saw: *the plugin list has it, the settings panel does not*.

Every stub in this repository had modelled the store the way the plugin used it, so all of them agreed
with the bug. Only the real page could disagree, which is the argument for keeping a layer that needs
a browser.

## Module layout

| Path | What it is |
| --- | --- |
| `lib/index.js` | Node half: the `notification` settings schema, every field `.volatile()`, and `configure({ auto: false })`. |
| `lib/client.js` | Browser half, **generated** from `src/` and served to the interface. |
| `src/client.js` | The only impure module: subscriptions, the output channel, the settings row registration. |
| `src/states.js` | Session state, the edges between two observations, and the failure log. |
| `src/engine.js` | One event plus resolved settings → a plan of what to do. |
| `src/sound.js` | Melody grammar, voice presets, and the scheduler. |
| `src/settings.js` | The configuration's shape, defaults, and policy. |
| `src/row.js` | The settings row. |
| `cordis.patch.yml` | This bundle's profile layer. |

### The engine has no React and no DOM

Everything with a decision in it lives in a module that touches neither. `states.js` projects the
interface's observables into per-session state and diffs two observations into events; `engine.js`
turns one event plus the resolved settings into a plan; `sound.js` parses a melody and schedules it.
This is what makes the plugin's behaviour checkable rather than audible — "it stayed quiet because I
was looking at that session" is an assertion, not an observation.

## The notification channel is switched off

Two modules are kept but not used:

| Path | What it is |
| --- | --- |
| `src/system.js` | The Web `Notification` API wrapper and its permission states. |
| `src/templates.js` | The notification text and its placeholder vocabulary. |

**Neither module is in the shipped bundle.** When the row stopped importing them the bundle lost
about 20 KB, which is the measurable form of "this code is not running". They are kept in the
repository, with their unit tests, for whoever restores the channel.

`src/settings.js` carries one constant:

```js
export const NOTIFICATIONS_ENABLED = false
```

With it false, no banner is planned, the row renders no control for one, and the UI strings for it are
absent from the dictionaries. Nothing imports either module, which `verify-client` checks by asserting
the layout. `engine.js` and `admit()` take the switch as a **parameter** rather than reading the
constant, which is what keeps both states reachable from the suite on every run instead of only the
one that ships.

### Why it is off, measured on this platform

- The desktop shell installs **no permission request handler**, so
  `Notification.requestPermission()` resolves immediately to `denied` with no prompt — and it
  *consumes* the `default` on the way. A plugin that asks destroys the very permission it is trying to
  obtain. This plugin shipped that bug: its test button turned a `default` into a `denied`.
- `Notification.permission` then reads `denied` while `new Notification(...)` **still constructs**.
  From inside the page there is no way to tell a banner that was shown from one the operating system
  dropped: the API reports success either way.
- The shell's own notifications are raised in the **main process** — its mandatory update prompt calls
  Electron's `Notification` there, not the renderer's Web API.

A channel whose success cannot be observed, and whose failure is indistinguishable from success, is
not a feature. Turning it on properly needs a host-side bridge to the main process, which the shell
would have to expose — a client plugin cannot reach Electron. That is a change to the application, not
to this bundle.

## Checked facts about the client services

Established from the shipped code rather than from documentation, because the shapes differ between
releases:

- `ctx.uiSession.sessionStatus` is `Map<sessionId, { running, pendingInteraction, completionUnread }>`
  — the single observable the engine reads, and the same one the sidebar renders from.
- `ctx.sessions.list` rows carry `title` (the durable one) and `displayTitle` (synthesized), plus
  `running`, `blank` and `retainedBy.mainView`.
- `pendingInteraction.kind` is `'question' | 'approval' | 'plan-review'`, one class instance per
  session, whose text lives on `questions[0].question`.
- a failure is **an event, not a level**: `ctx.remote.$on('api-session/error', …)`. The status entry
  has no failure bit, so `states.js` remembers the event — and records what that costs (no turn
  position, no replay across a reconnect).

## Installing from a local checkout on Windows

When the profile and the checkout are on **different volumes**, `dsh plugin add <path>` is unreliable
because pnpm cannot create a relative link across them. Link it by hand:

```sh
cd "$DSH_HOME/profiles/desktop"
# add "@citisen/dsh-notification": "link:D:/path/to/dsh-notification" to dependencies
# and "@citisen/dsh-notification" to dsh.profile.bundles, then:
cmd /c mklink /J node_modules\@citisen\dsh-notification D:\path\to\dsh-notification
# and add the row to cordis.patch.yml:
#   - id: notification
#     name: '@citisen/dsh-notification'
```

The row id and the client half's `NOTIFICATION_NAMESPACE` must be the same string, `notification` —
that is how the settings model finds the configuration.
