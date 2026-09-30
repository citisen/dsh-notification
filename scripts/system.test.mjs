/**
 * Unit tests for the system-notification channel.
 *
 * The Web `Notification` API cannot be tested for whether a banner was *drawn* —
 * nothing can — so what is asserted here is everything up to that line: that the
 * plugin asks for permission at the right moment, reports the four permission
 * states apart, builds sane options, and never throws when the constructor does.
 *
 * Usage:  node --test "scripts/*.test.mjs"
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createNotifier, notificationOptions, permissionState, requestPermission } from '../src/system.js'

/**
 * A `Notification` class good enough to stand in for the browser's.
 * @param options - `{ permission, onConstruct, result }`.
 * @returns `{ view, constructed, asked }`.
 */
function fakeView(options = {}) {
  const constructed = []
  const asked = []
  function FakeNotification(title, settings) {
    if (options.onConstruct !== undefined) options.onConstruct(title, settings)
    this.title = title
    this.settings = settings
    this.listeners = new Map()
    this.closed = false
    this.addEventListener = (name, listener) => {
      const list = this.listeners.get(name) ?? []
      list.push(listener)
      this.listeners.set(name, list)
    }
    this.close = () => {
      this.closed = true
      for (const listener of this.listeners.get('close') ?? []) listener()
    }
    constructed.push(this)
  }
  FakeNotification.permission = options.permission ?? 'granted'
  if (options.noRequest !== true) {
    FakeNotification.requestPermission = () => {
      asked.push(true)
      const result = options.result ?? 'granted'
      FakeNotification.permission = result
      return options.rejects === true ? Promise.reject(new Error('denied')) : Promise.resolve(result)
    }
  }
  return { view: { Notification: FakeNotification }, constructed, asked }
}

test('the four permission situations are reported apart', () => {
  assert.deepEqual(permissionState({}), { supported: false, permission: 'unsupported', canAsk: false })
  assert.deepEqual(permissionState({ Notification: class {} }), {
    supported: true,
    permission: 'default',
    canAsk: false,
  })
  const granted = fakeView({ permission: 'granted' })
  assert.deepEqual(permissionState(granted.view), { supported: true, permission: 'granted', canAsk: false })
  const denied = fakeView({ permission: 'denied' })
  assert.deepEqual(permissionState(denied.view), { supported: true, permission: 'denied', canAsk: false })
  // `default` with a way to ask is the only case a card may offer a button for.
  const askable = fakeView({ permission: 'default' })
  assert.deepEqual(permissionState(askable.view), { supported: true, permission: 'default', canAsk: true })
})

test('permission is asked for only when it is the only way forward', async () => {
  const already = fakeView({ permission: 'granted' })
  assert.deepEqual(await requestPermission(already.view), { permission: 'granted' })
  assert.equal(already.asked.length, 0, 'a granted page must not be asked again')

  const refused = fakeView({ permission: 'denied' })
  assert.deepEqual(await requestPermission(refused.view), { permission: 'denied' })
  assert.equal(refused.asked.length, 0)

  const unsupported = await requestPermission({})
  assert.deepEqual(unsupported, { permission: 'unsupported' })

  const noMethod = fakeView({ permission: 'default', noRequest: true })
  assert.deepEqual(await requestPermission(noMethod.view), { permission: 'default' })
})

test('an ask reports the permission that will actually be enforced', async () => {
  const granted = fakeView({ permission: 'default', result: 'granted' })
  assert.deepEqual(await requestPermission(granted.view), { permission: 'granted' })

  const refused = fakeView({ permission: 'default', result: 'denied' })
  assert.deepEqual(await requestPermission(refused.view), { permission: 'denied' })

  // A rejected promise is not an exception: the card reports the unchanged
  // permission rather than an error the user cannot act on.
  const rejected = fakeView({ permission: 'default', rejects: true })
  const result = await requestPermission(rejected.view)
  assert.equal(result.permission, 'default')
})

test('a banner is silent, because the plugin makes its own sound', () => {
  const options = notificationOptions({ title: 'ignored', body: 'B', tag: 'state:1' })
  // `data` is absent rather than `undefined`, which is the point of the filter
  // below: an explicit undefined is not the same thing as no value.
  assert.deepEqual(options, { body: 'B', silent: true, tag: 'state:1' })
  assert.ok(!Object.hasOwn(notificationOptions({ body: 'B' }), 'tag'))
  assert.equal(notificationOptions({}).body, '')
})

test('a notifier shows a banner, tags it, and routes the click', () => {
  const { view, constructed } = fakeView({ permission: 'granted' })
  const clicks = []
  const notifier = createNotifier({ view, onClick: (data) => clicks.push(data) })

  const outcome = notifier.show({ title: 'Deploy is asking', body: 'Which file?', tag: 'question:a', data: { sessionId: 'a' } })
  assert.deepEqual(outcome, { shown: true, reason: 'shown' })
  assert.equal(constructed.length, 1)
  assert.equal(constructed[0].title, 'Deploy is asking')
  assert.equal(constructed[0].settings.body, 'Which file?')
  assert.equal(constructed[0].settings.tag, 'question:a')
  assert.equal(constructed[0].settings.silent, true)

  for (const listener of constructed[0].listeners.get('click') ?? []) listener()
  assert.deepEqual(clicks, [{ sessionId: 'a' }])
  // Clicking takes the banner out of the live set; a later teardown must not
  // try to close it again.
  assert.equal(notifier.liveCount(), 0)
})

test('a notifier attempts the banner whatever the permission says, and reports the outcome', () => {
  // The correction this test records. `Notification.permission` reads `denied` in the
  // desktop application while `new Notification(...)` still constructs — measured — because
  // the shell installs no permission request handler. An earlier version gated on the
  // permission and therefore withheld banners the platform would have shown, silently.
  for (const permission of ['denied', 'default', 'granted']) {
    const { view, constructed } = fakeView({ permission })
    const outcome = createNotifier({ view }).show({ title: 'X' })
    assert.deepEqual(outcome, { shown: true, reason: 'shown' }, `a ${permission} page must still try`)
    assert.equal(constructed.length, 1, `a ${permission} page must reach the constructor`)
  }

  // What it *does* refuse is a case where trying is impossible or meaningless, and it says
  // which of those it is.
  const unsupported = createNotifier({ view: {} })
  assert.deepEqual(unsupported.show({ title: 'X' }), { shown: false, reason: 'unsupported' })

  const granted = fakeView({ permission: 'granted' })
  const empty = createNotifier({ view: granted.view })
  assert.deepEqual(empty.show({ title: '   ' }), { shown: false, reason: 'empty' })
  assert.deepEqual(empty.show({}), { shown: false, reason: 'empty' })
  assert.equal(granted.constructed.length, 0)
})

test('a constructor that throws is reported rather than escaping', () => {
  const { view } = fakeView({
    permission: 'granted',
    onConstruct: () => {
      throw new Error('no notification service')
    },
  })
  const outcome = createNotifier({ view }).show({ title: 'X' })
  assert.equal(outcome.shown, false)
  assert.equal(outcome.reason, 'threw')
  assert.equal(outcome.error, 'no notification service')
})

test('closeAll takes down the banners this plugin raised', () => {
  const { view, constructed } = fakeView({ permission: 'granted' })
  const notifier = createNotifier({ view })
  notifier.show({ title: 'A' })
  notifier.show({ title: 'B' })
  assert.equal(notifier.liveCount(), 2)
  assert.equal(notifier.closeAll(), 2)
  assert.equal(notifier.liveCount(), 0)
  assert.ok(constructed.every((banner) => banner.closed))
  assert.equal(notifier.closeAll(), 0)
})

test('a banner closing on its own leaves the live set alone', () => {
  const { view, constructed } = fakeView({ permission: 'granted' })
  const notifier = createNotifier({ view })
  notifier.show({ title: 'A' })
  const banner = constructed[0]
  for (const listener of banner.listeners.get('close') ?? []) listener()
  assert.equal(notifier.liveCount(), 0)
})

test('a notifier with no click handler still shows the banner', () => {
  const { view, constructed } = fakeView({ permission: 'granted' })
  const notifier = createNotifier({ view })
  assert.equal(notifier.show({ title: 'A' }).shown, true)
  assert.equal(constructed[0].listeners.get('click'), undefined)
})
