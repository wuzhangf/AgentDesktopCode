# 桌面端全面 UI 评审 — HAX × Shape of AI（第三轮，全功能面）

评审日期：2026-11-04 · 评审人：Devin
评审对象：codeagent-desktop 全部可达面——外壳导航、新会话 launcher（双来源）、ACS 会话道、原生任务道（pi 全生命周期 + codep 复核）、设置/个人接入
证据目录：`D:\E2E-Test\electron\2026-11-04-02\`（34 张截图 + `result.json` + `PLAN.md` 判定规则；由 playwright CDP 驱动实测，非设计稿推演）
前序评审：`native-lane-hax-shapeofai-review-2026-11.md`、`native-lane-hax-shapeofai-review-2026-11-04-01.md`（本文档记录其修复/问题项的复验）

## 1. 用户目标与主要操作流程（从本轮实测提取）

**用户目标**：在同一外壳内完成两类工作——向托管 Agent（ACS）发普通/工作区会话、向本机原生源（pi/codep）下发工程任务；观察执行、在需要时介入（追问/停止/暂停）、事后核对产出与文件变更，并能管理会话（分组/归档/导出/目录授权/接入与设置）。

**主流程**：

1. 底栏图标导航会话/Git/个人接入/设置/原生任务诊断（只读面）；rail 「更多会话栏操作」控制侧栏视图
2. 新建会话卡片选来源：智能体会话（项目/专业智能体/自动只读研究/模型）或原生任务（项目+要求+开始）
3. ACS 道：发消息 → 运行中 composer 终止形态 → 回复落账；头部「变更/状态/终端/证据/导出」+「旁路讨论」协作面板
4. 原生道：诊断面建任务（引擎/基线预检）→ 侧栏行开会话 → 头部徽标/停止/任务详情（执行过程·成果·诊断）
5. 横向：目录面板逐目录授予写入能力；导出会话按消息勾选+预览；Git 面列目录干净度

**等待**：ACS「正在提交…+耗时待同步」；原生「准备中」徽标；分页/有界快照注记。

**纠正**：运行中追问（原生道 steer/follow-up）；草稿持久化（`native-draft-persist=true` 实测）；侧栏视图切换。

**失败**：本轮 `errors` 为空；`skipped` 一项（ATTENTION 无项导航隐藏，符合预期）；`UNREACHABLE` 一项（EXTENSIONS/MISSIONS 死面，代码事实）。

**恢复**：launcher 未受理请求提示「原创建请求…尚未确认受理」+ 诊断面「只读恢复原请求」；导出可撤销勾选；中断任务保留草稿。

## 2. 前两轮评审项复验

| 上轮问题 | 本轮证据 | 结论 |
|---|---|---|
| 终态残留「连接中断」 | `pi-settled-stream-note=0`；`45/46` 无注记 | ✅ 修复持续有效 |
| 停止常驻头部 | pi 任务头部停止在场（42），取消态消失（49） | ✅ |
| 执行过程运行时呈现未验证 | **pi 实证**：`45` 图 fold 出现「· 1 项操作 写入文件1 / 写入文件 +1s 15:26:13 · 已完成」 | ✅ 渲染路径验证通过；**codep 同类任务 0 项进一步收敛为源侧事件缺口**（对照证据，仍记后端未核实） |
| 「成果」禁用无解释（-01 P0-2） | pi 写文件任务 `NATIVE_ARTIFACTS` 同样空 → 按钮同样禁用（46 图）；模态分区带「来源暂未提供可读取的成果」文案但禁用按钮到不了该段 | ⚠️ 缺口跨 codep/pi 两源复现，非 codep 特例；建议不变，见 P1-4 |
| 已中断任务草稿死端（-01 P2-9） | **需修正**：pi 已完成任务 composer 仍可发送（48 图 send enabled，placeholder「输入消息…」）→ 终态≠死端；49 证实仅 CANCELLED 态文案死端 | ⚠️ 部分修正，见 P2-7 |
| 「执行中」语义过载（-01 P0-1） | 本轮 pi 任务短促未复现；codep 侧现象仍成立 | — |
| 「开始聊天 vs 开始会话」 | `App.tsx:4438` 按 `newSessionGoal` 是否为空刻意双态 | ✅ 非缺陷，撤回疑虑 |

## 3. 现状优点（保留，不为套参考加步骤）

| 创新点 | 对应外部条目 | 评价 |
|---|---|---|
| pi 执行过程 fold：操作数·类型桶·逐行耗时+时刻+状态 | Shape of AI Stream of Thought「execution logs」 | 「bounded box + details behind a click」达标 |
| 导出会话：逐条勾选/格式/「隐藏已识别的凭证」/预览/附件清单声明 | Footprints（media footprints 导出可控）+ Consent | 隐私守门与可预期性都好 |
| 目录面板：逐目录「只读/可写」授权 + 用途说明 | Verification「match friction to risk」 | 授权粒度与说明文案对齐 |
| launcher 未受理请求回执提示 + 「只读恢复原请求」 | HAX G16 + G9 | 幂等恢复路径，保留 |
| 「准备中」独立徽标；「正在提交…耗时待同步」 | Stream of Thought「steps into states: queued/running」 | 状态分层如实 |
| 旁路讨论面板（独立预算/冻结材料/不自动回流主 Agent/可取消） | Verification + Shared vision | 创新协作面，保留；命名见 P3-13 |
| ATTENTION 无项时导航隐藏 | G4 | 不制造假入口 |
| 原生道停止一击即达无确认 | Controls「stop runs in a click」 | 维持 |

## 4. 问题清单

### P0-1 「更多会话栏操作」弹层外点失效，常驻跨面并浮在模态上 —— 根因是无样式的 backdrop

- **位置**：`App.tsx:4199-4214`。JSX 有 `<div className="pane-menu-backdrop" onMouseDown={…close} />`，但 **`.pane-menu-backdrop` 在全部样式表中无规则**（全仓唯一引用）——无尺寸无定位，渲染为 0 面积占位，外点永不命中。`.rail-menu-popover` 另有一处 `z-index:40` 硬编码，与命名层 `--z-pane/popover/drawer/toast` 脱轨（styles.css:492）。
- **触发**：打开菜单后不点其中选项，继续任何操作。
- **影响**：菜单在 Git/个人接入/设置/原生诊断/新会话/ACS 会话/原生会话/导出/目录面板等 **15+ 个面切换后仍常驻**（05→70 几乎全部截图可见），并在 `43/47` 浮于「任务详情」模态之上——弹层层级高过 modal，视觉上像 UI 卡死。
- **参考**：普通弹层可用性缺陷，无对应 AI 专属条目，如实标注；按惯例 popover 应外点即关 + 不盖 modal（HAX G4 只沾边：无关信息不应干扰当前任务）。
- **修改**：给 `.pane-menu-backdrop` 补 `position:fixed; inset:0; z-index:calc(var(--z-popover) - 1)`（与 `.file-reference-backdrop:851` 同一手法）；`.rail-menu-popover` 的 `z-index:40` 并入 `--z-popover`。另加兜底：activeSurface/会话/任务切换时 `setRailMenuOpen(false)`。纯样式+一行 effect，不动交互结构。

### P0-2 任务起步即报「实时输出中断，已收到内容保留，正在重连」——起点误报（pi 准备中实证）

- **位置**：`useNativeConversation` 订阅状态机 → `NativeConversation.tsx:60-61` `streamNote`。
- **触发**：`42-pi-running.png`：pi 任务「准备中」、消息数为 0 时已显示该注记。
- **影响**：此刻没有任何「已收到内容」可保留，「中断」也无从谈起——用户第一次开任务就看到传输故障警报，直接透支上轮刚修好的诚实降级机制的可信度（上轮修终态误报，这次是起点误报）。**后端待核实**：pi SSE 是订阅竞态（PREPARING 时 binding/generation 未就绪）还是真连不上。
- **参考**：HAX **G10**/Pattern 10C——降级信号只在真降级时出现；Shape of AI **Caveat**「tie caveats to context」错时即失真；Stream of Thought「steps into states」准备期不是中断态。
- **修改**：渲染守卫追加「曾建立 live 连接或曾收到 delta」（如 `liveStream.lastCursor > 0` 或 bucket 非空才允许显示）；或 PREPARING 阶段抑制。先核实订阅失败根因再定阈值——若为竞态，重订阅成功即自愈、注记本不应上屏。

### P1-3 ACS 转录裸「SUCCEEDED」枚举外露

- **位置**：`App.tsx:4508` `status={message.status}` 直传未映射；对照 `ui/labels.ts:18`、`CliActivityRow.tsx:325` 已有 `SUCCEEDED→已完成` 映射。
- **触发**：`23-acs-reply.png`：用户行与回复行下各一处英文 `SUCCEEDED`。
- **影响**：中文界面混入协议枚举；与同一转录里本地化的「已完成/就绪/正在提交」并存，语汇分裂。
- **参考**：HAX **G5**（符合用户预期语言）；Shape of AI **Footprints**——界面层足迹用人话，枚举留给系统层/导出。
- **修改**：`message.status` 过一遍既有 labels 映射再渲染。一行改动，不新增文案表。

### P1-4 禁用 affordance 无原因说明：「成果」跨源复现 + ACS「终端/证据」同类

- **位置**：`NativeConversation.tsx:133`（成果 `disabled={!items.length}`）；ACS 头部 `conversation-header-terminal/evidence`（result.json finds 记录 disabled）。
- **触发**：pi 写文件任务 `45/46`——执行过程已显示「写入文件」事件而成果仍空；codep 上轮同现 → **缺口跨两源复现**，渲染排除嫌疑；ACS 普通会话终端/证据禁用同样无可见原因。
- **影响**：禁用控件不给「为什么/何时可用」；成果分区的解释文案（「来源暂未提供可读取的成果；详细原因见诊断」，43 实证在场）被禁用按钮挡在门外，只能借道「状态/诊断」绕进。**后端待核实**：artifacts 上报链路（写文件事件有、artifacts 无——两级数据不是一回事）。
- **参考**：HAX **G2**（能力边界如实）、**G11**；Shape of AI **Caveat**「at the moment of decision-making」。
- **修改**：沿用 -01 评审建议并推广到所有禁用 header action：title/旁注写明原因（`reasonCode` 或「来源未报告成果」「当前会话不支持终端」），或允许点击打开对应分区看空态。不新增控件。

### P1-5 「状态」面板空态与转录矛盾：已有 SUCCEEDED 回复却称「没有可查看的运行」

- **位置**：`24-activity-panel.png`：右侧面板空态「当前没有可查看的运行。发送一条消息后，这里会显示真实运行、diff 和活动摘要。」——同一转录里回复已标 `SUCCEEDED`。
- **触发**：普通会话简单问答后打开状态面板。
- **影响**：两面互相矛盾：转录说运行已成功、面板说什么都没运行过。用户对「运行」概念无锚点（消息≠run 的区分未解释）。**后端待核实**：ACS 简单问答是否产生 run 实体（若产生而面板不显示，则是数据问题非文案问题）。
- **参考**：Shape of AI **Stream of Thought**「separate plan, execution, and evidence——keep three views synchronized」；HAX **G4**。
- **修改**：先核实 run 是否产生。若确实无 run：空态补一句区分（如「本条回复已完成；尚无工具/构建运行记录」）；若有 run 未上屏：修数据链路而非文案。

### P1-6 pi 旧快照格式会话缺逐条 provenance 且正文无提示

- **位置**：`45` 图 pi 回复无「本条回复已完成/来源定位」；`47` 诊断自证「消息：旧快照格式 · 分页：未提供 · 覆盖：BOUNDED_PUBLIC_MESSAGES」。
- **触发**：打开 pi 任务会话。
- **影响**：消息级 Footprints 整体缺席是事实降级（可接受——诊断里如实声明了格式），但对话正文没有任何「此来源不提供逐条核对」提示；`native-paging-note` 只在 structured&&!paging 出现，旧格式（!structured）反而零提示——能力最差的路径提示最少。
- **参考**：HAX **G2**；Shape of AI **Caveat**（决策点可见）/ **Footprints**（缺失也要可知）。
- **修改**：`!proj.structured` 时消息区顶部一行注记「此来源不提供逐条消息核对与分页，显示为有界快照」。一条文案，不合成 provenance。

### P2-7 CANCELLED 任务草稿态死端文案（上轮建议细化）

- **位置**：`49-cancelled.png`：composer 「可以先写草稿，等待来源可接收输入」。
- **修正**：48 图证实 SUCCEEDED 的 pi 任务 composer 仍可发送——「终态即死端」不成立，仅 CANCELLED/FAILED 才是。上轮修改建议按 state 细化：仅 `CANCELLED`（及核实后的 FAILED）时改「任务已中断；草稿保留，新指令请新建任务」。草稿持久化机制保留不动。
- **参考**：HAX **G16**；Controls。**后端待核实**：CANCELLED/FAILED 后源是否接受 followUp。

### P2-8 诊断面任务列表为整宽指令大按钮，无状态/引擎徽标

- **位置**：`PersonalNativeTasks.tsx:161` nav 列表；`40` 图：15+ 任务各一整宽指令框纵向堆叠。
- **触发**：诊断面任务量增长后。
- **影响**：扫描困难、无状态/引擎/时间信息；与侧栏紧凑列表重复且更差。
- **参考**：HAX **G4**；属工程面降级问题，低优先。
- **修改**：行尾沿用侧栏样式加 state/engine 小徽标，或行高压缩为单行截断；不必做成分页组件。

### P2-9 「诊断曲面」孤词 + 裸 requestKey 整串

- **位置**：`NativeTaskLauncher.tsx:94`「原创建请求 {requestKey} 尚未确认受理，请先在诊断曲面核对或继续。」——「曲面」全仓仅此一处（其余叫「原生任务（诊断）」）；launcher 顶部裸显完整 `desktop-launch-<uuid>`。
- **触发**：存在未确认受理的创建请求时打开 launcher。
- **影响**：恢复提示本身是优点（保留），但孤立术语 + 整串 UUID 让用户不知道去哪、看什么。
- **参考**：HAX **G5**；Caveat plain language。
- **修改**：改「尚未确认受理，请先在左侧『原生任务』核对或继续」；requestKey 截短显示（`desktop-launch-28a66f…` 样式 + title 全键）。恢复机制不动。

### P3-10 个人接入令牌路径占位符字面双反斜杠

- **位置**：`06` 图 CA 证书路径 placeholder 显示 `D:\\…\\pac-cert.pem`。
- **修改**：占位文本单反斜杠。笔误级。

### P3-11 信息量与术语记录项

- ACS 头部「● 就绪」徽标对普通会话常驻——无信息量但无害，记录。
- Settings「Scheduler 权威状态 SHADOW / 恢复屏障 OPEN / 有效自治：连续推进」——设置面可接受的工程语汇，记录；若面向非开发用户建议 hover 释义。
- Git 面「2461 changed files」裸数正常。

### P3-12 EXTENSIONS/MISSIONS 面不可达（构建期死面）

- `result.json finds`：CommandPalette 无入口（`commandPaletteOpen` 恒 false）→ EXTENSIONS/MISSIONS 本构建不可达。属产品事实非本轮回归：**要么接入口，要么从导航/设置描述中摘除**。记录，不评设计。

### P3-13「旁路讨论与主 Agent 协作」命名

- 功能本身好（见优点）；名称准确但偏长且「旁路」对非开发用户生疏。仅在面向普通用户时建议改名（如「独立问答/侧线研究」），工程定位可不动。记录项。

## 5. 尚未核实的后端能力（明确标注）

| 能力 | 状态 |
|---|---|
| pi SSE 在 PREPARING 即断的根因 | 订阅竞态/传输不支持/token——**未核实**（P0-2 依赖） |
| ACS 简单问答是否产生 run 实体 | 「状态」面板空态与转录矛盾的归因依赖，**未核实**（P1-5 依赖） |
| artifacts 上报链路 | codep+pi 写文件任务均空 items；工具事件有而 artifacts 无，**缺口头寸未定位**（P1-4 依赖） |
| pi 旧快照格式可用的消息级回执 | 决定 P1-6 注记文案，**未核实** |
| codep 工具事件缺口 | pi 对照组反证渲染正常，更趋近源侧不发；**根因仍未核实** |
| CANCELLED/FAILED 后 steer/followUp | P2-7 文案依赖，**未核实**（SUCCEEDED 后 pi 可发已实证） |
| EXTENSIONS/MISSIONS 是否有意隐藏 | 构建配置问题，**未核实** |

## 6. 已实际阅读的参考条目

- Microsoft HAX（microsoft.com/en-us/haxtoolkit/library/guideline/…）：G2、G4、G5、G9、G10+10C、G11、G16
- Shape of AI（shapeof.ai/patterns/…，已读正文）：Controls；Stream of Thought（steps into states / execution logs / three views synchronized）；Caveat（decision-point 可见、plain language）；Footprints（interface/system/media 三层）；Verification（match friction to risk）；Suggestions/Wayfinders

## 7. 相关源码与设计文档

- `src/renderer/app/App.tsx`（rail-menu/backdrop `4199-4214`、message.status 直传 `4508`、双态按钮 `4438`、nativeSelection 驱动 `4400`）
- `src/renderer/styles.css`（`.rail-menu-popover` z40 `492`、`.file-reference-backdrop` `851`、z 层命名 `381-385`；**无 `.pane-menu-backdrop` 规则**）
- `src/renderer/personal/NativeConversation.tsx`、`useNativeConversation.ts`、`nativeConversationModel.ts`、`PersonalNativeTasks.tsx`、`NativeTaskLauncher.tsx`
- `src/renderer/app/conversation/RoundTranscript.tsx`（执行过程 fold/HISTORY 汇总）
- `src/renderer/app/CollaborationPanel.tsx`（旁路讨论）、`WritableCollaborationPanel.tsx`
- `src/renderer/app/ui/labels.ts`、`CliActivityRow.tsx`（既有状态映射，复用对象）
- 设计脉络：`docs/ui-polish-plan-2026-10.md`、`docs/native-lane-hax-shapeofai-review-2026-11.md`、`docs/native-lane-hax-shapeofai-review-2026-11-04-01.md`
- 证据：`D:\E2E-Test\electron\2026-11-04-02\`（含 `PLAN.md` 判定规则与 `result.json` 断言）
