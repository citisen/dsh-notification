# dsh-notification

一个 [dsh](https://github.com/deepseek-ai/deepseek-harness) 插件：会话需要你的时候告诉你。
**为桌面版而做**，在浏览器里同样可用。

界面在你**正看着它**的时候已经把一切都说了：侧边栏每个会话有状态，对话自己有流式指示。
但只要切到别的应用，它就什么都不说了 —— 而这恰好是长任务在跑的时候。这个插件从房间另一头
回答一个问题 —— *有事情需要我吗？* —— 用的是后台窗口仅有的两个通道：**扬声器**和
**系统通知中心**。

## 它加了什么

*设置 → 通用* 里多出一行 **会话通知**：一个总开关、几个全局旋钮，然后**每个状态一张卡片** ——
每张卡片有自己的开关、自己的提示音、自己的音量、自己的音色、自己的旋律、自己的通知文案。

| 状态 | 判定 | 出厂 |
| --- | --- | --- |
| **等待回答** | agent 提了问题（`ask_user`） | 提示音 + 系统通知 |
| **等待审批** | agent 申请权限 | 提示音 + 系统通知 |
| **等待审阅计划** | agent 提了计划 | 提示音 + 系统通知 |
| **执行出错** | 会话的 agent 报了错 | 提示音 + 系统通知 |
| **执行完成** | 一轮结束，而你还没看它 | 只有提示音 |
| **开始执行** | 一轮开始了 | **默认关闭** |

最后一张默认关闭是刻意的：一轮*开始*不值得打扰任何人。但它仍然是一个状态，而一个没法
表达这件事的插件，等于在替用户做一个本该由设置决定的选择。

## 桌面版就是 Web 版

这一条值得单独说，因为它是整个插件得以成立的原因。桌面版是一个 Electron 外壳，包着同一个
`dsh-web-app` —— 同一个 loopback 服务、同一份客户端插件名册。所以：

- **客户端插件架构原样可用** —— 不需要桌面专用 API、不需要特权通道、不需要第二个 bundle；
- **系统通知就是标准的 Web `Notification` API**，这也是它在浏览器标签页里同样能用的原因；
- **没有 favicon 通道，也没有标签标题通道**，因为桌面窗口没有标签栏。那正是上一个插件的
  通道，而砍掉它们就是这个插件叫新名字而不是改名的全部理由。

## 安装

```sh
dsh plugin --profile desktop add @citisen/dsh-notification
```

然后重启应用。`dsh plugin` 会在 profile 目录里转发给 pnpm，并对齐 `dsh.profile.bundles`；
因为本包声明了 `dsh.bundle`，安装它就会自动追加这一层。

### 从本地检出安装（Windows）

当 profile 与检出位于**不同盘**时，`dsh plugin add <路径>` 不可靠。手工建链接：

```sh
cd "$DSH_HOME/profiles/desktop"
# 在 dependencies 里加 "@citisen/dsh-notification": "link:D:/path/to/dsh-notification"
# 在 dsh.profile.bundles 里加 "@citisen/dsh-notification"，然后：
cmd /c mklink /J node_modules\@citisen\dsh-notification D:\path\to\dsh-notification
# 再往 cordis.patch.yml 里加一行：
#   - id: notification
#     name: '@citisen/dsh-notification'
```

行 id 与浏览器半边的 `NOTIFICATION_NAMESPACE` 必须是同一个字符串 `notification` —— 设置模型
正是靠它找到这份配置。

## 设置

这一行是**控件，不是文档**，而且这是一次刻意的反转。同一家族的上一版插件用一个代码编辑器里的
小语言来配置四个状态，它的理由是真的：四个状态各有样子*和*声音，就是一张表，而表读起来确实
更像表。这里没有"样子"，把那张表撑住的第四列也就不存在了，剩下的就是一个用户得记住字段名的表单。

文档做得好而这里丢掉的两件事，用别的方式买了回来：

- **旋律仍然是文本** —— 它是唯一一个有真实语法、并且值得被生成而不是被点出来的字段；
- **每张卡片都是完整的** —— 没有任何东西藏在模式后面，折叠卡片的只有它自己的开关。

### 旋律

```
A5:200ms E6:200ms          两个音，各响各自的时长
G4 G4 G4 Eb4:680ms         四个音；没写时值的用出厂步调
A5:120ms -:80ms E6:240ms   休止是不发声但占时间的一步
880 1318.5                 赫兹，给没有音名的音高
off                        这个状态不出声
```

音名（`A5`、`C#4`、`Bb3`）、频率、休止。**写了时值的项目就占那么长**：它响这么久，下一个项目
在它结束时起音。没写时值的项目沿用出厂步调 —— 响 130ms、下一个晚 90ms 起音 —— 这才让
`A5 E6` 读起来是一个音程，而不是两声敲击。

读取器读不出来的那一行会被**报出来**，而且只损失它自己那一项：设置文件里的笔误不该让界面
没法告诉你任何事。

### 为什么不用现成的音乐库

这些选项是量过之后才否掉的，不是凭印象：

| 选项 | 为什么不用 |
| --- | --- |
| `abcjs`（解包 5.9 MB） | 它靠**播放时从 GitHub 下载采样音色字体**来发声。一个需要联网的桌面通知就不是通知。 |
| `tone`（解包 5.4 MB） | 依赖 `standardized-audio-context`，里面有特性探测、worklet 和动态 import。这里的插件 bundle 是一个经典脚本，只能 `require` 外壳自己的模块表。 |
| 自己解析 ABC 记谱法 | 为了一个不到两秒的声音，多一门更大、更值得单测的语言。如果以后旋律变长了，值得重新考虑。 |

### 音色

音色是一个**具名预设**，不是一条波形 —— 封闭列表才是卡片能提供"选择"的东西，而旋律保持
"可写、值得生成"。出厂十一种：四条裸波形（`sine`、`triangle`、`square`、`sawtooth`）和七种
敲击／拨弦配方，后者真正成为"乐器"靠的是它的**分音**：

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

### 生成旋律

旋律是唯一一个没法在聊天窗口里靠耳朵迭代的设置，而一段生成出来的旋律的失败方式不是崩溃 ——
是它太长、太响、八度不对、或者节奏不是本意，而这一切是在几分钟后才由一个**被打断的人**发现的。
所以读取器和调度器被做成了一个命令：

```sh
node scripts/analyze-sound.mjs "G4:170ms G4:170ms G4:170ms Eb4:680ms" --voice bell
node scripts/analyze-sound.mjs "A5:220ms -:80ms E6:400ms" --voice marimba --json
node scripts/analyze-sound.mjs --voices
```

它打印每个音的唱名、频率、起始时间、响多久，以及所选音色给它的包络。`--json` 输出同样的数据；
而读取器读不出来的 token 会让它以非零码退出 —— 于是生成器可以拿它当闸门。

## 安静的两条规矩

存在这两条规矩，是为了让插件在**唯一一个它无话可说的场合**不烦人：

- **你正在看的那个会话不是新闻** —— 窗口在前台、而且这个会话就在屏幕上时，界面**就是**通知；
- **提示音受窗口状态约束** —— `background`（出厂值）只在窗口隐藏或失焦时响，`always` 撤掉这道
  门，`off` 关掉整个通道而不动任何一张卡片。

第三个旋钮"同一状态的最短重复间隔"用来限制反复横跳的会话。

## 校验

```sh
npm run check        # 产物同步 + 单测 + 两个半边
npm run check:all    # 外加真实地启动一个 profile
```

| 检查 | 覆盖 |
| --- | --- |
| `node --test` | 纯逻辑的 115 个单测：旋律解析与调度、状态机的边、模板词汇表、通知权限的四种状态、策略（`admit`、`soundAllowed`）、以及引擎的 plan。 |
| `verify-host.mjs` | 宿主半边对**真实 schema 库**：补丁行 id 等于设置命名空间、schema 能把出厂默认值原样往返、57 个字段路径全都是 `volatile` —— 那个"设置页能点但永远存不下去"的失败。 |
| `verify-client.mjs` | **产物 bundle**：信封、只 require 平台单例、两份词典键集一致、样式只用 design token 不用字面色、状态机与引擎跑在产物上，以及 `apply()` 对桩服务、并把设置行真正渲染出来 —— 364 个节点，每个状态一张卡片。 |
| `verify-profile.mjs` | **真实 loader**：镜像 profile 组装出这一行、启动时没有未激活的插件、并在自己的端口上应答。 |

前三项只需要 Node。第四项需要装了桌面版，没装则干净跳过。

## 开发

```sh
npm run build     # src/ -> lib/client.js
npm run watch     # 保存即重建
npm run sound     # 旋律分析器
```

`src/client.js` 是浏览器半边的入口。它写成 ES 模块便于阅读，但 DSH 客户端 bundle 是**经典脚本**，
只能通过 `window.__ModuleLoader__` 注册一个惰性 CommonJS 工厂 —— 所以 `scripts/build-client.mjs`
会套上那个外壳、把平台单例的静态 import 改写成 `require` 绑定，并把本包自己的模块**拼接进工厂的
同一个作用域**（递归地做，因为 `client.js` import `engine.js`，而后者 import `settings.js`）。
里面**没有 JSX**：构建期的 import 改写刻意做得很窄，而一个必须看懂 JSX 的变换就是一个可能看错
它的变换。

### 为什么引擎里没有 React、也没有 DOM

凡是带判断的东西，都放在既不碰 React 也不碰 DOM 的模块里：`states.js` 把界面的可观察对象投影成
每个会话的状态、并把两次观测 diff 成事件；`engine.js` 把一个事件加配置变成一份 plan；`sound.js`
解析旋律并调度它；`system.js` 持有权限状态。这才让这个插件的行为**可断言**而不是**可听见** ——
"我正看着那个会话所以它没响"是一条断言，不是一次观察。

### 被查实的事实

这里读的客户端服务都是从**已发布的代码**里确认的，而不是从文档里 —— 因为这些形状在各版本之间
是会变的：

- `ctx.uiSession.sessionStatus` 是 `Map<会话 id, { running, pendingInteraction, completionUnread }>`
  —— 引擎唯一读取的可观察对象，也是侧边栏自己渲染所依据的那个；
- `ctx.sessions.list` 的行带 `title`（持久的那一个）和 `displayTitle`（合成的），加上 `running`、
  `blank`、`retainedBy.mainView`；
- `pendingInteraction.kind` 是 `'question' | 'approval' | 'plan-review'`，每个会话最多一个类实例，
  它的文本在 `questions[0].question` 上；
- 失败**是事件，不是电平**：`ctx.remote.$on('api-session/error', …)`。状态条目里没有失败位，
  所以 `states.js` 自己记着这个事件 —— 并且把代价也写在那里（没有轮次位置、重连不重放）。

## 包结构

| 路径 | 是什么 |
| --- | --- |
| `lib/index.js` | Node 半边：`notification` 设置 schema，每个字段都 `.volatile()`，以及 `configure({ auto: false })`。 |
| `lib/client.js` | 浏览器半边，**由 `src/` 生成**并投递给界面。 |
| `src/client.js` | 唯一不纯的模块：订阅、两个输出通道、设置行。 |
| `src/states.js` | 会话状态、两次观测之间的边，以及失败日志。 |
| `src/engine.js` | 一个事件加配置 → 该做什么的 plan。 |
| `src/sound.js` | 旋律语法、音色预设、调度器。 |
| `src/system.js` | Web Notification 通道与它的权限状态。 |
| `src/settings.js` | 配置的形状、默认值与策略。 |
| `src/templates.js` | 通知文案与它的占位符词汇表。 |
| `src/row.js` | 设置行：每个状态一张卡片。 |
| `cordis.patch.yml` | 本 bundle 贡献的 profile 层。 |

## 已知限制

- **通知是发出即忘的。** 没有任何办法知道操作系统是否真的画出了那条横幅，所以插件只报告它
  能知道的：构造函数是否抛了、权限是否给了。卡片会写"已被拒绝"，永远不会写"已发出"。
- **请求权限的按钮就是卡片的测试按钮。** 一个没有上下文的权限弹窗，比藏在一个说明了用途的
  控件后面的更糟。
- **点横幅会拉起窗口并尝试选中该会话**，方式是点它自己那一行的元素。这个选择器是对一份本插件
  并不拥有的标记的尽力而为；某个版本改了属性名，损失的是"跳转"，不是通知本身。
- **屏幕上的那个会话不会报"执行完成"。** 控制器对主视图抑制了它自己的未读标志 —— 所以一个用
  "盯着自己刚跑的会话"来测这个功能的用户不会看到它触发；而这恰好也是通知存在的场合。
- **失败事件没有轮次位置，重连也不重放**，所以 `failed` 的含义是"这个会话的 agent 报了一个错"。
- **音频需要一次点击来解锁**，这是浏览器的自动播放策略，绕不过去。卡片上的试听按钮就是最方便的
  那次点击，它存在的部分理由正是这个。
- **设置行只有中英双语**，与内置的语言对一致。

## 许可

MIT
