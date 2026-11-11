# 原生任务道（native lane）界面评审 — HAX × Shape of AI

评审日期：2026-11-04 · 评审人：Devin
评审对象：桌面端个人原生源任务视图（codep / pi 道）及 ACS 对照道
证据目录：`D:\E2E-Test\electron\`（`mid-stream.png`、`codep-live.png`、`result.json`、`pi-run\`、`acs-run\`）

## 1. 用户目标与主要操作流程（从实测与代码提取）

**用户目标**：在桌面上向一个本地原生源（codep/pi）或托管源（ACS）下发一条工程任务指令，可信地观察其执行过程与产出，必要时介入（追问、停止、暂停），并在事后核对任务是否真的落地。

**主流程**（`NativeTaskLauncher` → `PersonalNativeTasks` → `useNativeConversation`）：

1. 侧栏「原生项目」选项目 → 「新建原生任务」弹出 launcher
2. launcher 走 `choose()`：REGISTER（幂等）→ PREFLIGHT → TASK_OPTIONS，列出引擎（如 `Codep · codep 0.1.0 codex-core-…`）
3. 输入指令 → `TASK_CREATE`（请求键回执）→ `TASK_ADOPT` 进入会话
4. 会话视图渲染：消息转录 + 运行中 live tail（`生成中…`）+ 执行过程折叠 + 思考折叠 + 待处理输入坞
5. 终态：live tail 由 `ASSISTANT_MESSAGE` 对账清空，头部徽标变 `已完成/失败`

**等待**：live tail 增量渲染（codep 实证 104→4652 字符平滑增长）；`正在提交` 待核对发送行；分页「加载较早内容」。

**纠正/介入**：运行中 composer 可再发输入（`INPUT_SEND`，请求键幂等）；诊断模态内含停止/请求边界暂停/按来源方式继续。

**失败**：`FAILED` 终态 + `task.error` 事件；发送行失败态 + 「核对发送结果」恢复按钮；观察读失败横幅 `观察中断，保留上次事实` + `重新读取`。

**恢复**：SSE 断流 → `RECONNECTING` 状态 + 有限次重订阅 + `Last-Event-ID`/cursor 续传；`记录不完整` 徽标标记不可恢复空洞；会话重开时 `catchingUp` 追平。

## 2. 现状优点（明确保留，不为套参考而改）

| 创新点 | 对应外部条目 | 评价 |
|---|---|---|
| 持久事件 spine + cursor 续传 + `记录不完整`/`观察中断，保留上次事实` | HAX G2（如实披露能力边界）、G10/10C（降级而非假数据）、Shape of AI Caveat | 宁可标注空洞也不编造输出，高于多数同类产品 |
| live tail settle 门控 + `ASSISTANT_MESSAGE` 对账退役 | Shape of AI Stream of Thought「steps into states」 | 增量输出是瞬时态、终态由权威消息接管，语义干净 |
| 请求键回执 + 「核对发送结果」 | HAX G16（后果可感知）、G9（可纠正） | 发送/停止都有幂等回执，恢复路径不依赖信任 |
| 执行过程折叠（工具行计数/状态/耗时） | Shape of AI Stream of Thought「execution logs」 | 已符合「bounded box + details behind a click」 |
| 思考折叠（`THINKING_DELTA`/`REASONING_DELTA` 桶） | Stream of Thought「compact summaries」 | 运行中展开、settle 后收起，符合 progressive disclosure |
| 来源定位折叠 + 引擎/模型标签 | Shape of AI References / Disclosure / Model management；HAX G11-A 局部解释 | 消息级 provenance，保留 |
| 空态引导 `等待来源发布公开消息` | Shape of AI Wayfinders | 不制造假活动，正确 |

## 3. 问题清单

### P0-1 终态任务残留「连接中断，正在重连」

- **位置**：`NativeConversation.tsx` 转录末尾 `native-stream-note`（`!liveTail && streamNote`），`useNativeConversation` 重连状态机。
- **触发**：任务到达终态（SUCCEEDED/FAILED/CANCELLED）后 SSE 通道终止，`streamStatus` 停在 `reconnecting` 或 `liveStream.interrupted`。
- **影响**：`pi-run/failed.png` 实证——任务已「已完成」，正文下方仍挂重连提示。代码核实：`useNativeConversation` 重试 6 次穷尽后不再调度，但 `streamStatus` 停在 `reconnecting`、`interrupted` 保留 `true`，**注记永不消失**。用户读到的是「此任务输出不可靠/传输故障」的假警报，且与头部绿色终态徽标自相矛盾，直接损害对终态结果与持久 spine 的信任。
- **参考**：Shape of AI **Stream of Thought**「Make steps into states…completed」——终态即终态，状态指示必须随态转换收敛；HAX **G3 时机**与 **G10**（错误信号只应在确实在服务降级时出现）。
- **修改**：`streamNote` 与渲染守卫追加 `!taskSettled`（终态不再显示重连注记）；`useNativeConversation` 订阅 effect 在任务终态（detail.status ∈ SUCCEEDED/FAILED/CANCELLED）到达后跳过 `subscribe()`、清除 `interrupted` 并将 `streamStatus` 归 `idle`——终态后事件流本来就已完结，重连无意义。一处守卫 + 一处状态机出口，不加新控件。

### P0-2 运行中无一键停止——停止/暂停埋在「诊断」模态里

- **位置**：`NativeTaskLauncher.tsx:1129` 起的 `native-info-dialog` controls 区（停止原生任务/请求边界暂停/按来源方式继续）；会话主面板无停止入口。
- **触发**：任务运行跑偏、用户想立即终止时。
- **影响**：用户必须知道打开「诊断」→ 找到控制组 → 再操作，三步才能停一个失控 agent；运行中发送按钮仍是「发送」形态，不符合长任务产品的通行心智。
- **参考**：Shape of AI **Controls**：「A stop button should appear in the same place every time and remain clickable until the process is complete」——Claude/Cursor 均把发送键在生成中变为 stop；HAX **G8**（高效撤销 AI 服务）。
- **修改**：任务非终态时，在头部操作区或 composer 右侧常驻一个「停止」控件（直接调现有 `controlStop`，不新增后端）。暂停/继续保留在诊断模态内——codep 暂停为 stub（见 §4），不建议把未实现能力提升到主面板。

### P1-3 「正在提交 · 待核对」发送行不会自动转已受理

- **位置**：转录 `pending` 发送行 + 「核对发送结果」按钮（`useNativeConversation` receipts）。
- **触发**：`INPUT_SEND` 已写回执但用户消息尚未上屏期间。
- **影响**：行一直停在「待核对」，用户得手动点核对才能确认源已受理；实际上 worker spine 已有 `ACCEPTED`/`INPUT_CONSUMED` 事件可作自动回执（codep/pi 事件叶实测存在）。
- **参考**：HAX **G16**（行为后果应及时可感知）；Shape of AI **Stream of Thought**「steps into states: queued→running」——queued 态应在受理后自动转，而非永远等用户核对。
- **修改**：事件叶读到该任务后续 `ACCEPTED`/`INPUT_CONSUMED` 时把对应 pending 行转「已受理」（措辞用受理而非完成，因为该事件只证明被消费）。「核对发送结果」保留为无回执场景的恢复兜底——不删按钮。

### P1-4 思考折叠在三源上覆盖不齐（部分能力未验证）

- **位置**：`NativeTaskLauncher.tsx` thinking 折叠（`conv.thinking` 非空才渲染）。
- **触发**：源发出 `THINKING_DELTA`/`REASONING_DELTA`。
- **影响**：codep 侧 reasoning 变体已接线到通用 delta 写出（`driver.rs` `DeltaBuf.kind`），但 **当前模型是否实际返回 reasoning 内容未验证**；pi 侧依赖 pi-SDK `thinking_delta`，现网 provider 不产出（与 OUTPUT_DELTA 同一上游限制）。渲染层无思考时正确隐藏折叠——现状没有假思考，是对的。
- **参考**：Stream of Thought「compact summaries」与「tailor visibility to context」——无推理内容时不出块是符合预期的。
- **修改**：不改 UI。后端待办：实测 mimo-v2.6-flash 经 opencode 端点是否返回 reasoning；pi 侧如实记录 SDK 限制，不要合成思考内容。

### P1-5 「执行过程」对 codep 工具行的运行时呈现未截图验证

- **位置**：`nativeActivityModel.ts` `mergeNativeActivity`（同时认 `TOOL_START/TOOL_END` 与 `tool.started/tool.completed`，`TOOL_LABELS` 已覆盖 `commandExecution/fileChange/mcpToolCall/dynamicToolCall`）。
- **触发**：源发工具事件。
- **影响**：渲染路径核实存在；但本轮 codep E2E 为纯文本任务，`mid-stream.png` 未见执行过程块——**运行时呈现未验证**。
- **参考**：Stream of Thought「execution logs」「separate plan, execution, and evidence」。
- **修改**：无需改码。验证待办：跑一条必然触发工具调用的 codep 任务（如"列出目录并写文件"），截图确认执行过程行出现且状态流转正确。

### ~~P2-6 侧栏任务行尾单字母徽标~~（复核为误报，撤回）

DOM 复查证实：行尾 `刚刚 C.` / `2 小时 f` 并非状态徽标，而是 `session-row-subtitle` 的**引擎标签**（`Codep`/`Pi`）在小截图中的视觉截断。DOM 文本完整、行 `title` 属性含任务全名——无缺陷，不改。

### P2-7 「连接中断」文案只报现象、不说保住了什么

- **位置**：同 P0-1 注记节点（运行中触发时）。
- **触发**：SSE 断流、重订阅进行中。
- **影响**：用户不知道已收到内容是否保留、是否会补发；对比之下观察横幅 `观察中断，保留上次事实` + `重新读取` 是教科书级的诚实降级。
- **参考**：HAX **G10**/Pattern 10C（降级时告知策略与后果）；Shape of AI **Caveat**。
- **修改**：文案改为「实时输出中断，已收到内容保留，正在重连」——把保留事实讲清，与观察横幅同一语汇。不加按钮（重连是自动的）。

### P3-8（记录项）分页/补读注记现状良好

「部分记录未在当前快照 · 加载较早内容」、trimmed 徽标、`cursorExpired` 语义——符合 HAX G2 如实披露与 Caveat 精神，**保留不动**。

## 4. 尚未核实的后端能力（明确标注）

| 能力 | 状态 |
|---|---|
| codep reasoning → `THINKING/REASONING_DELTA` | driver 已接三个变体 arm；**模型是否返回 reasoning 未验证** |
| codep 暂停/继续 | **已核实**：manifest 如实声明 `pause:false, resume:false`（`execution.pause` 标 NOT_IMPLEMENTED/GAP），渲染层按 `capabilities` 门控隐藏按钮——能力缺口以诚实声明呈现，UI 不会误示可用；driver `pause_turn` 本身仍是 stub，将来声明 `pause:true` 前需先实现 |
| codep 停止 | `capabilities.stop:true` 经 `handle_stop→interrupt` 真实实现，冒烟已验 |
| pi `OUTPUT_DELTA` | 事件 spine 实测无 delta 行：pi-SDK `text_delta` 在当前 provider 组合下不产出，**上游限制，非传输故障** |
| codep 待处理输入坞 | codep 策略为自动应答，理论上永不产生输入请求——坞是否永空**未验证** |
| 执行过程运行时呈现 | 渲染路径已核实，codep 实际工具行的端到端截图**未验证**（见 P1-5） |
| pi 终态重连残留的触发面 | 已在 settle 后场景实证；任务仍在跑时是否同样误报**未验证** |

## 5. 已实际阅读的参考条目

- Microsoft HAX：G8 Support efficient dismissal；G9 Support efficient correction；G10 + Pattern 10C Fall back to other strategies；G11 Make clear why the system did what it did（含 11A 局部解释的自动化偏见警示）；G17 Provide global controls（microsoft.com/en-us/haxtoolkit/guideline/…）
- Shape of AI（shapeof.ai/patterns/…）：Controls（stop 常驻可点/暂停恢复/排队 steering）；Stream of Thought（步骤即状态、执行日志、渐进披露）；Governors 目录（Action plan/Verification/References）；Trust builders（Caveat/Footprints/Disclosure）；Tuners（Model management）

## 6. 相关源码与设计文档

- `apps/codeagent-desktop/src/renderer/personal/NativeConversation.tsx`（live tail/streamNote/状态徽标）
- `apps/codeagent-desktop/src/renderer/personal/useNativeConversation.ts`（订阅/重连/回执/分页）
- `apps/codeagent-desktop/src/renderer/personal/nativeActivityModel.ts`（执行过程映射，双 kind 兼容）
- `apps/codeagent-desktop/src/renderer/app/activity/nativeVisibleTextProjection.ts`（delta/思考/对账投影）
- `apps/codeagent-desktop/src/renderer/personal/NativeTaskLauncher.tsx`（launcher/诊断模态/思考与来源定位折叠）
- `apps/codeagent-desktop/docs/ui-polish-plan-2026-10.md`、`code-review.md`（既有设计脉络）
- 外部合同快照：`codep/docs/codep/worker-host-contract.md`（worker-events/1 帧形状）
