# dsh-notification — development

Everything here is for working on the plugin. Users want [the README](README.md).

## Commands

```sh
npm run build   # src/ -> lib/client.js
npm run watch   # rebuild on save
npm run sound   # the melody analyzer, for writing or checking a tune
```

## Releasing

A release is **staged by CI and published by a person**, which is what npm's staged publishing is for:
a workflow can put a tarball in the registry's staging area without a 2FA prompt, and a maintainer
approves it later with 2FA. The run is the build's provenance, so no token is involved anywhere — see
[`.github/workflows/stage.yml`](.github/workflows/stage.yml) for the workflow and the trusted-publisher
settings it has to match on npmjs.com (`stage.yml`, environment `npm-publish`, allowed action
`npm stage publish`).

The measured sequence:

```sh
# 1. the version, and the bundle the version claims to carry
npm version 0.2.0 --no-git-tag-version   # 0.x minor: the settings model changed shape
node scripts/build-client.mjs --check    # must be silent; CI runs the same check

# 2. push, then stage
git commit -am "..." && git push
gh workflow run stage.yml --repo citisen/dsh-notification

# 3. inspect and publish (these are the steps CI is not allowed to do)
npm stage list                    # the stage id
npm stage view <stage-id>         # the tag it will carry, and the version
npm stage download <stage-id>     # optional: the tarball, for looking at
npm stage approve <stage-id>      # 2FA prompts here — this publishes it
npm stage reject <stage-id>       # or discard it, which frees the version again
```

Three facts about that flow, each measured rather than assumed:

- **A staged version is not installable and carries no dist-tag until it is approved.** So the README's
  install step waits for the approval, not for the workflow.
- **`npm stage publish` never prompts for 2FA, whatever the credential is**; `approve` and `reject`
  always do. That is the whole shape of the feature: automation stages, a human publishes.
- **A trust relationship may only be allowed to stage.** The npm setting behind that is
  `npm trust github --allow-stage-publish` (with `--allow-publish` left off), which is what makes a
  stolen CI token unable to publish anything directly.

Staging locally is possible — `npm stage publish` works with the ordinary token in `~/.npmrc` — but it
is the wrong way to cut a release here: without the OIDC exchange there is no provenance, and the
workflow exists precisely so that the published tarball is linked to the run that built it.

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
This is what makes the plugin's behaviour checkable rather than audible — "that card is switched off,
so this event never reaches the speakers" is an assertion, not an observation.

It is also why `planEvent` takes exactly two things, an event and the settings. It used to take a
clock, a window's focus and visibility, and a log of when each session last spoke, and every one of
those inputs existed to answer *whether* — see [the four rules that were removed](#four-rules-that-were-removed).

## There is no system notification channel

This plugin makes a sound. A banner channel was built, shipped, and then **removed** — the code is not
imported by anything, not in the bundle, and not in the settings model. Removing it took the bundle from
164 KB to 129 KB, which is the measurable form of "this code is not running".

Two modules are kept in the repository, with their unit tests, because they are what a host-side bridge
would build on:

| Path | What it is |
| --- | --- |
| `src/system.js` | The Web `Notification` API wrapper and its permission states. |
| `src/templates.js` | The notification text and its placeholder vocabulary. |

Nothing imports either one, so the bundle inliner drops them — which is the measurable form of "this code
is not running": with them gone the bundle went from 164 KB to 129 KB. Nothing checks that any more, since
the checks were removed; it is visible by reading `lib/client.js` for the names, or by the file's size.

### Why it was removed, measured on this platform

- The desktop shell installs **no permission request handler**, so
  `Notification.requestPermission()` resolves immediately to `denied` with no prompt — and it
  *consumes* the `default` on the way. A plugin that asks destroys the very permission it is trying to
  obtain. This plugin shipped that bug: its test button turned a `default` into a `denied`.
- `Notification.permission` then reads `denied` while `new Notification(...)` **still constructs**.
  From inside the page there is no way to tell a banner that was shown from one the operating system
  dropped: the API reports success either way.
- The shell's own notifications are raised in the **main process** — its mandatory update prompt calls
  Electron's `Notification` there, not the renderer's Web API.

A channel whose success cannot be observed, and whose failure is indistinguishable from success, is not
a feature: it shipped a button that reported "sent" and showed nothing. Doing it properly needs a
host-side bridge to the main process, which the shell would have to expose — a client plugin cannot
reach Electron. That is a change to the application, not to this bundle, and until then the honest
plugin is one that does one thing.

### Three duplicate switches, and what each was

There is deliberately no plugin-wide switch in the settings row. dsh's own plugin manager enables and
disables a plugin by editing the profile's `dsh.profile.bundles`; that is the only place a
plugin-wide on/off belongs, and a second switch meant two places to look when the plugin was silent.
The control that means "silence everything for now" is the master volume at **0** — a level, not a
mode, which is also why the row no longer asks when the bell may ring at all.

The same duplication turned up twice more inside the card, and both times it was only visible as a
*count*:

| Pair | Why it was two, and why it is one |
| --- | --- |
| plugin-wide switch / dsh's plugin manager | Both answered "is this plugin on". The manager is the only place that belongs. |
| *Alert for this state* / *Play a sound* | The second was the notification channel's switch. With one channel it meant exactly what the first did. |
| *Play* / *Test* | *Play* previewed the sound; *Test* planned it, printed a sentence, and played nothing. |

Each removal is decided rather than defended: nothing checks these counts any more, so if a control is
added back it must be by someone who has read this table and decided the pair is worth it. Two controls
that mean the same thing each look correct on their own, which is why all three pairs survived as long as
they did.

### Four rules that were removed

The settings row also carried four rules that answered *whether* a state should be heard. All four are
gone, and they are recorded here for the same reason as the table above: each looked reasonable on its
own, and each could silence the notification the plugin exists for.

| Rule | What it was for | What it actually silenced |
| --- | --- | --- |
| *when sound plays* = `while the window is not in front` (the shipped default) | not chiming at somebody who is already reading the interface | the ordinary case — one conversation open in the main view, a long turn, the user in another application. The window was still *visible*, so the chime was refused |
| *stay quiet about the session I am looking at* | the same idea one level down: the interface *is* the notification | anything about the session on screen. Under the default scope it could only ever fire in a situation the scope had already refused, which is the duplicate-switch shape above |
| *minimum gap between sounds* | agents ask several questions in a row, and three chimes in three seconds reads as a malfunction | the second of two real state changes, judged by the clock instead of by what happened |
| *do not repeat the same state within* | a session flapping between two states | real changes into a real state, for as long as the interval lasted |

Two facts decided this rather than taste. `document.hasFocus()` is about the window, not about
attention: it cannot tell "reading the interface" from "left it open and walked away", and the second
one is the case the plugin is for. And the rules could not be made to agree with each other — see the
second row.

What survives is one sound per *burst*: `firstAudible` takes the most urgent plan out of the
events the interface published in one moment. That is not a clock and not a rate limit — two changes a
second apart are two sounds — and the README's limitations say so, because a session that flaps is now
audible every time it does.

Note what the manager's toggle actually does, since it shapes the advice in the README:
`loadProfileDirectory` reads the bundles list **once at boot** and nothing watches it, so disabling a
plugin takes effect only after a restart — and it also removes the settings page, because the page is
part of the plugin.

## Checked facts about the client services

Established from the shipped code rather than from documentation, because the shapes differ between
releases:

- `ctx.uiSession.sessionStatus` is `Map<sessionId, { running, pendingInteraction, completionUnread }>`
  — the single observable the engine reads, and the same one the sidebar renders from.
- `completionUnread` is the controller's *"a turn ended and the user has not seen it"* flag, and it is
  set **only** for sessions the main view is not showing: `observeRunning` skips `isMain(sessionId)`,
  and `reconcileStatus` clears the flag for whatever is main. A plugin reading completion from it can
  therefore never report the completion of the conversation on screen — which is the one case a chime
  exists for. `diffStatus` reads the end of a turn from the `running` → quiet edge instead, and this
  flag is what the same event looks like when the interface does publish it.
- `ctx.sessions.list` rows carry `title` (the durable one) and `displayTitle` (synthesized), plus
  `running`, `blank` and `retainedBy.mainView`.
- `pendingInteraction.kind` is `'question' | 'approval' | 'plan-review'`, one class instance per
  session, whose text lives on `questions[0].question`.
- a failure is **an event, not a level**: `ctx.remote.$on('api-session/error', …)`. The status entry
  has no failure bit, so `states.js` remembers the event — and records what that costs (no turn
  position, no replay across a reconnect).

## Installing from a local checkout on Windows

When the profile and the checkout are on **different volumes** the earlier note here said
`dsh plugin add <path>` was unreliable, because pnpm cannot create a relative link across them. Measured
again on this machine — checkout on `D:`, profile under `C:\Users\…\.dsh` — the command is what to use:

| Step | Result |
| --- | --- |
| `dsh plugin --profile desktop add D:\mygith\dsh-notification` | exit 0; `dependencies` gained `"@citisen/dsh-notification": "link:D:/mygith/dsh-notification"`, `pnpm-lock.yaml` recorded the same spec, and the `dsh.profile.bundles` entry stayed where it was |
| `node_modules\@citisen\dsh-notification` | a **`SymbolicLink`** to `D:\mygith\dsh-notification`, created by pnpm — not the directory junction this section used to prescribe, so pnpm did handle the cross-volume link itself |
| `cordis.patch.yml` | rewritten, but with the same rows: nothing on this path adds or removes a patch entry |
| the previously installed registry copy | replaced by the link in the same run (`Packages: -1`) |

A symlink on Windows needs Developer Mode or an elevated process, which is the one thing that can still
make this fail — in which case link it by hand:

```sh
cd "$DSH_HOME/profiles/desktop"
# add "@citisen/dsh-notification": "link:D:/path/to/dsh-notification" to dependencies
# and "@citisen/dsh-notification" to dsh.profile.bundles, then:
cmd /c mklink /J node_modules\@citisen\dsh-notification D:\path\to\dsh-notification
```

No row has to be added to `cordis.patch.yml` for the plugin to load: the package's own bundle layer
inserts `id: notification` (see `cordis.patch.yml` in this repository). A row there is only what carries
`config:` overrides, which is why the uninstall section of the README has to mention deleting one.

### What `dsh plugin remove` does, measured

Run on this machine against the real profile, in this order:

| Step | Result |
| --- | --- |
| `dsh plugin remove @citisen/dsh-notification` | exit 0; the dependency left `package.json`, and `reconcile()` pruned the `dsh.profile.bundles` entry **without being asked to** |
| the `cordis.patch.yml` row | **still there** — nothing on the removal path touches the patch layers |
| the directory junction | **still there** — `pnpm remove` does not prune a `link:` junction on Windows |
| `dsh plugin list` | `@citisen/dsh-font` only; the plugin is gone from the roster |

So the plugin is fully unloaded by the command alone, and two artifacts outlive it. Both are harmless
to loading — the bundles list is what selects a plugin, and the patch row's `config:` block is merely
ignored once its target entry is gone — but the row is not silent about it. Booting a profile that has
the row without the bundle prints, on every start:

```
dsh: [.../cordis.patch.yml] patch: entry "notification" not found
```

That message is the observable form of "the patch layer outlives the plugin", and it is why the
README's uninstall section has a second step at all.

The row id and the client half's `NOTIFICATION_NAMESPACE` must be the same string, `notification` —
that is how the settings model finds the configuration.
