# 原生任务 Pi / Codex 会话界面 Review 与修复实施单

- 日期：2026-11-10
- 代码基线：`main@67aa7bf`
- 评审对象：个人原生任务的 **Pi / Codex 会话视图**，重点是“模型等待用户选择答案”场景
- 截图证据：`C:\Users\吴章锋\Pictures\Screenshots\屏幕截图 2026-11-10 072445.png`
- 本文用途：交给 AI IDE 直接实施；本轮评审只新增本文档，未修改业务代码
- 评审方式：一张实际界面截图 + 当前源码静态核对。**未启动 Electron、未做浏览器实测、未执行测试**，因此响应式和读屏行为仍须按本文验收清单复验

---

## 0. 结论与实施优先级

当前任务协议、问题回答和草稿链路已经存在，不需要重做。主要问题是 **等待用户回答时，界面仍沿用“ agent 正在执行”的展示方式**，造成状态互相矛盾；同时底部状态缺少基本排版，长选项与长思考正文进一步争抢注意力。

按以下顺序实施：

1. **N-01、N-02：先修状态可读性和“等待回答”语义**，这是截图中最直接影响判断的问题。
2. **N-03、N-04：再修问题选项和 composer 分工**，让用户知道在哪里回答、每个按钮会发生什么。
3. **N-05、N-06：降低思考正文和计时器对阅读、读屏的干扰**。
4. **N-07、N-08：补齐回答提交反馈与模型只读标识**。

不做视觉大改版，不引入 UI 库，不新增任务状态，不修改协议、网络请求或任务生命周期。

### 目标布局（等待回答时）

```text
审查下代码  [等待回答]  Pi                         停止  状态  成果  诊断
────────────────────────────────────────────────────────────────────────
消息 / 执行过程
› 思考（历史默认折叠，用户可展开）
────────────────────────────────────────────────────────────────────────
┌ 待回答问题 ────────────────────────────────────────────────────────┐
│ catalog-service 的 Redis 怎么处理？                                │
│ ┌────────────────┐ ┌────────────────┐ ┌────────────────┐           │
│ │ 回退 Redis 集成 │ │ 落地真实缓存    │ │ 只修配置与质量  │           │
│ └────────────────┘ └────────────────┘ └────────────────┘           │
└────────────────────────────────────────────────────────────────────┘
已运行 7分36秒   ·   剩余 1小时52分
┌ 输入框 ────────────────────────────────────────────────────────────┐
│ 补充当前任务（不会回答上方问题）…                                  │
│ 模型 glm-5.3-flash                                           [发送] │
└────────────────────────────────────────────────────────────────────┘
```

宽屏选项可以使用等宽多列，窄屏改单列；具体以完整显示文字、没有孤行和不规则按钮宽度为准，而不是机械追求三列。

---

## 1. 范围约束（必须遵守）

### 1.1 允许修改

| 文件 | 允许修改的内容 |
|---|---|
| `src/renderer/personal/NativeConversation.tsx` | 会话头部派生状态、底部进度区、等待问题提示、思考折叠、回答回执的展示 |
| `src/renderer/personal/NativeQuestion.tsx` | 为选项/授权/自由输入增加展示用 class 或 `data-*`；必要的语义标注 |
| `src/renderer/styles.css` | 仅以 `.native-conversation` 为作用域的问题卡、进度区、思考和 composer 样式 |
| `tests/renderer/native-conversation.test.tsx` | Pi / Codex 等待回答、发送语义、回执展示测试 |
| `tests/renderer/native-conversation-paging.test.tsx` | 进度区、计时器、排队态等现有测试的必要更新 |
| 新增 `tests/renderer/native-question.test.tsx` | 仅在需要拆分问题卡测试时创建 |

### 1.2 明确不改

- 不改普通 ACS 会话、审批卡、执行面板、设置页、Git 页。
- 不改 `src/renderer/app/App.tsx`、全局 `.banner`、侧栏、标题栏。
- 不改 `ConversationHeader.tsx`、`ConversationMessage.tsx` 等共享组件。
- 不改 `useNativeConversation.ts` 的轮询、发送、停止、去重、幂等、回执清理逻辑。
- 不改 `nativeConversationModel.ts`、`nativeVisibleTextProjection.ts` 的数据含义。
- 不改 `PersonalNativeTasks.tsx` 诊断页。
- 不修改 Pi / Codex 原始答案字符串，不增加“推荐答案”，不把第一个选项伪装成默认或推荐项。
- 不将 composer 文本暗中改路由为问题答案，也不擅自禁用原本可用的 steer / follow-up。
- 不处理截图中的搜狗输入法浮层；它不是应用 UI。
- 截图顶部的 ACS 独立连接横幅虽会影响整体观感，但属于全局壳层，**另立任务评审，不在本实施单内顺手修改**。

> `NativeQuestion.tsx` 也被诊断页复用。新增视觉样式必须挂在 `.native-conversation` 下，避免诊断页被连带改版。

---

## 2. 应保留的现有设计

1. 待回答问题固定在 composer 上方，而不是埋在长对话里，方向正确。
2. 每个选项点击后直接走 `NATIVE_INPUT_RESPONSE`，无需再增加“选择后再确认”的步骤。
3. 未知问题方法保持不可操作，不伪造来源不支持的回答通道。
4. composer 草稿按任务持久化，发送能力不可用时仍可写草稿。
5. 停止、状态、成果、诊断入口已经分区，不需要新增底部工具栏。
6. 思考正文有原始文本、截断标记和折叠元素；优化只调整默认展开与排版，不生成 AI 摘要。
7. “状态”详情保留来源真实状态和协议事实；本实施单只改善主界面的派生展示。

---

## 3. 问题清单与修复要求

### N-01 / P0：底部进度信息全部粘连，缺少视觉与语义边界

**截图证据**

底部实际读成：

```text
等待你的回答最近事件 · 等待你的回答 07:21:25无响应 3分17秒时限剩余 1小时52分已运行 7分36秒
```

用户无法快速分清阶段、事件时间、静默时长、执行时限和累计运行时长。

**代码依据**

- `NativeConversation.tsx:404-419` 将多个 `<span>` 直接相邻渲染，文本节点之间没有空白。
- 当前源码没有 `.native-progress-line`、`.native-progress-fact` 的布局规则；`styles.css:1914-1916` 只覆盖 composer chip、footer 和 error。

**修复要求**

- 将阶段与次要事实分成两个明确区域：主阶段 + 可换行的事实组。
- 使用 flex/grid 和真实 `gap`，不要用 JSX 字符串拼接或行首空格充当布局。
- 次要事实使用统一的 `label + value` 形式，例如“最后更新 07:21:25”“已运行 7分36秒”。
- 保留 `data-testid="native-progress"`；为阶段、事实组增加稳定的 class/testid。
- 等待回答时按 N-02 隐藏重复事件和静默警告，只保留有意义的运行/时限信息。
- 非等待态仍需兼容工具名、长错误状态、排队槽位和重连提示，允许换行且不得横向溢出。

**验收**

- 不再出现“回答最近事件”“秒时限”“分已运行”一类粘连。
- 1667×944 截图同场景下，进度区最多两行；窄屏可继续换行，不能挤压 composer。

---

### N-02 / P0：等待用户时被同时描述为“执行中”和“无响应”

**截图证据**

- 头部蓝色徽标是“执行中”。
- 问题卡和底部阶段是“等待你的回答”。
- 同一行又出现“无响应 3分17秒”。

这三者同时出现，会把正常的用户决策时间错误呈现为 agent 卡顿。

**代码依据**

- `NativeConversation.tsx:70` 头部直接使用 `nativeStatus(native)`。
- `nativeConversationModel.ts:491-502` 只按来源任务状态映射，RUNNING 且非静止时为“执行中”；它不知道当前是否有待回答问题。
- `NativeConversation.tsx:152-162` 已把问题存在时的阶段改为“等待你的回答”。
- `NativeConversation.tsx:411-417` 仍同时输出最近事件、超过 15 秒的“无响应”、时限和已运行。

**修复要求**

在 `NativeConversation` 内派生唯一的展示条件，例如：

```ts
const awaitingInput = !taskSettled && questions.length > 0;
```

- `awaitingInput` 时，头部展示“等待回答”并使用 warning/attention tone。
- 来源真实 `native.state` 不改；任务详情里仍可显示“执行中 / RUNNING”等事实。
- `awaitingInput` 时，底部不再显示“无响应”，也不重复“最近事件 · 等待你的回答”。
- 已运行、剩余时限可保留；实时流重连、读取失败等真实异常不能被隐藏。
- 非等待任务仍沿用现有静默提示，不在本次擅自修改 15 秒阈值。
- 终态优先级最高，旧 PENDING 问题不得把已完成/失败/中断的头部重新改成“等待回答”。
- 不为等待回答新增协议状态，不修改全局 `nativeStatus()`；只增加会话视图派生状态。

**验收**

- Pi、Codex 两种引擎在 PENDING 问题下都显示“等待回答”，均无“无响应”。
- 问题消费后，头部能恢复来源对应的执行/等待状态。
- QUEUED、SUCCEEDED、FAILED、CANCELLED 的既有显示不回归。

---

### N-03 / P1：长选项按内容宽度 flex 换行，形成“1 个一行 + 2 个一行”的偶然布局

**截图证据**

第一个选项独占一行，后两个挤在下一行；按钮宽度完全由文字长度决定。长文本的中间选项很重，第三个选项像附属操作，视觉层级并不对应真实业务优先级。

**代码依据**

- `NativeQuestion.tsx:23-31` 所有选项进入同一个 `.approval-actions`。
- `styles.css:162` 使用内容宽度的 flex + wrap。
- `styles.css:1905-1910` 没有针对会话内长选项的布局。

**修复要求**

- 在 `NativeQuestion` 上增加展示用标记，区分普通选项、approval、自由输入；不要通过中文文案猜测类型。
- 普通多选项在会话内使用等宽 grid：宽屏可多列，窄屏一列；同行按钮等高。
- 按钮文本左对齐、垂直居中、允许自然换行；设置合理的 `min-width: 0`、`min-height`、`line-height` 和 `overflow-wrap`。
- 不使用单行 ellipsis，不依赖 title 才能读完整答案。
- 所有选项使用同层级的中性按钮样式。来源未提供推荐信息时，不允许给首项加“推荐”或主按钮高亮。
- confirm / approval 的“批准、拒绝”等短操作继续沿用现有布局，避免把 destructive action 做成大选项卡。
- 保留点击即回答，不增加 radio + 确认按钮的二次操作。

**验收**

- 截图中的三个原始选项完整可读，不再由内容宽度产生孤立首行。
- 2、3、6 个选项以及 200 字单选项均无横向溢出。
- 键盘 Tab 顺序与来源选项顺序一致，focus ring 不被卡片或 dock 裁切。

---

### N-04 / P1：问题卡与 composer 同时可输入，但没有解释二者分工

**截图与代码证据**

- 截图中问题等待回答，composer 仍提示“补充当前任务…”。
- `NativeConversation.tsx:421-425` composer 仍按 steer/follow-up 工作，并不是问题答案输入框。
- 用户若把答案写进下方输入框，实际会发送补充指令，而不是 `INPUT_RESPONSE`。

**修复要求**

- `awaitingInput && canSteer` 时，placeholder 改为“补充当前任务（不会回答上方问题）…”之类的明确文案。
- 在问题 dock 与 composer 之间增加一条持久、简短的情境提示：“请用上方选项回答；下方输入用于补充当前任务。”不要只用 hover tooltip，因为输入后 placeholder 会消失。
- 若当前不可 steer/follow-up，则如实显示“可在此保留草稿”，不得暗示文本已经能够发送。
- 保留现有输入路由和能力门控；不要因为 UI 优化把 composer 内容传给 `respondInput`。
- 是否允许用户在问题未答时继续 steer 仍以来源能力为准，本任务不新增阻断规则。

**验收**

- 点击选项只调用 `NATIVE_INPUT_RESPONSE`。
- composer 发送仍调用 `NATIVE_MESSAGE_CREATE`，请求 kind 与改动前一致。
- 用户输入长草稿后，情境提示仍存在，切换任务后草稿隔离不回归。

---

### N-05 / P1：所有思考块默认展开，长段英文推理压过真正需要用户处理的内容

**截图证据**

同屏至少两大段思考全文，包含长路径、配置名和代码片段；视觉面积远大于当前问题。思考标题“思考”没有任何长度或状态区分。

**代码依据**

- `NativeConversation.tsx:294-301` 对全部 bucket 使用 `open={!taskSettled || undefined}`，即任务未结束时所有思考默认展开。
- `nativeVisibleTextProjection.ts:236-239` 按首次出现顺序返回所有非空思考块。
- `styles.css:1393` 思考正文没有 `white-space: pre-wrap` 和防长 token 溢出规则。
- 截断提示目前只加在正文末尾，长文时用户很难看到。

**修复要求**

- 历史思考默认折叠；仅最新且仍在活动的思考可默认展开。
- `awaitingInput` 时默认全部折叠，优先暴露当前问题；用户手动展开的权利保留。
- 用稳定 `nativeTurnId` 记录用户手动展开/收起，1 秒计时器刷新不能重置用户选择。
- summary 可显示“思考”“第 N 段”“已截断”等已有事实，不生成推测性摘要。
- 正文使用 `white-space: pre-wrap; overflow-wrap: anywhere;`，长 URL、反引号代码、路径均不得撑破布局。
- 可限制阅读行宽，但不要增加嵌套正文滚动区，不要用 CSS 悄悄裁掉正文。
- 不改原始思考文本，不渲染伪造结论，不改变事件投影和消息排序。

**验收**

- 等待回答场景首屏以问题卡为主，不再默认展示所有思考全文。
- 手动展开后经过至少 2 次计时器刷新仍保持原状态。
- 已有的“思考已截断”事实在折叠 summary 也能被发现。

---

### N-06 / P1：每秒刷新的整个进度区是 `role="status"`，可能持续打扰读屏

**代码依据**

- `NativeConversation.tsx:89-94` 非终态任务每秒更新 `now`。
- `NativeConversation.tsx:404` 整个进度区带 `role="status"`。
- 同一区域包含已运行、静默时长、剩余时限，因此 live region 的内容可能每秒变化。

**修复要求**

- 移除外层计时区域的 `role="status"`。
- 只在“阶段”文本上保留独立的 `role="status" aria-live="polite" aria-atomic="true"`，且阶段不包含每秒变化的计时值。
- 计时事实不放在 live region 内；仍可被读屏用户主动浏览，不要简单 `aria-hidden` 隐藏重要信息。
- 新到问题可用一条独立的 polite 提示“有 N 个问题等待回答”，不要自动抢焦点，也不要把整个问题卡在每次计时刷新时重复播报。

**验收**

- fake timers 前进 3 秒，阶段 live region 文本保持不变，只有计时事实变化。
- 阶段从“生成中”变为“等待回答”时仍有可播报的状态节点。
- 页面始终不存在包含每秒计时值的 `role="status"` 容器。

---

### N-07 / P1：回答提交后卡片只变禁用，核对与恢复入口却藏在“状态”弹窗

**代码依据**

- `NativeConversation.tsx:403` 以 `conv.busy || !!conv.pendingInput` 禁用问题。
- `useNativeConversation.ts:490-505` 提交回答后会持久化 pending request 并获取回执。
- `NativeConversation.tsx:358-362` 发送状态、核对按钮、保留回执并继续只在任务详情弹窗内展示。
- composer 下可能显示错误摘要，但用户不能在当前问题卡旁完成核对，容易误以为界面卡死。

**修复要求**

- 当 `pendingInput?.kind === 'INPUT_RESPONSE'` 时，在问题 dock 内显示紧凑回执条：“正在提交回答… / 请求已记录，等待来源处理 / 来源已拒绝”等，复用 `nativeReceiptLabel`。
- 需要人工核对时，在当前区域提供既有 `reconcileInput()` 入口；允许继续时复用既有 `acknowledgeInput()`。
- 不改变自动清理成功回执的现有 effect，不新增重试请求，不生成新 requestKey。
- 回执条只显示当前问题回答；普通 steer/follow-up 的 pending 行为不要混入问题卡。
- 详情弹窗可继续保留完整事实，避免重复展示大段 request JSON。

**验收**

- 传输未返回、来源拒绝、成功消费三种场景均有明确下一步。
- 连续点击选项不会发出第二个请求。
- 成功消费后沿用现有自动清理；REJECTED 不被错误清除。

---

### N-08 / P2：composer 的模型名称像可点击 chip，实际只是静态文本

**代码依据**

- `NativeConversation.tsx:424` 使用通用 `composer-chip` 展示模型。
- `styles.css:648-650` chip 有 hover/selected 外观，但原生任务这里不是按钮，也没有模型切换动作。
- 长模型名会 ellipsis，当前没有完整名称的 title。

**修复要求**

- 原生会话内显示“模型 · glm-5.3-flash”或等价的只读标签。
- 增加 `.native-composer-area .composer-chip` 的静态样式覆盖，取消误导性的 hover/selected 外观；不要修改普通会话 chip。
- 保留完整模型名 title 和可访问名称，截断时仍可核对。
- 不新增模型下拉，不暗示运行中可切换模型。

---

## 4. 关键状态的统一展示规则

| 场景 | 头部 | 底部主阶段 | 次要信息 | 问题/composer |
|---|---|---|---|---|
| Pi / Codex 有待回答问题 | 等待回答 / warning | 可保留“等待你的回答”，但若卡片已清楚表达则避免重复 | 已运行、剩余时限；真实连接异常仍显示 | 问题卡为主；composer 明确“不回答上方问题” |
| 正在生成 | 执行中 | 生成中 | 最后更新时间、必要的静默信息、已运行 | 按现有 steer 能力 |
| 正在执行工具 | 执行中 | 工具名 + 有界详情 | 同上 | 按现有能力 |
| 排队 | 排队中 | 排队中 + 位置/槽位 | “开跑起算”的执行时限 | 不显示“无响应” |
| 等待回答且回答提交中 | 等待回答 | 不显示“无响应” | 当前回答回执 | 问题禁用且有进度/核对说明 |
| 实时流重连 | 来源状态或等待回答 | 不被重连文案替代 | 明确“实时流重连中” | 保留最后可信内容，不伪造成功 |
| 成功/失败/中断 | 既有终态 | 既有终态与结束时间 | 不继续每秒计时 | 终态草稿提示不回归 |
| 不支持的问题方法 | 按来源事实 | 不伪造“可回答” | 可显示限制说明 | 保持禁用及现有说明 |

---

## 5. 推荐实施顺序

### 第一步：先建立展示派生值，不碰数据层

在 `NativeConversationView` 内统一计算：

- `awaitingInput`
- `headerStatus`
- 当前可见的 progress facts
- `thinkingBlocks` / 最新思考 id
- 当前是否为 `INPUT_RESPONSE` pending

避免在 JSX 不同位置分别写近似的 `questions.length` 判断，防止头部、进度和 composer 再次不一致。

### 第二步：调整问题标记和原生作用域 CSS

- `NativeQuestion` 增加 `data-question-kind` 或 class，值来自 `method` / `approval` / 是否有 options。
- 所有新增视觉规则以 `.native-conversation` 开头。
- 复用现有颜色、字号、间距 token；不新增第二套蓝色/黄色，不写死仅适用于暗色的文字颜色。

### 第三步：重构底部 progress 的可访问结构

- 主阶段与计时事实分离。
- 先保证文本和状态正确，再调间距。
- 等待回答时减少事实数量，而不是给所有事实继续加小字。

### 第四步：增加问题旁回执和 composer 情境提示

只复用现有 hook 动作和回执，不改请求流程。

### 第五步：最后处理思考默认折叠和模型只读样式

这两项不能破坏用户手动折叠状态、草稿和现有消息顺序。

---

## 6. 测试要求（AI IDE 必须补齐）

### 6.1 组件测试

优先以 `it.each(['pi', 'codex'])` 覆盖相同交互，避免只修截图中的 Pi。

1. **等待问题主场景**
   - 使用截图标题“catalog-service 的 Redis 怎么处理？”及三个原始选项。
   - `lastEventKind='INPUT_REQUESTED'`，`lastEventAt` 设为数分钟前。
   - 断言头部为“等待回答”。
   - 断言 progress 不含“无响应”，不含重复的“最近事件 · 等待你的回答”。
   - 断言三个选项完整存在。

2. **状态恢复**
   - 问题从 PENDING 变为 CONSUMED 后，头部不再停留“等待回答”。
   - 任务终态 + 旧 PENDING 数据时，终态优先。

3. **发送路由不回归**
   - 点击选项仍发送原 `inputRequestId`、generation、session、turn、command 和 response。
   - composer 仍发送原 steer/follow-up，不调用 `respondInput`。

4. **回答回执**
   - pending 时展示提交状态，选项禁用。
   - rejected 时可看到核对/继续入口。
   - 成功消费后沿用现有自动清理，不多发请求。

5. **读屏与计时**
   - fake timers 前进 3 秒，阶段 live region 不变。
   - 计时节点仍更新，QUEUED 现有“开跑起算”测试继续通过。

6. **思考折叠**
   - 多个 bucket 只默认展开符合条件的最新活动块。
   - awaitingInput 默认折叠。
   - 用户手动 toggle 后，计时 rerender 不重置。

7. **既有能力不回归**
   - 草稿隔离、UTF-8 16,384 字节上限、停止二次确认、排队状态、消息分页与活动交错测试全部保留。

> jsdom 不能证明真实换行、裁切、对比度或读屏效果。结构断言之外必须做下面的可视化验收。

### 6.2 实际界面验收矩阵

| 维度 | 必测内容 |
|---|---|
| 基准复现 | 1667×944，暗色，截图中的三选项 Pi 等待回答场景 |
| Codex | 同样 PENDING select 问题和长文本输出，不只验证引擎标签 |
| 宽度 | 1440×900、1280×800、760×720；检查头部、选项、progress、composer |
| 缩放 | 100% 与 125% UI scale；不能因缩放出现横向滚动 |
| 选项 | 2/3/6 项、超长单项、英文长 token、多问题 dock 滚动 |
| 思考 | 多段长思考、路径/URL、已截断、手动展开后刷新 |
| 状态 | 生成中、工具执行、等待回答、回答提交中、重连、排队、成功、失败、中断 |
| 主题与密度 | 暗色/亮色；standard/detailed 至少各检查一次 |
| 键盘 | Tab 顺序、Enter/Space 激活、focus ring、dock 内滚动后焦点可见 |
| 读屏 | 阶段变化只播报一次，计时器不连续播报，新问题不抢焦点 |

交付前后截图时关闭输入法工具栏，保留完整应用窗口，避免把外部浮层和截图裁切误算为本次 UI 改动。

---

## 7. 完成定义（Definition of Done）

- [ ] N-01 至 N-07 全部完成，N-08 完成或说明不做原因。
- [ ] Pi、Codex 等待回答时均不再同时出现“执行中 + 无响应”。
- [ ] 底部状态无文字粘连，等待回答时无重复事件文案。
- [ ] 选项完整可读、布局稳定、无虚构推荐态。
- [ ] composer 与问题答案的分工持久可见，原请求路由未改变。
- [ ] 思考默认展开策略和用户 toggle 均符合要求。
- [ ] 每秒计时不再位于 live region。
- [ ] 回答提交/拒绝/核对可在当前问题区域完成。
- [ ] 新增样式全部限制在原生会话，不影响普通会话和诊断页。
- [ ] 未修改全局横幅、侧栏、共享消息组件、协议和任务状态机。
- [ ] 运行相关 renderer 测试、`pnpm typecheck`、`pnpm build:renderer`，如实记录结果。
- [ ] 附 Pi 与 Codex 的修复后实际截图；未实测的项目明确标注，不能用单元测试代替视觉验收。

建议执行：

```bash
pnpm vitest run tests/renderer/native-conversation.test.tsx tests/renderer/native-conversation-paging.test.tsx
pnpm typecheck
pnpm build:renderer
```

若新增 `native-question.test.tsx`，一并加入第一条命令。实施完成后检查 `git diff`，确保没有出现本实施单范围之外的文件。

---

## 8. 主要代码索引

- `src/renderer/personal/NativeConversation.tsx:48-70`：会话状态与能力判定
- `src/renderer/personal/NativeConversation.tsx:84-105`：终态、秒级计时、停止确认
- `src/renderer/personal/NativeConversation.tsx:148-163`：当前阶段和最近事件
- `src/renderer/personal/NativeConversation.tsx:259-276`：头部状态与操作
- `src/renderer/personal/NativeConversation.tsx:294-301`：思考块
- `src/renderer/personal/NativeConversation.tsx:333-400`：状态详情与回执
- `src/renderer/personal/NativeConversation.tsx:401-429`：问题 dock、进度区、composer
- `src/renderer/personal/NativeQuestion.tsx:10-33`：问题类型与选项
- `src/renderer/personal/useNativeConversation.ts:490-505`：回答提交（只读参考，不在本次修改）
- `src/renderer/personal/nativeConversationModel.ts:491-507`：来源状态与 pendingQuestions（只读参考）
- `src/renderer/styles.css:145-164`：共享 approval 基础样式（只读参考）
- `src/renderer/styles.css:1380-1393`：思考样式
- `src/renderer/styles.css:1657-1677`：会话头部和 composer 容器
- `src/renderer/styles.css:1861-1922`：原生会话专属样式
