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
  `.${cn('grid')}{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:6px 12px}`,
  // The vertical switcher and its panel, side by side. The switcher is a column of names rather
  // than a row of tabs, because a state name is a phrase rather than a word — six of them in a row
  // wrap onto a second line, and a wrapped tab strip reads as a list of controls rather than as a
  // set of alternatives. Down the side, the names align, the counts line up, and the card sits
  // beside them instead of below them, which is what makes the whole row shorter.
  `.${cn('split')}{align-items:flex-start;gap:14px;display:flex}`,
  `.${cn('pickers')}{flex:none;flex-direction:column;gap:2px;width:170px;display:flex}`,
  `.${cn('picker')}{align-items:center;gap:8px;border:0;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;border-radius:8px;padding:5px 8px;font-family:inherit;font-size:12px;line-height:18px;text-align:left;display:flex;justify-content:space-between}`,
  `.${cn('picker')}:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}`,
  // The selection is a filled row rather than an underlined one: a side tab has no baseline to
  // underline, and the shape a user reads here is the row they are standing on.
  `.${cn('picker')}[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:500}`,
  // A switched-off state is dimmed in the switcher exactly as its card used to be: this is where
  // "this one is off" has to stay legible now that only one card is on screen at a time.
  `.${cn('picker')}[data-off="true"]{opacity:.6}`,
  `.${cn('pickerCount')}{border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);padding:0 6px;font-size:11px;font-variant-numeric:tabular-nums}`,
  `.${cn('side')}{flex:1;min-width:0;display:flex}`,
  // The compact number field: a label and its short box on one line. This is the control that makes
  // the row fit — see {@link NumberField}.
  `.${cn('num')}{align-items:center;gap:8px;min-width:0;display:flex;justify-content:space-between}`,
  `.${cn('numLabel')}{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-width:0}`,
  `.${cn('numBox')}{align-items:center;gap:4px;flex:none;display:inline-flex}`,
  `.${cn('numBox')} .${cn('input')}{width:56px;text-align:right;font-variant-numeric:tabular-nums}`,
  // The spinner takes a third of a five-character box and the value is typed, not clicked.
  `.${cn('numBox')} .${cn('input')}::-webkit-outer-spin-button,.${cn('numBox')} .${cn('input')}::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}`,
  `.${cn('numBox')} .${cn('input')}{-moz-appearance:textfield;appearance:textfield}`,
  `.${cn('numSuffix')}{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;min-width:18px}`,
  // A channel's own controls, indented under the switch that turns them on: the indentation is what
  // says "these belong to that switch" without a second heading.
  `.${cn('group')}{flex-direction:column;gap:6px;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;display:flex}`,
  // The last test's outcome. It renders at normal weight in the secondary colour rather than as a
  // warning: a state that would do nothing is information, not a fault.
  `.${cn('result')}{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}`,
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
    '会话状态变化时告诉你 —— 每个状态一张卡片，各自决定响不响、响多大、什么音色',
  'notification.master': '总开关',
  'notification.masterHint': '关掉之后所有卡片都不再出声',
  'notification.globals': '全局设置',
  'notification.cards': '状态卡片',
  'notification.enabled': '启用这个状态',
  'notification.sound': '播放提示音',
  'notification.volume': '音量',
  'notification.voice': '音色',
  'notification.melody': '旋律',
  'notification.melodyHint': '音名加时值，例如 A5:200ms E6:200ms；off 表示不出声',
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
  'notification.title': "Session notifications",
  'notification.description': "Tells you when a session changes state — one card per state, each deciding whether to sound, how loud, and in what timbre",
  'notification.master': "Master switch",
  'notification.masterHint': "Switched off, no card sounds",
  'notification.globals': "Global settings",
  'notification.cards': "States",
  'notification.enabled': "Alert for this state",
  'notification.sound': "Play a sound",
  'notification.volume': "Volume",
  'notification.voice': "Timbre",
  'notification.melody': "Melody",
  'notification.melodyHint': "note names with lengths, e.g. A5:200ms E6:200ms; off for silence",
  'notification.audition': "Play",
  'notification.test': "Test",
  'notification.reset': "Reset",
  'notification.masterVolume': "Master volume",
  'notification.masterVolumeHint': "multiplied by each card's own level",
  'notification.soundScope': "When sound plays",
  'notification.soundScope.off': "never",
  'notification.soundScope.background': "while the window is not in front",
  'notification.soundScope.always': "always",
  'notification.minGap': "Minimum gap between sounds",
  'notification.repeat': "Do not repeat the same state within",
  'notification.skipFocused': "Stay quiet about the session I am looking at",
  'notification.skipVisible': "Stay completely quiet while the window is in front",
  'notification.testResult.skipped': "nothing would happen for this state",
  'notification.testResult.silent': "neither channel would respond",
  'notification.audio': "Audio",
  'notification.audio.locked': "audio is still locked — press Play once to unlock it",
  'notification.audio.unavailable': "no Web Audio here, so nothing can play",
  'notification.audio.running': "audio ready",
  'notification.audio.uninitialized': "audio not initialized yet",
  'notification.problems': "These cannot be read:",
  'notification.ms': "ms",
  'notification.cardCount': "{count} session(s) in this state",
  'notification.state.question': "Waiting for an answer",
  'notification.state.approval': "Waiting for approval",
  'notification.state.plan': "Waiting for a plan review",
  'notification.state.failed': "Ended with an error",
  'notification.state.done': "Finished",
  'notification.state.running': "Started",
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
 * A labelled short number input.
 *
 * A number field rather than a slider, and the reason is fit rather than taste. This row is a dozen
 * levels and durations, and a slider spends a whole line on each one: the range control has to be wide
 * enough to be draggable, so the label goes above it and the value beside it, and the field ends up
 * three times the height of the number it sets. A short box with a unit on the same line puts the
 * whole field on one row — and it is also the more precise control, which matters for a duration in
 * milliseconds where a slider's step is a guess about the granularity a user wants.
 *
 * The native spinners are hidden in the stylesheet: the box is five characters wide, so a spinner
 * would take a third of it and the value is typed rather than clicked. Range checking happens on the
 * way in, where {@link coerceField} refuses an out-of-range number as it is stored — so the input
 * does not clamp while typing, which is the behaviour that makes a number field hostile: a field that
 * clamps at `1000` on every keystroke turns a typed `1500` into `1000`.
 *
 * `toDisplay` and `fromDisplay` exist because two of the levels are stored as fractions and shown as
 * percentages. Converting at the control rather than storing `80` is deliberate — a settings file
 * reading `masterVolume: 0.8` is the right storage, and one place has to know both spellings.
 *
 * @param props - `{ t, labelKey, value, min, max, step, suffix, onChange, toDisplay, fromDisplay }`.
 * @returns the field element.
 */
function NumberField({ t, labelKey, value, min, max, step, suffix, onChange, toDisplay, fromDisplay }) {
  const shown = typeof toDisplay === 'function' ? toDisplay(value) : value
  return h(
    'label',
    { className: cn('num') },
    h('span', { className: cn('numLabel') }, t(labelKey)),
    h(
      'span',
      { className: cn('numBox') },
      h('input', {
        className: cn('input'),
        type: 'number',
        value: shown,
        min,
        max,
        step,
        inputMode: 'numeric',
        onChange: (event) => {
          const typed = Number.parseFloat(event.target.value)
          // An empty box is a half-typed number, not a zero: turning `0.5` into `0` because the user
          // selected it and started typing would fight them. Only a usable number is sent on.
          if (!Number.isFinite(typed)) return
          onChange(typeof fromDisplay === 'function' ? fromDisplay(typed) : typed)
        },
      }),
      suffix === undefined ? null : h('span', { className: cn('numSuffix') }, suffix),
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
 * **The bell's controls appear only while the bell is on.** The volume, the timbre and the melody
 * are meaningless with the sound switched off, and showing them would bury the switch that turns it
 * back on.
 *
 * **The test result is printed, not logged.** Pressing *Test* answers what this state would do right
 * now, and the answer is a sentence the user can act on rather than a line in a console nobody opens.
 * It is per card, because the state is what was tested and a single row-wide line would be ambiguous
 * the moment a second card was tried.
 *
 * @param props - `{ t, kind, state, count, defaults, result, onChange, onAudition, onTest }`.
 * @returns the card element.
 */
export function StateCard({ t, kind, state, count, defaults, result, onChange, onAudition, onTest }) {
  const off = state.enabled !== true
  const melody = typeof state.melody === 'string' ? state.melody : ''
  const soundOn = state.sound === true
  /** Write one field of this card. @param field @param value */
  const set = (field, value) => {
    onChange(kind, field, value)
  }
  /** A button in this card's action row. @param label @param onClick @returns the element. */
  const button = (label, onClick) =>
    h(
      'button',
      {
        type: 'button',
        className: cn('button'),
        onClick,
      },
      label,
    )

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
      Check({
        t,
        id: `dsh-notification-${kind}-enabled`,
        checked: !off,
        onChange: (value) => {
          set('enabled', value)
        },
        labelKey: 'notification.enabled',
      }),
    ),
    h(
      'div',
      { className: cn('row2') },
      Check({
        t,
        id: `dsh-notification-${kind}-sound`,
        checked: soundOn,
        onChange: (value) => {
          set('sound', value)
        },
        labelKey: 'notification.sound',
      }),
    ),

    // ── the bell, and only the bell's own controls ──────────────────────────
    soundOn
      ? h(
          'div',
          { className: cn('group') },
          h(
            'div',
            { className: cn('grid') },
            h(NumberField, {
              t,
              labelKey: 'notification.volume',
              value: state.volume,
              min: 0,
              max: 1,
              step: 0.05,
              suffix: '%',
              // Stored as a fraction, shown as a percentage — see {@link NumberField}.
              toDisplay: (fraction) => Math.round(fraction * 100),
              fromDisplay: (percent) => percent / 100,
              onChange: (value) => {
                set('volume', value)
              },
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
          h(
            'div',
            { className: cn('actions') },
            button(t('notification.audition'), () => {
              onAudition(kind)
            }),
          ),
        )
      : null,

    // The outcome of the last test, in words.
    result === undefined || result === null
      ? null
      : h('div', { className: cn('result'), role: 'status' }, result),

    h(
      'div',
      { className: cn('actions') },
      button(t('notification.test'), () => {
        onTest(kind)
      }),
      button(t('notification.reset'), () => {
        onChange(kind, undefined, undefined, true)
      }),
    ),
  )
}

/**
 * The row: the master switch, every global setting, then the states as a vertical tab set.
 *
 * `useNotification` is the store hook the slot registry injects — the plugin's own live
 * configuration, so every control reads what the engine is actually running on rather than a copy
 * this component made. The rest of the props are actions, plus the two pieces of *state* that are
 * not configuration: whether audio has been unlocked.
 *
 * ## The shape, and the two attempts before it
 *
 * The first version was one column of everything: about sixty controls, and the complaint it earned
 * was *it takes up too much room*. Splitting that into four tabs fixed the height and lost
 * something: the global settings — the level and the timing limits — ended up one click away from
 * the cards they apply to, and a user changing a volume had to work out whether it was the master
 * one or the state's.
 *
 * What replaced the tabs is a single column with a vertical tab set at the bottom of it:
 *
 * 1. the master switch;
 * 2. every global setting, flat, each on one line — {@link NumberField} is what makes that fit;
 * 3. the state switcher **down the side** of the state card it selects.
 *
 * The switcher went to the side rather than staying a row of tabs because a state's name is a
 * phrase, not a word: six of them across the panel wrap onto a second line, and a wrapped tab strip
 * reads as a list of controls rather than as a set of alternatives. Stacked, the names align, the
 * counts line up, and — the reason this is shorter than the tabbed version at all — the card sits
 * *beside* the names instead of below them.
 *
 * @param props - `{ t, useNotification, permission, audio, onChange, onAudition, onTest, onReset }`.
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
}) {
  // One selector over the whole store: a per-field subscription would be more machinery than the
  // work it saves for a panel this size. `results` — the outcome of each card's last test — arrives
  // through this same read rather than as a prop, because it changes while the panel is open and a
  // prop captured at registration could never update.
  const state = useNotification((snapshot) => snapshot)
  const settings = state?.settings ?? resolveSettings(undefined)
  const counts = state?.counts ?? {}
  const results = state?.results ?? {}
  /** Which state the switcher is showing. The first shipped card is the most common one. */
  const [subject, setSubject] = React.useState(STATE_KINDS[0])
  /** Write one global field. @param field @param value */
  const setGlobal = (field, value) => {
    onChange(undefined, field, value)
  }
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
    
    // ── every global setting, flat ───────────────────────────────────────────
    //
    // One line each, in one grid, with no heading: they are all "how the plugin behaves", and the
    // labels say which is which. A heading over four controls would cost more height than it
    // explains — which is the same argument that put these here instead of behind a tab.
    h(
      'div',
      { className: cn('grid') },
      h(NumberField, {
        t,
        labelKey: 'notification.masterVolume',
        value: settings.masterVolume,
        min: 0,
        max: 1,
        step: 0.05,
        suffix: '%',
        // Stored as a fraction, shown as a percentage — see {@link NumberField}.
        toDisplay: (fraction) => Math.round(fraction * 100),
        fromDisplay: (percent) => percent / 100,
        onChange: (value) => {
          setGlobal('masterVolume', value)
        },
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
      h(NumberField, {
        t,
        labelKey: 'notification.minGap',
        value: settings.minGapMs,
        min: 0,
        max: 10_000,
        step: 100,
        suffix: t('notification.ms'),
        onChange: (value) => {
          setGlobal('minGapMs', value)
        },
      }),
      // A rate limit on a session that flaps between states: it is about the user's attention, not
      // about any one channel.
      h(NumberField, {
        t,
        labelKey: 'notification.repeat',
        value: settings.repeatMs,
        min: 0,
        max: 60_000,
        step: 500,
        suffix: t('notification.ms'),
        onChange: (value) => {
          setGlobal('repeatMs', value)
        },
      }),
      h('div', { className: cn('note') }, `${t('notification.audio')}: ${t(audioKey)}`),
    ),

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


    // ── the states: a vertical switcher and the card it selects ──────────────
    h(
      'div',
      { className: cn('split') },
      h(
        'div',
        { className: cn('pickers'), role: 'tablist', 'aria-label': t('notification.cards') },
        ...STATE_KINDS.map((name) =>
          h(
            'button',
            {
              key: name,
              type: 'button',
              role: 'tab',
              'aria-selected': subject === name ? 'true' : 'false',
              'data-active': subject === name ? 'true' : 'false',
              'data-off': settings.states[name].enabled === true ? 'false' : 'true',
              className: cn('picker'),
              onClick: () => {
                setSubject(name)
              },
            },
            h('span', null, t(`notification.state.${name}`)),
            // The live count, on the switcher rather than on the card: it is what tells a user which
            // state is worth opening without opening any of them.
            counts[name] > 0 ? h('span', { className: cn('pickerCount') }, String(counts[name])) : null,
          ),
        ),
      ),
      h(
        'div',
        { className: cn('side') },
        h(StateCard, {
          key: subject,
          t,
          kind: subject,
          state: settings.states[subject],
          count: counts[subject],
          defaults: STATE_DEFAULTS[subject],
          result: results?.[subject],
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