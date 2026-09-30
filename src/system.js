/**
 * System notifications: the OS-level banner, and everything that can go wrong
 * with it.
 *
 * The desktop application is an Electron shell around the ordinary web
 * interface, so the channel available to a plugin is the standard Web
 * `Notification` API — there is no privileged bridge for this, and that is a
 * finding rather than an assumption: the shell's preload exposes exactly
 * `protocolVersion`, `browser`, `deviceInfo`, `keyboard`, `shortcuts` and
 * `updates` to the page, and its own use of Electron's `Notification` class is
 * reserved for a mandatory-update prompt. So this module speaks the web API, and
 * so does the web profile, which is why the feature is not desktop-only.
 *
 * Three things about that API shape this file, and all three are the kind of
 * detail that is invisible until it is wrong in front of a user:
 *
 * 1. **Permission may be `default`.** A page that has never asked may not show a
 *    banner, and Electron does not ask on its own. So the request is made from a
 *    *user gesture* — the card's own test button — and the ask is not made at
 *    plugin start, where a prompt with no context would appear before the user
 *    has any idea what is asking.
 * 2. **A notification is fire-and-forget.** Nothing can report whether the OS
 *    actually drew it, so this module reports what it *can* know: whether the
 *    constructor threw, and whether the object reported an error. A card that
 *    said "sent" about a banner the user never saw would be worse than one that
 *    says "no permission".
 * 3. **`onclick` is the whole point of a banner.** A notification that cannot
 *    take you to the session it is about is a nag. The click handler is a
 *    parameter here, never a default, because only the caller knows how to focus
 *    the right conversation.
 *
 * @module dsh-notification/system
 */

/**
 * What the system notification channel is currently able to do.
 *
 * The four cases are kept apart because they need different words in the interface: the
 * API is missing entirely, the user refused, the user has never been asked, or it will
 * work. Collapsing "refused" and "never asked" into one "unavailable" is the version that
 * leaves a user with no idea that a permission prompt exists.
 *
 * ## What this measurement is worth, and what it is not
 *
 * It is worth **information**: the card prints it, and it is the first thing to look at
 * when a banner does not appear. It is *not* worth a gate, and that is a correction this
 * plugin needed. In the desktop application `Notification.permission` reads `denied` while
 * `new Notification(...)` still constructs successfully — measured, not assumed — because
 * the shell installs no permission request handler, so Electron has nothing to ask with
 * and does not refuse on that basis. Gate the banner on this value and a user silently
 * gets nothing in the one configuration where the platform might well have shown it.
 *
 * `canAsk` is a narrower claim than it looks: it says the API *has* a request method, not
 * that asking produces a prompt. On this platform it does not — the ask resolves
 * immediately to `denied` with no UI, and it *changes* a `default` to a `denied` — so the
 * interface tells the user where to enable notifications rather than offering to request
 * them. Asking is a button that can only make things worse.
 *
 * @param view - the object `Notification` class hangs off, for testability.
 * @returns `{ supported, permission, canAsk }`.
 */
export function permissionState(view) {
  const NotificationClass = view?.Notification
  if (typeof NotificationClass !== 'function') {
    return { supported: false, permission: 'unsupported', canAsk: false }
  }
  const permission = typeof NotificationClass.permission === 'string' ? NotificationClass.permission : 'default'
  return {
    supported: true,
    permission,
    canAsk: permission === 'default' && typeof NotificationClass.requestPermission === 'function',
  }
}

/**
 * Ask for notification permission, from a user gesture.
 *
 * Called from the card's test button and nowhere else. The result is returned
 * rather than stored, because the class's own `permission` property is the
 * source of truth the interface reads — a cached copy is one more thing that can
 * disagree with the browser.
 *
 * @param view - the object `Notification` class hangs off.
 * @returns `{ permission }` — the permission after the ask, or the current one
 *   when asking was impossible.
 */
export async function requestPermission(view) {
  const state = permissionState(view)
  if (!state.supported) return { permission: state.permission }
  if (state.permission !== 'default') return { permission: state.permission }
  const NotificationClass = view.Notification
  if (typeof NotificationClass.requestPermission !== 'function') return { permission: state.permission }
  try {
    const granted = await NotificationClass.requestPermission()
    // The return value and the property can disagree on an old implementation,
    // and the property is what the next `show` will be judged by.
    const after = typeof NotificationClass.permission === 'string' ? NotificationClass.permission : granted
    return { permission: after ?? 'default' }
  } catch (error) {
    return { permission: state.permission, error: messageOf(error) }
  }
}

/**
 * A notification's options, built from the fields this plugin actually sets.
 *
 * `silent: true` is asserted on every banner, and it is not a preference: the
 * plugin makes its own sound, with its own volume and its own voice, and an OS
 * notification that *also* plays the system chime makes the configured volume a
 * lie. On Windows the flag is honoured; where it is not, the two sounds overlap
 * and the plugin's is the one the settings describe.
 *
 * @param options - `{ title, body, tag, onClick, data }`.
 * @returns the constructor options.
 */
export function notificationOptions(options) {
  const settings = {
    body: options?.body ?? '',
    silent: true,
    tag: options?.tag,
    data: options?.data,
  }
  // `undefined` values are dropped rather than passed: an explicit `tag:
  // undefined` is not the same thing as no tag on every implementation, and an
  // absent tag is what makes two banners for the same session replace each other.
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined))
}

/**
 * The notifier: one banner per call, with the outcome reported honestly.
 *
 * @param options - `{ view, onClick }`, where `view` is `window` by default and
 *   `onClick` receives the banner's `data` when the user clicks it.
 * @returns `{ show, permission, request, closeAll }`.
 */
export function createNotifier(options = {}) {
  const view = options.view ?? globalThis
  const onClick = options.onClick
  /** The banners this plugin raised and has not seen close, so a state that
   * resolves can take its own banner away instead of leaving it on screen. */
  const live = new Set()

  const notifier = {
    /** @returns the permission state, read live from the browser each time. */
    permission() {
      return permissionState(view)
    },

    /** @returns the permission after an ask made from a user gesture. */
    request() {
      return requestPermission(view)
    },

    /**
     * Show one banner.
     *
     * **Deliberately not gated on the permission.** The permission is reported by
     * {@link permission} and printed by the card, but the decision to try is separate,
     * because in the desktop application the two disagree: the permission reads `denied`
     * while the constructor works. Refusing to try on that basis would be this plugin
     * withholding a banner the platform would have shown — silently, which is the worst
     * available outcome. So the attempt is made, and the outcome is whatever the platform
     * says: `threw` when it refuses, `shown` when it accepted.
     *
     * @param input - `{ title, body, tag, data }`.
     * @returns `{ shown, reason }`: whether a banner was created, and why not when it was
     *   not.
     */
    show(input) {
      const state = permissionState(view)
      if (!state.supported) return { shown: false, reason: 'unsupported' }
      const title = typeof input?.title === 'string' ? input.title : ''
      if (title.trim() === '') return { shown: false, reason: 'empty' }
      let banner
      try {
        banner = new view.Notification(title, notificationOptions(input))
      } catch (error) {
        // A constructor that throws is a real outcome — a platform that refuses banners
        // from this origin — and the card must be able to say so.
        return { shown: false, reason: 'threw', error: messageOf(error) }
      }
      live.add(banner)
      const release = () => live.delete(banner)
      for (const event of ['close', 'error']) {
        try {
          banner.addEventListener?.(event, release)
        } catch {
          /* a banner without addEventListener still shows; only cleanup is lost */
        }
      }
      if (typeof onClick === 'function') {
        try {
          banner.addEventListener?.('click', () => {
            release()
            onClick(input?.data, input)
          })
        } catch {
          /* the banner is up; a click that does nothing is better than no banner */
        }
      }
      return { shown: true, reason: 'shown' }
    },

    /**
     * Take down every banner this notifier raised.
     *
     * Called when the plugin is disposed and when the settings are turned off:
     * a banner left behind by a plugin that no longer exists is a click that
     * goes nowhere.
     * @returns how many were closed.
     */
    closeAll() {
      let closed = 0
      for (const banner of live) {
        try {
          banner.close()
          closed += 1
        } catch {
          /* already gone */
        }
      }
      live.clear()
      return closed
    },

    /** @returns how many banners this notifier believes are still up. */
    liveCount() {
      return live.size
    },
  }

  return notifier
}

/**
 * A short, human-readable message from a thrown value.
 * @param error - whatever was thrown.
 * @returns the message.
 */
function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
