# 原生任务道（native lane）界面评审 — HAX × Shape of AI（复评）

评审日期：2026-11-04 · 评审人：Devin
评审对象：桌面端个人原生源任务视图（codep 道）——诊断面「原生任务」+ 会话视图 + 侧栏/活动轨
证据目录：`D:\E2E-Test\electron\2026-11-04-01\`（19 张截图 + `result.json`，由 `scripts/sweep-ui-e2e.mjs` 驱动实测，非设计稿推演）
前序评审：`native-lane-hax-shapeofai-review-2026-11.md`（本文档同时记录其修复项的复验结果）

## 1. 用户目标与主要操作流程（从本轮实测提取）

**用户目标**：在桌面端向本机原生源（codep）下发一条工程指令，可信地观察执行过程与产出，必要时追问或停止，并在事后核对任务是否真正落地。

**主流程**（`PersonalNativeTasks` → 侧栏 `nativeSelection` → `NativeConversation`）：

1. 底栏「原生任务诊断」图标 → 「原生任务」诊断面：任务列表 + 新建任务表单（项目下拉 → 引擎/基线预检行 → 任务要求 → 开始原生任务）
2. `TASK_CREATE` 受理 → 页面停留在诊断面，显示裸 task-id 与「任务事实」（状态 RUNNING、worker/store/原生会话 ID）
3. 用户在左侧栏点击新任务行 → 打开会话视图：头部指令标题 + 状态徽标 + 引擎标签，工具行「停止 / 状态 / 成果 / 诊断」
4. 「状态/诊断」打开「任务详情」模态：执行过程折叠 + 任务诊断（原文 JSON）；「成果」按 items 门控
5. 运行中 composer 可发追问（本测「请再补一句中文总结」成功，来源消费后多轮回复陆续到达）
6. 终态徽标 `已完成/已中断`；消息级「来源定位」折叠可核对 msgId/修订/segment/generation
7. 第二任务实测停止：头部「停止」→ 徽标 `已中断`，composer 变草稿态

**等待场景**：执行中徽标 + 消息逐条落账；向上滚动时「回到最新内容」浮钮出现（截图 21 实证）；「加载较早内容」分页按钮（本轮未触发）。

**纠正场景**：运行中 composer 直发追问（steer/follow-up 由能力门控自动分流）；草稿 localStorage 持久化。

**失败场景**：本轮未触发任务失败；`result.json.errors` 仅记录「成果」按钮 disabled 导致点击超时（见 P0-2）；无 pageerror/console 错误。

**恢复场景**：「只读恢复原请求」按 requestKey 找回原任务（截图 04-05 实证恢复 task-b503d0c3）；「查找手机和其他端任务」接续入口在场；SSE 终态退役逻辑生效（streamNoteOnSettled=0）。

## 2. 上轮评审修复项复验

| 上轮问题 | 本轮证据 | 结论 |
|---|---|---|
| P0-1 终态残留「连接中断，正在重连」 | `result.json.streamNoteOnSettled=0`；`40-reopen-settled.png` 终态后无重连注记；代码 `NativeConversation.tsx:60` `!taskSettled` 守卫 + `useNativeConversation` settle effect 归位 | ✅ 已修复，实测通过 |
| P0-2 停止埋在诊断模态 | 头部常驻「停止」(`native-stop`)，运行中可点、终态消失；`31-stopped.png` 实测停止 → `已中断`，无多余确认 | ✅ 已修复，符合 Shape of AI Controls「same place, clickable until complete」 |
| P1-5 执行过程运行时呈现未验证 | 本轮特意跑写文件任务，全程「0 项工具活动」 | ⚠️ 现象实证为空，升级为 P1-3 |
| P1-3 pending 行自动转已受理 | 本轮追问行直接显示「来源已消费」，未见长期「待核对」滞留 | ✅ 场景未复现，暂不升级 |
| P2-6 侧栏行尾单字母徽标 | 仍见「刚刚C.」形态，维持上轮结论：为引擎标签视觉截断，非缺陷 | ✅ 维持不改 |

## 3. 现状优点（明确保留，不为套参考而加步骤）

| 创新点 | 对应外部条目 | 评价 |
|---|---|---|
| 头部常驻停止 + 停止回执进诊断模态 | Shape of AI Controls「stop runs in a click… same place every time」 | 一击即达、无确认弹窗，符合 Controls；停止后果由 receipt 兜底而非阻断弹窗 |
| 消息级「来源定位」折叠（msgId/序号/修订/请求键/segment/generation） | Shape of AI Footprints（interface footprints「badges, inline markers, expandable panels」）/ References | 界面层可追溯且默认折叠，是 interface footprints 的教科书实现 |
| 「回到最新内容 / 有新消息」浮钮 | Stream of Thought「progressive disclosure」 | 滚动脱钉时才出现，不常驻干扰 |
| composer 不可发送时仍可写草稿（localStorage 持久化） | HAX G9（efficient correction，输入不丢） | 弱化版 Draft mode，诚实且不打断 |
| 「对话区只保留消息；执行过程、成果与诊断都在详情里」分区 | Stream of Thought「bounded box, details behind a click / tailor visibility to context」 | 信息分层正确 |
| 「观察中断，保留上次事实 + 重新读取」横幅（代码核实，本轮未触发） | HAX G10/Pattern 10C 降级而非假数据 | 诚实降级范本，保留 |
| 「尚无已读取的公开工具活动」「工具完成不代表任务或测试通过」 | Caveat「tie caveats to context」 | 措辞贴场景，保留；但见 P1-3 需按事实分态 |
| 「此来源未提供严格暂停」能力声明按 `capabilities` 门控按钮 | HAX G2（如实披露能力边界） | 未知能力不可操作，正确 |

## 4. 问题清单

### P0-1 「执行中」徽标在回合间隙语义过载，实测 ≥4 分钟无活动迹象

- **位置**：`NativeConversation.tsx` 头部 `nativeStatus(native)` → RUNNING ⇒「执行中」；`useNativeConversation` 2.5 s 串行轮询同一字段。
- **触发**：任务 RUNNING 期间。`result.json.finalState='执行中'`——settle 轮询 96×2.5 s（约 4 分钟）耗尽时徽标仍「执行中」，重开任务后才见「已完成」（`40-reopen-settled.png`）。
- **影响**：截图 16/20 中所有消息均「本条回复已完成」、live tail 未出现、执行过程 0 项——对话区一片静止而头部仍「执行中」。用户无法分辨三种真相：模型仍在产出、回合间空转等下一条消息、或已卡死。长输出任务（`30-stop-visible.png`，900 词故事）更极端：发出后 3.5 s 正文仅指令本身，没有任何「正在生成」迹象。**后端待核实**：这 4 分钟是 codep 真在跑、还是 settle 上报滞后。
- **参考**：Shape of AI **Stream of Thought**「Make steps into states: queued, running, waiting for approval, error, retried, completed… pair with progress cues」——「任务 RUNNING」是一个状态但包含多个截然不同的 UX 态；同条目「tailor visibility to the context」。HAX **G4**（展示与当前情境相关的信息）与 **G3**（按情境决定服务时机）。
- **修改**：不加控件。复用 `detail.native.quiescent`/`localQuiescent`（`NativeConversation.tsx:33` 已取回、模态内已用于「结果未报告」判定）在徽标/副标上区分「回合进行中」与「等待中（可继续输入）」：例如 quiescent=true 且未终态时显示「等待中 · 可继续输入」。代码已算 `running = native?.quiescent !== true`，只欠表面化。**前提**：核实 quiescent 在回合间隙的实时性（见 §5）。

### P0-2 「成果」按钮永久禁用且无解释——E2E 点击超时实证

- **位置**：`NativeConversation.tsx:133` `disabled={!conv.artifacts?.items.length}`；模态内成果分区仅在 `items.length>0 || reasonCode` 时渲染（`:230`）。
- **触发**：本任务真实创建了 `D:\project\worker-state\e2e-project\sweep-e2e.txt`（终态消息自述），但 `NATIVE_ARTIFACTS` 全程返回空 items → 按钮在运行中、settle 后（`40` 图）始终禁用 → Playwright 点击 30 s 超时记入 `result.json.errors`。
- **影响**：禁用控件不携带任何原因；解释文案「来源暂未提供可读取的成果；详细原因见诊断」反而藏在打不开的分区里（reasonCode 为空时整个分区不渲染）。成果入口成为死端：用户看到按钮、得不到「为什么没有、以后会不会有」的答案。**后端待核实**：codep 对写文件任务是否上报 artifacts（未上报 / 滞后 / 无此能力三选一）。
- **参考**：HAX **G2**（如实呈现能力边界——禁用却不解释是最差的 G2 形态）、**G11**（说清系统为什么这么做）；Shape of AI **Caveat**「Place caveats where they naturally align with outputs… at the moment of decision-making」——限制说明应在决策点可见，而非埋在无法到达的折叠里。
- **修改**：二选一的最小改动：① 按钮保持禁用但 `title`/旁边小字写明当前原因（`reasonCode` 或「来源未报告成果」）；② 按钮可点、打开成果分区空态显示同一文案。不加新控件、不删既有 honest-empty 逻辑。优先核实 artifacts 上报链路（§5）再定文案。

### P1-3 「执行过程」对真实写文件任务全程 0 项，空态文案混淆三种真相

- **位置**：任务详情「执行过程」折叠（`NativeConversation.tsx:222`）+ 对话区 `native-process` fold（0 项不渲染）。
- **触发**：本轮 E2E 特意选「创建文件」指令以触发工具活动；对话框显示「执行过程 0 项工具活动 / 尚无已读取的公开工具活动」，终态后对话区仍无 fold（`40` 图）。
- **影响**：一句空态文案同时覆盖「还在读取中」「来源不发布工具级事件」「任务确实没调工具」——用户无法监督 agent 的工具行为，Stream of Thought 的 execution logs 视图缺席，只能凭最终自述文本信任。**上轮 P1-5 的「未验证」本轮转为实证为空**；根因（codep 此路径是否发 `TOOL_START/END` 或 `tool.started/completed`）仍属后端未核实——`nativeActivityModel.mergeNativeActivity` 双 kind 兼容渲染路径已核实存在。
- **参考**：Shape of AI **Stream of Thought**「execution logs… separate plan, execution, and evidence——users should never wonder whether… came from a proposed step or a completed one」；HAX **G2**。
- **修改**：不改渲染管线。空态文案按已知事实分态：任务未终态保持「尚无已读取的公开工具活动」；终态且 0 项改为「来源未公开工具级事件」或按 `coverage`/`reasonCode` 如实措辞。不制造假活动。验证待办见 §5。

### P1-4 创建任务后停在诊断面，承接反馈是一串裸 UUID

- **位置**：`PersonalNativeTasks.create()` → `selectTask` 只更新本页 `taskId`/detail；会话视图由 `App.tsx:4400` 侧栏 `nativeSelection` 驱动，创建动作不设置它。
- **触发**：点「开始原生任务」→ `05-task-created.png`：页面停在诊断面，反馈为 `task-68e8410d-…` 裸文本 + 「任务事实 RUNNING」原始字段；会话要用户自行在侧栏找到新行点开。
- **影响**：「我发起了一个任务」这一动作的后果不可见——没有「已受理，正在执行」的承接、没有去哪看执行的指引；对非测试人员来说裸 UUID 是噪声。
- **参考**：HAX **G16**（立即传达用户行为的后果）、**G7**（高效触达）；Shape of AI **Wayfinders/Nudges**「alert users to actions they can take」。
- **修改**：最小改动二选一：① `TASK_CREATE` 受理后直接 `setNativeSelection(accepted.taskId)` 打开会话（符合「发起→观看」心智，推荐）；② 保留诊断面停留，把 `task-id` 行渲染为「已受理 · task-xxx 短码 → 查看会话」可点链接。不需要新增面板或确认。

### P1-5 运行中 composer 的「插话 / 下一轮」发送语义不可见

- **位置**：`NativeConversation.tsx:34-36`：`canSteer = running && capabilities.steer`，`canFollowUp = !canSteer && followUp`；发送按钮 aria-label/title 随之在「补充当前任务」与「下一轮继续」间隐式切换。
- **触发**：RUNNING 期间用户在 composer 发追问（本轮实测成功）；同一输入框在 steer 能力与 followUp 能力下进入不同语义通道，界面上只有 hover title 可辨。
- **影响**：发送后果不可预判——用户不知道这条输入是插进当前回合还是排为下一轮；发送后回执「来源已消费」也不区分语义。本轮追问行为本身正常，问题是可预期性而非功能。
- **参考**：Shape of AI **Controls**「Let users act in the flow of work — queued tasks… users can break next steps down」（queue steering 的前提是语义可见）；HAX **G16**（行为后果可感知）。
- **修改**：单按钮保留。把 hover-only 的语义提示移到可见处：placeholder 随模式换文案（「发给当前任务…」/「排为下一轮…」），或按钮旁加一行小字沿用现有 `composer-chip` 风格。**后端待核实**：codep 的 steer/followUp 是否可同时为 true（决定文案是否需要二态区分）。

### P2-6 「任务要求」输入框 2 行 vs 16384 字节上限

- **位置**：`PersonalNativeTasks.tsx:167` textarea 未设 `rows`（浏览器默认 2 行）；`04-instruction.png` 中两行指令已出现内部滚动条，只剩尾部可见。
- **触发**：输入超过一行的任务要求。
- **影响**：用户无法通读自己写的指令再发出；16KB 上限与 2 行视口严重失配。
- **参考**：HAX **G7**（高效触达）；通用表单可用性，无对应 AI 专属条目——如实标注为普通可用性问题。
- **修改**：`rows={4}`~`{6}` 或随内容自适应高度（沿用 `NativeTaskLauncher.tsx:118` textarea `rows={4}` 的既有惯例）。一行改动。

### P2-7 回执/状态术语外露为协议黑话

- **位置**：消息行副标「来源已消费」「本条回复已完成」；`nativeReceiptLabel` 全表（CONSUMED/OBSERVED/待核对…）；诊断面「原请求键 / 只读恢复原请求」。
- **触发**：任何收发与恢复操作；`10-running.png` 指令气泡下「来源已消费」、`15` 追问同。
- **影响**：「消费」是协议词，用户语义实为「已送达来源/来源已接收」；「本条回复已完成」与任务级「已完成」同词不同层，易误读为任务已结束（本轮确实长时并存）。诚实性本身是对的——词错，不是事实错。
- **参考**：HAX **G5**（符合用户预期的社会语言习惯）；Shape of AI **Caveat**「Use clear, plain language」、**Footprints**（provenance 保留但界面层词语要人话）。
- **修改**：只改 `nativeReceiptLabel` 等文案表，不改状态机：CONSUMED→「已送达来源」；行级「本条回复已完成」→「本轮已完成」与任务级「已完成」拉开层级。术语对照表随改动同步进文档。**注意**：诊断面（`PersonalNativeTasks`）本就是工程面向表面，「原请求键/只读恢复」类行话可保留不动——分层语汇与「对话区只保留消息」原则一致。

### P2-8 「状态」按钮 play 图标在原生道被误读为「继续」

- **位置**：`NativeConversation.tsx:132` `icon="play"`，紧邻「停止 ■」；对照 `ConversationHeader.tsx:96-101` 普通对话道同一「状态」按钮传了 `dotTone`——dot 存在时图标被状态点替换。
- **触发**：会话头部常驻；`10/12/30` 图均可见「▷ 状态」。
- **影响**：▷ 在停止旁边普遍读作「播放/继续」，与其真实功能（打开任务详情）不符；普通道靠 dotTone 规避了此误读，原生道没传 dotTone 才露出裸 play 图标。
- **参考**：通用图标语义惯例；HAX **G5**（符合预期）。无需 AI 专属条目。
- **修改**：与普通道对齐——给原生道「状态」传 `dotTone`（由 `native.state` 映射 `runStateTone`），或换 `list`/`chart` 图标。沿用既有库、不新造图标体系。

### P2-9 已中断任务 composer 暗示「等待可输入」，实为死端

- **位置**：`NativeConversation.tsx:260` placeholder `canSteer||canFollowUp ? '输入消息…' : '可以先写草稿，等待来源可接收输入'`；终态后两能力判定均 false。
- **触发**：`31-stopped.png`：任务 `已中断`，composer 仍提示「等待来源可接收输入」。
- **影响**：草稿持久化是优点（保留），但「等待」暗示将来可发——终态任务能否再接受输入取决于源能力（**未核实**），大概率永不可达；用户写了草稿无处发送。
- **参考**：HAX **G16**（行为后果如实）/ **G2**；Shape of AI **Controls**（stop 后语义需清楚）。
- **修改**：placeholder 按 `taskSettled` 分态：终态改「任务已结束；草稿保留，新指令请新建原生任务」（或按核实后的源能力如实措辞）。草稿机制不动。

### P3-10（记录项）入口与命名错配

底栏 icon-only「原生任务诊断」打开的是含创建/接续/恢复的任务管理面；新会话卡片的「原生任务」tab 是另一入口（本轮未点击验证其走向）。名称与内容错位，建议 rail 项 title 统一为「原生任务」或在文档中明确诊断面定位。低优先。

### P3-11（观察项）追问触发多条近义微回合

`16/20` 图中 follow-up 后出现 4 条近义短句（「我先定位 e2e-project…」各带「本条回复已完成」+ 独立「来源定位」）。这是 native turn 粒度的忠实呈现，各条 provenance 独立——**不建议为降噪合并**（合并会牺牲 Footprints 完整性）。仅记录：若未来做回合聚合，须保留逐条来源定位入口。

## 5. 尚未核实的后端能力（明确标注）

| 能力 | 状态 |
|---|---|
| codep RUNNING→SUCCEEDED 滞后（≥4 min） | 实测存在；根因是源持续运行还是状态上报延迟 **未核实** |
| `native.quiescent`/`localQuiescent` 回合间隙实时性 | 字段已在 detail 返回并用于「结果未报告」判定；回合间隙是否及时翻转 **未核实**（P0-1 依赖此项） |
| codep artifacts 上报 | 写文件任务全程 items 空；未发/滞后/无能力 **未核实**（P0-2 依赖此项） |
| codep 工具事件（TOOL_START/END 或 `tool.started/completed`） | 渲染路径双 kind 已核实；本指令路径是否产生事件 **未核实**（P1-3 依赖此项） |
| CANCELLED 后是否接受 steer/followUp | P2-9 文案依赖，**未核实** |
| codep steer 与 followUp 是否可同时为 true | P1-5 文案依赖，**未核实** |
| OUTPUT_DELTA live tail 本轮复验 | 上轮实测 104→4652 字符；本轮回合过短未在截图捕获，不算回归 |
| 新会话卡片「原生任务」tab 走向 | 本轮未点击，**未验证** |

## 6. 已实际阅读的参考条目

- Microsoft HAX（microsoft.com/en-us/haxtoolkit/library/guideline/…）：G2 Make clear how well the system can do what it can do；G3 Time services based on context；G4 Show contextually relevant information；G5 Match relevant social norms；G7 Support efficient invocation；G10 + Pattern 10C Fall back to other strategies；G11 Make clear why the system did what it did；G16 Convey the consequences of user actions
- Shape of AI（shapeof.ai/patterns/…，已读正文非首页）：**Controls**（stop 同位常驻可点/queued steering 可见性）；**Stream of Thought**（steps into states / execution logs / separate plan, execution, evidence / tailor visibility）；**Caveat**（决策点可见的限制说明、plain language）；**Footprints**（interface vs system footprints、branching/replay）；**Suggestions/Wayfinders**（入口指引）；**Verification**（按风险匹配摩擦——本轮停止不加确认即符合「低风险不阻断」）

## 7. 相关源码与设计文档

- `src/renderer/personal/NativeConversation.tsx`（头部徽标/停止与详情入口/composer/成果门控/来源定位折叠）
- `src/renderer/personal/useNativeConversation.ts`（2.5 s 串行轮询/artifacts 独立读通道/SSE 终态退役）
- `src/renderer/personal/nativeConversationModel.ts`（`nativeStatus` 状态文案/`nativeReceiptLabel` 回执文案表）
- `src/renderer/personal/nativeActivityModel.ts`（执行过程双 kind 兼容映射）
- `src/renderer/personal/PersonalNativeTasks.tsx`（诊断面：创建/接续/恢复/任务事实）
- `src/renderer/app/App.tsx`（`nativeSelection` 侧栏驱动会话/`NATIVE_DIAGNOSTICS` 挂载点）
- `src/renderer/app/conversation/ConversationHeader.tsx`（普通道 `dotTone` 惯例对照）
- 设计脉络：`docs/ui-polish-plan-2026-10.md`（§6.3 头部操作区）、`docs/native-lane-hax-shapeofai-review-2026-11.md`（前序评审）
- 证据：`D:\E2E-Test\electron\2026-11-04-01\`、`scripts/sweep-ui-e2e.mjs`
