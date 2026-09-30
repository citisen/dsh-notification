/**
 * Templates: the text a notification carries, and the words a user can put in it.
 *
 * A per-state reminder text is only useful if it can say *which* session it is
 * about, so the template is a string with named holes in it:
 *
 *     {title} needs an answer        →  "Refactor the parser needs an answer"
 *     {count} sessions are waiting   →  "3 sessions are waiting"
 *
 * The vocabulary is a closed, documented list rather than an expression language,
 * and that is the deliberate part: this text is edited in a settings card by a
 * person who is looking at the list of words right next to the field, and a
 * template engine with conditionals in it would make "why is my notification
 * empty" unanswerable. A placeholder nobody knows is *reported*, not silently
 * dropped, and the renderer never throws: a broken template must still produce a
 * notification rather than a missing one.
 *
 * @module dsh-notification/templates
 */

/**
 * The words a template may use.
 *
 * `title` and `summary` are the session's own text and are the reason the
 * feature exists — a notification that says only "a session finished" makes the
 * user open the window to find out which one, which is exactly the work the
 * notification was supposed to save.
 */
export const TEMPLATE_FIELDS = [
  { name: 'title', hint: 'the session title' },
  { name: 'summary', hint: "a pending interaction's own text, when it has one" },
  { name: 'state', hint: 'this state in the interface language' },
  { name: 'count', hint: 'how many sessions are in this state right now' },
  { name: 'time', hint: 'the local time, as HH:MM' },
]

/** `{name}`, the only placeholder syntax. */
const PLACEHOLDER = /\{([a-zA-Z0-9_-]+)\}/gu

/**
 * Render one template.
 *
 * Unknown placeholders are left in the text exactly as written and reported, so
 * the card can underline them: leaving them visible is what makes a typo
 * self-diagnosing, whereas dropping them produces a notification with a silent
 * gap in the sentence — the failure mode nobody reports as a bug because it
 * looks like the plugin's own wording.
 *
 * @param template - the template text.
 * @param context - `{ title, summary, state, count, time }`, any of them absent.
 * @returns `{ text, unknown }`: the rendered text and the names nobody knows.
 */
export function renderTemplate(template, context = {}) {
  const source = typeof template === 'string' ? template : ''
  const unknown = []
  const text = source.replace(PLACEHOLDER, (whole, name) => {
    if (!Object.hasOwn(context, name)) {
      if (!unknown.includes(name)) unknown.push(name)
      return whole
    }
    const value = context[name]
    return value === undefined || value === null ? '' : String(value)
  })
  return { text, unknown }
}

/**
 * Which of a template's placeholders are unknown.
 * @param template - the template text.
 * @returns the names, in first-appearance order.
 */
export function unknownFields(template) {
  return renderTemplate(template, {}).unknown
}

/**
 * Fit a rendered line into a notification body without cutting a word in half.
 *
 * Desktop notification bodies are truncated by the operating system at a length
 * this process cannot see, and a title cut mid-word reads as a bug in the
 * plugin. Trimming here, at a word boundary and with an ellipsis, makes the
 * decision visible and testable instead of leaving it to whatever the platform
 * does.
 *
 * @param text - the rendered text.
 * @param limit - the maximum length, in characters.
 * @returns the text, shortened if it had to be.
 */
export function fitLine(text, limit = 120) {
  const collapsed = String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim()
  if (collapsed.length <= limit) return collapsed
  const cut = collapsed.slice(0, Math.max(1, limit - 1))
  const boundary = cut.lastIndexOf(' ')
  // Only break on a word when that does not throw most of the text away: a
  // single very long token (a path, a URL) has no boundary to break on.
  const body = boundary > limit * 0.6 ? cut.slice(0, boundary) : cut
  return `${body.trimEnd()}…`
}

/**
 * The local time as `HH:MM`, from a clock the caller supplies.
 *
 * The clock is a parameter rather than `new Date()` so this is testable, which
 * is the same reason every other decision in this plugin takes its inputs as
 * arguments.
 *
 * @param now - epoch milliseconds.
 * @returns the time.
 */
export function clockTime(now) {
  const date = new Date(now)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}
