/**
 * The settings row: one card per state, plus the switches that apply to all of
 * them.
 *
 * This is the file the previous plugin in this family got wrong, and the mistake
 * is worth naming because the fix is the shape of everything below. That plugin
 * made its configuration a *document* — a small language, edited in a code editor
 * — on the argument that four states each with an appearance and a sound are
 * really one table, and that a table reads better as a table. The argument was
 * defensible for the thing it was configuring, and it is wrong for this one: a
 * notification has no appearance, so there is no fourth column holding the
 * controls together, and what is left is a form whose fields the user has to
 * remember the names of.
 *
 * So the configuration is controls, grouped into a card per state, and the two
 * things a document was good at are bought back another way:
 *
 * - **The melody stays text**, because it is the one field with a real grammar
 *   and the one field worth generating rather than clicking. `scripts/
 *   analyze-sound.mjs` is its editor-side counterpart: it answers what a melody
 *   will sound like without playing it.
 * - **The card is total**, so nothing is hidden behind a mode: every switch, every
 *   level, and both notification strings are visible at once for the state being
 *   edited. The `enabled` switch is what collapses a card, and it is the user's
 *   choice rather than the interface's.
 *
 * There is no JSX anywhere in this plugin. A client bundle here is a classic
 * script whose imports are rewritten by a hand-written build step, and a
 * transformation that has to understand JSX is a transformation that can be wrong
 * about it. `React.createElement` is what the build can already prove it handles.
 *
 * @module dsh-notification/row
 */

import React from 'react'
import { STATE_KINDS } from './states.js'
import { SOUND_SCOPES, STATE_DEFAULTS, resolveSettings } from './settings.js'
import { TEMPLATE_FIELDS, unknownFields } from './templates.js'
import { VOICES, VOICE_NAMES } from './sound.js'

/** The element factory, aliased because `h` reads better than `React.createElement`. */
const h = React.createElement

/**
 * The plugin's own class prefix, so its stylesheet cannot collide with another
 * plugin's and so every element it owns is identifiable in a page it does not own.
 */
export const STYLE_PREFIX = 'dsh-notification'

/** A class name in this plugin's namespace. @param name - the suffix. @returns the class. */
export function cn(name) {
  return `${STYLE_PREFIX}-${name}`
}

/**
 * The stylesheet for the row.
 *
 * Every colour is a design token rather than a literal, which is what makes the
 * row follow the interface's theme instead of the operating system's — the two are
 * not the same thing, and a settings page that ignores the theme switch reads as a
 * control that wandered in from somewhere else.
 */
export const ROW_CSS = [
  `.${cn('row')}{flex-direction:column;gap:16px;display:flex;border-bottom:.5px solid var(--dsw-alias-border-l2);padding:16px 0}`,
  `.${cn('head')}{flex-direction:column;gap:4px;display:flex}`,
  `.${cn('title')}{color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}`,
  `.${cn('desc')}{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}`,
  `.${cn('section')}{flex-direction:column;gap:8px;display:flex}`,
  `.${cn('sectionTitle')}{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}`,
  `.${cn('sectionHint')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('card')}{flex-direction:column;gap:10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-module-platform);padding:12px;display:flex}`,
  `.${cn('card')}[data-off="true"]{opacity:.66}`,
  `.${cn('cardHead')}{align-items:center;justify-content:space-between;gap:12px;display:flex}`,
  `.${cn('cardTitle')}{flex-direction:column;gap:2px;min-width:0;display:flex}`,
  `.${cn('cardName')}{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px}`,
  `.${cn('cardCount')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('check')}{align-items:center;gap:8px;display:flex;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}`,
  `.${cn('check')} input{cursor:pointer;accent-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('field')}{flex-direction:column;gap:4px;display:flex;min-width:0}`,
  `.${cn('label')}{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}`,
  `.${cn('input')}{width:100%;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:12px;line-height:18px;padding:5px 8px}`,
  `.${cn('input')}:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('input')}[data-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}`,
  `.${cn('row2')}{align-items:flex-end;gap:8px;display:flex;flex-wrap:wrap}`,
  `.${cn('range')}{flex:1;min-width:120px;accent-color:var(--dsw-alias-state-business-primary)}`,
  `.${cn('value')}{color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}`,
  `.${cn('actions')}{align-items:center;gap:8px;flex-wrap:wrap;display:flex}`,
  `.${cn('button')}{border:.5px solid var(--dsw-alias-border-l4);background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;border-radius:8px;padding:4px 10px;font-family:inherit;font-size:11px;line-height:16px}`,
  `.${cn('button')}:hover{background:var(--dsw-alias-interactive-bg-hover)}`,
  `.${cn('button')}:disabled{opacity:.5;cursor:default}`,
  `.${cn('problems')}{flex-direction:column;gap:2px;display:flex}`,
  `.${cn('problem')}{color:var(--dsw-alias-state-warn-primary);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px}`,
  `.${cn('note')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('tokens')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}`,
  `.${cn('tokens')} code{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-secondary)}`,
  `.${cn('warning')}{color:var(--dsw-alias-state-warn-primary);font-size:11px;line-height:16px}`,
  `.${cn('grid')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px}`,
].join('')

/**
 * The interface-language copy for this row.
 *
 * `zh` is the key-set source of truth and the English dictionary is compared
 * against it by the tests, which is how a translation that lost a key fails on the
 * command line rather than rendering `notification.melody` to a user.
 */
export const zh = {
  'notification.title': '会话通知',
  'notification.description':
    '会话状态变化时告诉你 —— 每个状态一张卡片，各自决定响不响、响多大、什么音色、系统通知说什么',
  'notification.master': '总开关',
  'notification.masterHint': '关掉之后所有卡片都不再出声、不再弹通知',
  'notification.globals': '全局设置',
  'notification.cards': '状态卡片',
  'notification.cardsHint': '每个状态独立开关。关掉的卡片灰显，但仍然可以编辑。',
  'notification.enabled': '启用这个状态',
  'notification.sound': '播放提示音',
  'notification.volume': '音量',
  'notification.voice': '音色',
  'notification.melody': '旋律',
  'notification.melodyHint': '音名加时值，例如 A5:200ms E6:200ms；off 表示不出声',
  'notification.notification': '系统通知',
  'notification.bannerTitle': '通知标题',
  'notification.bannerBody': '通知正文',
  'notification.templateHint': '可用字段：',
  'notification.unknownField': '这个字段不认识，会原样显示',
  'notification.audition': '试听',
  'notification.test': '测试通知',
  'notification.reset': '恢复默认',
  'notification.masterVolume': '总音量',
  'notification.masterVolumeHint': '与各卡片自己的音量相乘',
  'notification.soundScope': '什么时候出声',
  'notification.soundScope.off': '从不出声',
  'notification.soundScope.background': '窗口不在前台时',
  'notification.soundScope.always': '总是',
  'notification.minGap': '两次提示音的最小间隔',
  'notification.repeat': '同一状态的最短重复间隔',
  'notification.skipFocused': '不要提醒我正在看的那个会话',
  'notification.skipVisible': '窗口在前台时完全安静',
  'notification.desktopNotifications': '允许系统通知',
  'notification.permission': '系统通知权限',
  'notification.permission.granted': '已授权',
  'notification.permission.denied': '已被拒绝 —— 需要在系统设置里允许',
  'notification.permission.default': '尚未询问',
  'notification.permission.unsupported': '这个环境不支持系统通知',
  'notification.permission.ask': '请求授权',
  'notification.testResult.shown': '已发出',
  'notification.testResult.empty': '标题是空的，没有发出',
  'notification.testResult.threw': '系统拒绝了这条通知',
  'notification.testResult.skipped': '这次不会触发',
  'notification.testResult.silent': '没有通道会响应',
  'notification.audio': '音频',
  'notification.audio.locked': '音频还没解锁 —— 点一次「试听」即可',
  'notification.audio.unavailable': '这个环境没有 Web Audio，只有系统通知可用',
  'notification.audio.running': '音频就绪',
  'notification.audio.uninitialized': '音频尚未初始化',
  'notification.problems': '这些内容读不出来：',
  'notification.ms': '毫秒',
  'notification.cardCount': '这个状态有 {count} 个会话',
  'notification.state.question': '等待回答',
  'notification.state.approval': '等待审批',
  'notification.state.plan': '等待审阅计划',
  'notification.state.failed': '执行出错',
  'notification.state.done': '执行完成',
  'notification.state.running': '开始执行',
}

/** English dictionary, checked complete against the `zh` key set by the tests. */
export const en = {
  'notification.title': 'Session notifications',
  'notification.description':
    'Tells you when a session changes state — one card per state, each deciding whether to sound, how loud, in what timbre, and what a desktop banner says',
  'notification.master': 'Master switch',
  'notification.masterHint': 'Switched off, no card sounds and no banner appears',
  'notification.globals': 'Global settings',
  'notification.cards': 'State cards',
  'notification.cardsHint': 'Each state is switched on and off on its own. A card that is off is dimmed but still editable.',
  'notification.enabled': 'Alert for this state',
  'notification.sound': 'Play a sound',
  'notification.volume': 'Volume',
  'notification.voice': 'Timbre',
  'notification.melody': 'Melody',
  'notification.melodyHint': 'note names with lengths, e.g. A5:200ms E6:200ms; off for silence',
  'notification.notification': 'System notification',
  'notification.bannerTitle': 'Notification title',
  'notification.bannerBody': 'Notification body',
  'notification.templateHint': 'available fields: ',
  'notification.unknownField': 'this field is not known, so it is shown as written',
  'notification.audition': 'Play',
  'notification.test': 'Test notification',
  'notification.reset': 'Reset',
  'notification.masterVolume': 'Master volume',
  'notification.masterVolumeHint': 'multiplied by each card’s own level',
  'notification.soundScope': 'When sound plays',
  'notification.soundScope.off': 'never',
  'notification.soundScope.background': 'while the window is not in front',
  'notification.soundScope.always': 'always',
  'notification.minGap': 'Minimum gap between sounds',
  'notification.repeat': 'Do not repeat the same state within',
  'notification.skipFocused': 'Stay quiet about the session I am looking at',
  'notification.skipVisible': 'Stay completely quiet while the window is in front',
  'notification.desktopNotifications': 'Allow system notifications',
  'notification.permission': 'System notification permission',
  'notification.permission.granted': 'granted',
  'notification.permission.denied': 'refused — allow it in your system settings',
  'notification.permission.default': 'not asked yet',
  'notification.permission.unsupported': 'this environment has no system notifications',
  'notification.permission.ask': 'Ask for permission',
  'notification.testResult.shown': 'sent',
  'notification.testResult.empty': 'the title is empty, so nothing was sent',
  'notification.testResult.threw': 'the system refused the notification',
  'notification.testResult.skipped': 'nothing would happen for this state',
  'notification.testResult.silent': 'neither channel would respond',
  'notification.audio': 'Audio',
  'notification.audio.locked': 'audio is still locked — press Play once to unlock it',
  'notification.audio.unavailable': 'no Web Audio here, so only system notifications are available',
  'notification.audio.running': 'audio ready',
  'notification.audio.uninitialized': 'audio not initialized yet',
  'notification.problems': 'These cannot be read:',
  'notification.ms': 'ms',
  'notification.cardCount': '{count} session(s) in this state',
  'notification.state.question': 'Waiting for an answer',
  'notification.state.approval': 'Waiting for approval',
  'notification.state.plan': 'Waiting for a plan review',
  'notification.state.failed': 'Ended with an error',
  'notification.state.done': 'Finished',
  'notification.state.running': 'Started',
}

/**
 * Every key the row's copy must have, for the test that compares the two
 * dictionaries. Derived from `zh` so a key added to one language and forgotten in
 * the other is a failing assertion.
 */
export const MESSAGE_KEYS = Object.keys(zh)

/**
 * A labelled checkbox.
 *
 * Deliberately not the `Switch` from `@deepseek-ai/dsh-client-ui-primitives`,
 * even though that package exports exactly this control. The shipped authoring
 * rule for a third-party bundle is explicit that a client plugin must not
 * `require` a Harness client package: those modules "change without notice", a
 * plain-JavaScript plugin gets no type check, and a component that throws blanks
 * the slot it was registered into. The rule's own remedy is to copy the control
 * and style it from the `--dsw-*` tokens, which is what this file does for every
 * control it needs. The primitives remain the design reference.
 *
 * @param props - `{ t, checked, onChange, labelKey, id }`.
 * @returns the control element.
 */
function Check({ t, checked, onChange, labelKey, id }) {
  return h(
    'label',
    { className: cn('check'), htmlFor: id },
    h('input', {
      id,
      type: 'checkbox',
      checked: checked === true,
      onChange: (event) => {
        onChange(event.target.checked)
      },
    }),
    t(labelKey),
  )
}

/**
 * A labelled slider with its value beside it.
 *
 * A range input rather than a primitive, because the primitives package
 * deliberately ships no slider (its catalog lists buttons, switches, tabs, text
 * inputs, and no numeric control), and a plugin that invented one would be
 * inventing a control rather than borrowing one. The native range input is themed
 * through `accent-color`, so it follows the interface rather than the OS.
 *
 * @param props - `{ t, labelKey, value, min, max, step, onChange, format }`.
 * @returns the field element.
 */
function Slider({ t, labelKey, value, min, max, step, onChange, format }) {
  const shown = typeof format === 'function' ? format(value) : String(value)
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h(
      'div',
      { className: cn('row2') },
      h('input', {
        className: cn('range'),
        type: 'range',
        min,
        max,
        step,
        value,
        onChange: (event) => {
          onChange(Number.parseFloat(event.target.value))
        },
      }),
      h('span', { className: cn('value') }, shown),
    ),
  )
}

/**
 * A labelled one-line text input.
 *
 * @param props - `{ t, labelKey, value, onChange, placeholder, invalid }`.
 * @returns the field element.
 */
function TextField({ t, labelKey, value, onChange, placeholder, invalid }) {
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h('input', {
      className: cn('input'),
      type: 'text',
      value,
      placeholder,
      spellCheck: false,
      'data-invalid': invalid === true ? 'true' : undefined,
      onChange: (event) => {
        onChange(event.target.value)
      },
    }),
  )
}

/**
 * A labelled dropdown over a closed set of names.
 *
 * @param props - `{ t, labelKey, value, options, onChange, describe }`.
 * @returns the field element.
 */
function Choice({ t, labelKey, value, options, onChange, describe }) {
  return h(
    'div',
    { className: cn('field') },
    h('div', { className: cn('label') }, t(labelKey)),
    h(
      'select',
      {
        className: cn('input'),
        value,
        onChange: (event) => {
          onChange(event.target.value)
        },
      },
      ...options.map((name) =>
        h('option', { key: name, value: name }, describe === undefined ? name : describe(name)),
      ),
    ),
  )
}

/**
 * One state's card.
 *
 * @param props - `{ t, kind, state, count, defaults, onChange, onAudition, onTest }`.
 * @returns the card element.
 */
export function StateCard({ t, kind, state, count, defaults, onChange, onAudition, onTest }) {
  const off = state.enabled !== true
  const melody = typeof state.melody === 'string' ? state.melody : ''
  const unknown = [...unknownFields(state.title), ...unknownFields(state.body)]
  const uniqueUnknown = [...new Set(unknown)]
  /** Write one field of this card. @param field @param value */
  const set = (field, value) => {
    onChange(kind, field, value)
  }

  return h(
    'div',
    { className: cn('card'), 'data-off': off ? 'true' : 'false', 'data-state': kind },
    h(
      'div',
      { className: cn('cardHead') },
      h(
        'div',
        { className: cn('cardTitle') },
        h('div', { className: cn('cardName') }, t(`notification.state.${kind}`)),
        // Only when there is something to say. A live count is genuinely useful — it is
        // how a user tells "three sessions are waiting" from "one" — but a column of six
        // zeroes is noise that makes the one non-zero figure harder to find.
        count > 0 ? h('div', { className: cn('cardCount') }, t('notification.cardCount', { count })) : null,
      ),
      Check({ t, id: `dsh-notification-${kind}-enabled`, checked: !off, onChange: (value) => { set('enabled', value) }, labelKey: 'notification.enabled' }),
    ),
    h(
      'div',
      { className: cn('row2') },
      Check({ t, id: `dsh-notification-${kind}-sound`, checked: state.sound === true, onChange: (value) => { set('sound', value) }, labelKey: 'notification.sound' }),
      Check({ t, id: `dsh-notification-${kind}-notification`, checked: state.notification === true, onChange: (value) => { set('notification', value) }, labelKey: 'notification.notification' }),
    ),
    h(
      'div',
      { className: cn('grid') },
      h(Slider, {
        t,
        labelKey: 'notification.volume',
        value: state.volume,
        min: 0,
        max: 1,
        step: 0.05,
        onChange: (value) => {
          set('volume', value)
        },
        format: (value) => `${String(Math.round(value * 100))}%`,
      }),
      h(Choice, {
        t,
        labelKey: 'notification.voice',
        value: state.voice,
        options: VOICE_NAMES,
        onChange: (value) => {
          set('voice', value)
        },
        describe: (name) => VOICES[name]?.label ?? name,
      }),
    ),
    h(TextField, {
      t,
      labelKey: 'notification.melody',
      value: melody,
      placeholder: defaults.melody,
      onChange: (value) => {
        set('melody', value)
      },
    }),
    h('div', { className: cn('note') }, t('notification.melodyHint')),
    h(TextField, {
      t,
      labelKey: 'notification.bannerTitle',
      value: state.title,
      placeholder: defaults.title,
      onChange: (value) => {
        set('title', value)
      },
    }),
    h(TextField, {
      t,
      labelKey: 'notification.bannerBody',
      value: state.body,
      placeholder: defaults.body,
      onChange: (value) => {
        set('body', value)
      },
    }),
    h(
      'div',
      { className: cn('tokens') },
      t('notification.templateHint'),
      ...TEMPLATE_FIELDS.flatMap((field, index) => [
        index === 0 ? null : ' · ',
        h('code', { key: field.name, title: field.hint }, `{${field.name}}`),
      ]).filter((node) => node !== null),
    ),
    uniqueUnknown.length === 0
      ? null
      : h(
          'div',
          { className: cn('warning') },
          `${t('notification.unknownField')}: ${uniqueUnknown.map((name) => `{${name}}`).join(', ')}`,
        ),
    h(
      'div',
      { className: cn('actions') },
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onAudition(kind)
          },
        },
        t('notification.audition'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onTest(kind)
          },
        },
        t('notification.test'),
      ),
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onChange(kind, undefined, undefined, true)
          },
        },
        t('notification.reset'),
      ),
    ),
  )
}

/**
 * The row: the master switches, then one card per state.
 *
 * `useNotification` is the store hook the slot registry injects — the plugin's own
 * live configuration, so every control reads what the engine is actually running on
 * rather than a copy this component made. The rest of the props are the actions and
 * the two pieces of *state* that are not configuration: whether the system will
 * show a banner, and whether audio has been unlocked.
 *
 * @param props - `{ t, useNotification, onChange, onAudition, onTest, onReset, onAskPermission, permission, audio }`.
 * @returns the row element.
 */
export function NotificationRow({
  t,
  useNotification,
  permission,
  audio,
  onChange,
  onAudition,
  onTest,
  onReset,
  onAskPermission,
}) {
  // One selector over the whole store: the row renders a handful of cards and a
  // dozen controls, and a per-field subscription would be more machinery than the
  // work it saves.
  const state = useNotification((snapshot) => snapshot)
  const settings = state?.settings ?? resolveSettings(undefined)
  const counts = state?.counts ?? {}
  /** Write one global field. @param field @param value */
  const setGlobal = (field, value) => {
    onChange(undefined, field, value)
  }
  const permissionKey = `notification.permission.${permission?.permission ?? 'unsupported'}`
  const audioKey =
    audio?.available === false
      ? 'notification.audio.unavailable'
      : audio?.state === 'running'
        ? 'notification.audio.running'
        : audio?.state === 'suspended'
          ? 'notification.audio.locked'
          : 'notification.audio.uninitialized'

  return h(
    'div',
    { className: cn('row') },
    h(
      'div',
      { className: cn('head') },
      h('div', { className: cn('title') }, t('notification.title')),
      h('div', { className: cn('desc') }, t('notification.description')),
    ),

    Check({
      t,
      id: 'dsh-notification-master',
      checked: settings.enabled === true,
      onChange: (value) => {
        setGlobal('enabled', value)
      },
      labelKey: 'notification.master',
    }),
    h('div', { className: cn('note') }, t('notification.masterHint')),

    h(
      'div',
      { className: cn('section') },
      h('div', { className: cn('sectionTitle') }, t('notification.globals')),
      h(
        'div',
        { className: cn('grid') },
        h(Slider, {
          t,
          labelKey: 'notification.masterVolume',
          value: settings.masterVolume,
          min: 0,
          max: 1,
          step: 0.05,
          onChange: (value) => {
            setGlobal('masterVolume', value)
          },
          format: (value) => `${String(Math.round(value * 100))}%`,
        }),
        h(Choice, {
          t,
          labelKey: 'notification.soundScope',
          value: settings.soundScope,
          options: SOUND_SCOPES,
          onChange: (value) => {
            setGlobal('soundScope', value)
          },
          describe: (name) => t(`notification.soundScope.${name}`),
        }),
        h(Slider, {
          t,
          labelKey: 'notification.minGap',
          value: settings.minGapMs,
          min: 0,
          max: 10_000,
          step: 100,
          onChange: (value) => {
            setGlobal('minGapMs', value)
          },
          format: (value) => `${String(value)} ${t('notification.ms')}`,
        }),
        h(Slider, {
          t,
          labelKey: 'notification.repeat',
          value: settings.repeatMs,
          min: 0,
          max: 60_000,
          step: 500,
          onChange: (value) => {
            setGlobal('repeatMs', value)
          },
          format: (value) => `${String(value)} ${t('notification.ms')}`,
        }),
      ),
      h(
        'div',
        { className: cn('row2') },
        Check({
          t,
          id: 'dsh-notification-desktop',
          checked: settings.desktopNotifications === true,
          onChange: (value) => {
            setGlobal('desktopNotifications', value)
          },
          labelKey: 'notification.desktopNotifications',
        }),
        Check({
          t,
          id: 'dsh-notification-skip-focused',
          checked: settings.skipFocusedSession === true,
          onChange: (value) => {
            setGlobal('skipFocusedSession', value)
          },
          labelKey: 'notification.skipFocused',
        }),
        Check({
          t,
          id: 'dsh-notification-skip-visible',
          checked: settings.skipWhenVisible === true,
          onChange: (value) => {
            setGlobal('skipWhenVisible', value)
          },
          labelKey: 'notification.skipVisible',
        }),
      ),
      h(
        'div',
        { className: cn('actions') },
        h('span', { className: cn('note') }, `${t('notification.permission')}: ${t(permissionKey)}`),
        permission?.canAsk === true
          ? h(
              'button',
              {
                type: 'button',
                className: cn('button'),
                onClick: () => {
                  onAskPermission()
                },
              },
              t('notification.permission.ask'),
            )
          : null,
        h('span', { className: cn('note') }, `${t('notification.audio')}: ${t(audioKey)}`),
      ),
    ),

    h(
      'div',
      { className: cn('section') },
      h('div', { className: cn('sectionTitle') }, t('notification.cards')),
      h('div', { className: cn('sectionHint') }, t('notification.cardsHint')),
      ...STATE_KINDS.map((kind) =>
        h(StateCard, {
          key: kind,
          t,
          kind,
          state: settings.states[kind],
          count: counts[kind],
          defaults: STATE_DEFAULTS[kind],
          onChange,
          onAudition,
          onTest,
        }),
      ),
    ),

    h(
      'div',
      { className: cn('actions') },
      h(
        'button',
        {
          type: 'button',
          className: cn('button'),
          onClick: () => {
            onReset()
          },
        },
        t('notification.reset'),
      ),
    ),
  )
}
