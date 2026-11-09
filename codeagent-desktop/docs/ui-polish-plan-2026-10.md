# CodeAgent Desktop · 界面打磨方案（2026-10，五屏对标版）

> 范围：基于 2026-10-04 的 5 张现网截图（设置·功能与环境 / 终端面板 / 会话+审批设置 / Git 变更页 / 状态摘要），
> 对标 Cursor、Claude Code Desktop、OpenAI Codex App、Windsurf、Zed Agent Panel、VS Code，给出可直接交给 AI IDE 实施的改造设计。
> 与 `docs/ui-modernization-plan.md`（P0–P10）的关系：该文档解决“架构与能力缺口”，本文解决“已上线界面的视觉/交互质量”。
> 本文的 U-Phase 不依赖 P3/P4/P8/P9 未完成项，可以先做；冲突时以本文为准并回填那份文档的实施记录表。

---

## 0. 执行协议（AI IDE 必读）

1. 按 `U0 → U1 → …` 顺序推进，**一次一个 Phase、一个 PR**。U0 是纯缺陷修复，必须最先做。
2. 每个 Phase 结束必须通过：
   - `pnpm typecheck`（四个 tsconfig）
   - `pnpm test`（vitest，`tests/renderer` + `tests/unit`）
3. 红线（沿用 `ui-modernization-plan.md` §0，任何 Phase 不得违反）：
   - 不改 `electron/main`、`electron/preload`、`packages/*` 的协议与安全逻辑；不新增后端 API。
   - 只能用 bundled 依赖，禁止 CDN/外链字体。**本文所有改造都不需要新增 npm 依赖**。
   - fail-closed：UNAVAILABLE / 501 / 截断 / 过期 / 未探测必须显式渲染，不许用假数据或空白掩盖。
   - **保留所有现有 `data-testid`**；新增交互必须加新 `data-testid`。测试里按文案断言的地方，改文案时同步改测试并在 PR 描述中列出。
   - TanStack Query 拥有服务端状态；只有 UI 本地状态（开关、选中、宽度）可以放进组件 state / localStorage。
4. 样式规则：
   - 只用 `src/renderer/styles/tokens.css` 已有的 token（`--fs-*`、`--space-*`、`--radius-*`、`--control-h-*`、`--shadow-*`）和 `styles.css` 已有的调色 token（`--text-*`、`--bg-*`、`--border-*`、`--accent`、`--success/--warning/--danger/--info`）。**不许新写十六进制颜色**（diff 着色例外，要求同时写浅色主题覆盖）。
   - 新样式写进新文件 `src/renderer/styles/panels.css`（U1）、`styles/git.css`（U4）、`styles/terminal.css`（U5），在 `main.tsx` 里 `styles.css` 之后 import；同时删除 `styles.css` 中被替代的旧规则，**不要只叠加覆盖**（现在 `.work-pane-floating` 在 `styles.css` 里定义了 4 次：869/1034/1457/1091 行，就是叠加造成的）。
5. 每个 Phase 完成后，在本文 §14 实施记录表追加一行。

---

## 1. 总体诊断：问题不在“缺功能”，而在“信息没被编辑过”

五屏里的问题可以归为 6 类，后面的每一条都带编号，便于 PR 引用。

| 类别 | 表现 | 主流做法 |
|---|---|---|
| **A. 重复** | 同一标题/说明/按钮出现 2–3 次（设置页标题、终端标题、“管理搜索配置”按钮、工作区说明） | 每个信息只出现一次，层级靠排版区分 |
| **B. 原始值外露** | `MODIFIED`、`decision`、`TOOLCHAIN_NOT_FOUND`、`SANDBOX_STATE_ROOT_PERMISSIONS_UNVERIFIED`、`deepseek/deepseek-v4.1-flash`、`第 0 页` | 显示人话，原始码放 tooltip 或“详情”里 |
| **C. 浮层范式不统一** | 终端面板、状态摘要、审批设置、目录面板四种浮层，四种头部样式、四种关闭按钮位置；还有 eyebrow（“面板 / 状态 / 治理设置”）这种无信息的小标题 | 一种 Panel 外壳 + 一种 Popover/Menu |
| **D. 布局 bug** | 状态摘要的 `×` 掉到标题下方；终端命令输入框被挤到只剩几个字；状态面板下半屏空白，主按钮孤零零在底部 | — |
| **E. 控件挑错了** | 权限模式在 composer 里用的是“设置面板 + 原生 select”；入口按钮叫“审批设置”，看不出当前是什么模式 | Claude Code / Codex：composer 上有一个 chip 显示当前模式，点开是带说明的单选菜单 |
| **F. 密度失衡** | 设置卡片里一行塞 5 个事实；Git diff 没有行号，所有行都铺着底色；侧栏把导航、视图切换、项目树、活动托盘叠在一起 | 主信息大，次信息折叠，状态用图标而不是文字串 |

---

## 2. 逐屏问题清单（带证据）

### 2.1 屏 1 · 设置 › 功能与环境（`settings/pages/FeaturesPage.tsx`、`SettingsCenter.tsx`、`styles/settings.css`）

| # | 问题 | 证据 | 级别 |
|---|---|---|---|
| S1 | **页面标题和说明重复两次**：`SettingsCenter` 已经渲染了 `<h1>{definition.label}</h1><p>{definition.description}</p>`，`FeaturesPage` 又把同样的 title/description 传给 `SettingSection` | `SettingsCenter.tsx:258-259`，`FeaturesPage.tsx:465-468` | P0 |
| S2 | Web 搜索卡片上**有两个“管理搜索配置”按钮**：左边是 `FeatureManagement`，右边是 Service 下发的 `OPEN_SURFACE settings:websearch` action，标签相同 | `FeaturesPage.tsx:665-669` + `681-696` | P0 |
| S3 | 进入设置后**应用左侧会话栏还在**：屏幕上同时有三栏导航（会话栏 / 设置分类 / 内容），内容区只剩一半宽度 | 截图 1；`App.tsx` 中 `.session-rail` 不随 `activeSurface==='SETTINGS'` 隐藏 | P1 |
| S4 | 卡片 meta 行是一串术语：`期望 启用 · 当前生效 启用 · 来源 数据库 · 安装 未知 · 已应用`，用户真正关心的只有“能不能用、要不要处理” | `FeaturesPage.tsx:582-588` | P1 |
| S5 | 失败检查直接显示错误码 `SANDBOX_STATE_ROOT_PERMISSIONS_UNVERIFIED`，处理建议是一段长文，没有可点的修复动作 | `FeaturesPage.tsx:611-621` | P1 |
| S6 | 顶部摘要区（计数 + 11 个 TOC chip + 说明）占了第一屏 1/4；TOC chip 和下面卡片一一对应，信息重复 | `FeaturesPage.tsx:483-516` | P1 |
| S7 | 每张卡片都有右下角“重新检测”按钮和右上角开关，视觉重心在卡片两角来回跳 | 截图 1 | P2 |
| S8 | 分类过多且有重叠：“扩展” vs “功能与环境”（都管 MCP/Skills），“运行时” vs “功能与环境”（都管 Sandbox/Terminal）；“高级”组 4 项 | `settingsRoutes.ts` | P2（只做 IA 建议，见 U6.4） |
| S9 | “全部重新检测”在循环里对同一个 mutation 调多次 `mutate`，`isPending` 只反映最后一次，按钮状态不准 | `FeaturesPage.tsx:497` | P1 |

### 2.2 屏 2 · 终端面板（`TerminalDock.tsx`、`panes/WorkPane.tsx`）

| # | 问题 | 证据 | 级别 |
|---|---|---|---|
| T1 | **标题出现 3 次**：WorkPane eyebrow “面板” + h2 “终端面板” + TerminalDock 自己的 h3 “终端” | `App.tsx:4604`，`WorkPane.tsx:33-36`，`TerminalDock.tsx:995` | P0 |
| T2 | **工作区说明出现 2 次**：header 副标题 `当前工作区 · …` 和工具栏 `工作区 …`，而且两处都被截断 | `TerminalDock.tsx:996` 与 `1021-1024` | P0 |
| T3 | 一行里放了 4 个控件（主按钮 / 命令输入 / 运行 / 高级设置），**命令输入框被挤到只显示“运行命令，如 pnpm c”** | `TerminalDock.tsx:965-989`，截图 2 | P0 |
| T4 | 空态是一个虚线框加一段说明，而主流（VS Code、Cursor、Windsurf）打开终端面板就直接起一个 shell，下方 70% 空白 | `TerminalDock.tsx:1082-1086` | P1 |
| T5 | “未启动”状态 badge 位于右上，与 WorkPane 的钉住/关闭按钮挤在同一视觉区，含义不清 | `TerminalDock.tsx:999` | P2 |
| T6 | 多终端 tab 文案是 `名称 · RUNNING (0)`，直接显示原始状态值 | `TerminalDock.tsx:1014-1015` | P1 |

### 2.3 屏 3 · 会话 + 审批设置浮层（`App.tsx:4381-4505`、`conversation/PermissionModeSelector.tsx`、`ConversationHeader.tsx`）

| # | 问题 | 证据 | 级别 |
|---|---|---|---|
| C1 | composer 上的入口叫“审批设置”，**看不出当前是哪个权限模式**。Claude Code / Codex 都把当前模式直接写在 chip 上（如“自动批准 ▾”），危险模式会变色 | `App.tsx:4505` | P0 |
| C2 | 浮层里用原生 `<select>` 显示 `标准权限 · 需要时询问`，选项说明被截断；右侧状态文字“权限由服务确认后生效”和标题挤在一行 | `PermissionModeSelector.tsx:54-74` | P1 |
| C3 | 一个会话级浮层里混了 4 件事：会话权限、**项目默认权限**（作用域不同）、待处理审批计数、自动批准调度。项目默认值属于设置，待处理审批属于时间线/状态 | `App.tsx:4392-4486` | P1 |
| C4 | composer 底栏控件过多：附件 / 扩展 / 目录 / 审批设置 / 模型（显示完整 id `deepseek/deepseek-v4.1-flash`）/ 用量图标 / 上下文 ▾ / 默认推理 ▾ / 发送，共 9 个 | `App.tsx:4500-4530`，`ComposerModelSelector` `App.tsx:510` | P1 |
| C5 | 会话头部 `Git` 和 `导出` **用的是同一个 `file` 图标**；`Git` 本应用 `branch` | `ConversationHeader.tsx:78,111` | P0 |
| C6 | 会话头部“状态”按钮后面单独插了一个状态点，在按钮外面，看起来像对齐错误 | `ConversationHeader.tsx:89-91` | P2 |

### 2.4 屏 4 · Git 变更页（`EvidencePanels.tsx:521-633` `GitChangesPage`、`DiffPatchView`）

| # | 问题 | 证据 | 级别 |
|---|---|---|---|
| G1 | **页码从 0 开始**：工具栏和底部都显示“第 0 页”；只有一页时上一页/下一页也一直显示 | `EvidencePanels.tsx:586, 611-615` | P0 |
| G2 | 文件头显示原始枚举 `MODIFIED` | `EvidencePanels.tsx:622` | P0 |
| G3 | **diff 没有行号**，没有 old/new 双栏 gutter；`+`/`-` 前缀和代码混在一起 | `DiffPatchView`（`EvidencePanels.tsx:~420-455`） | P1 |
| G4 | 文件列表**从右边截断**：`internal/pkg/bun/postgres/bun_post…`，文件名本身被截掉，目录前缀反而保留。主流做法：文件名优先显示，目录用中间省略或放第二行 | `EvidencePanels.tsx:603`，截图 4 | P1 |
| G5 | 文件列表没有逐文件 `+N −M`，看不出哪个文件改得多 | 同上 | P1 |
| G6 | 顶部统计 `+2526 −2328` **只统计当前页**，但文案像全量 | `EvidencePanels.tsx:564-567` | P1 |
| G7 | “定位文件”按钮放在 patch 末尾，长文件要滚到底才能看到 | `DiffFileBody` `EvidencePanels.tsx:492-499` | P2 |
| G8 | 没有 unified / split 切换，没有“只看此文件”/上一个/下一个文件的键盘操作 | — | P2 |

### 2.5 屏 5 · 状态摘要（`ActivitySummaryPanel.tsx`）

| # | 问题 | 证据 | 级别 |
|---|---|---|---|
| A1 | **关闭按钮 `×` 掉到标题下方**：`.floating-panel-header` 只在 `.directory-panel` 下定义了 flex 样式，状态面板的同名 header 没有样式 | `styles.css:1741`（选择器为 `.directory-panel .floating-panel-header`），`ActivitySummaryPanel.tsx:151-154` | P0 |
| A2 | 运行中 4 个指标卡片 3 个是 `—`，新增/删除的 `—` 还是绿色/红色；运行中 diff 本来就拿不到，不该先画 3 个空卡片 | `ActivitySummaryPanel.tsx:158-164` | P1 |
| A3 | “当前动作”显示原始值 `decision`；“分支”在拿不到时用 code 字体显示占位句“当前分支由 Service 管理” | `ActivitySummaryPanel.tsx:142-147, 166-167` | P1 |
| A4 | “构建目标”是一整段用 `·` 拼起来的文字，夹着 `TOOLCHAIN_NOT_FOUND` / `BUILD_SCRIPT_MISSING`；“工具链”是 `pnpm.cmd ? unresolved ✗ python ✓ uv.exe ✗`，无法扫读 | `ActivitySummaryPanel.tsx:93-108` | P1 |
| A5 | 内容只占上半屏，主按钮“查看 Git / diff”孤零零沉在底部，满宽琥珀色，视觉权重过高 | `ActivitySummaryPanel.tsx:176`，截图 5 | P1 |
| A6 | eyebrow“状态” + h2“状态摘要”重复 | `ActivitySummaryPanel.tsx:152` | P0 |

### 2.6 跨屏 · 会话侧栏（`App.tsx:4021-4179`）

| # | 问题 | 级别 |
|---|---|---|
| R1 | “新建会话”是满宽实心琥珀按钮，在侧栏里视觉权重最高；主流做法是描边/幽灵按钮，主色只给发送按钮 | P1 |
| R2 | 侧栏从上到下堆了 5 层：新建 / 导航（会话·Git·设置）/ 视图切换（按项目·按时间）/ 项目树 / 活动托盘。活动托盘里还有“中断”按钮和 `run 7f818030` 这种 id | P2 |
| R3 | 大量会话标题相同（“审查下代码”×6），只能靠时间区分；行内没有任何区分信息 | P2（受数据限制，见 U7.3） |

---

## 3. 设计原则（所有 U-Phase 共用）

1. **一个信息只说一次**：页面标题只在页面头；面板标题只在面板头；不再使用 eyebrow 小标题（`eyebrow` / `panel-eyebrow` 类名在本次涉及的组件中全部删除）。
2. **人话在前，原始码在后**：所有枚举/错误码先过一个映射函数得到中文短语；原始码放 `title` tooltip，或者放进“详情”折叠里用 `<code>` 显示。映射表缺项时回退显示原始码（fail-closed，不许显示空）。
3. **状态用图标 + 颜色 + 短词**：`✓ 可用`、`⚠ 需处理`、`✕ 不可用`、`○ 未启用`、`… 检测中`，统一走 U1 的 `StatusBadge`。
4. **主色只给一个主动作**：每个视图最多一个 `primary-button`（琥珀色）。侧栏新建、面板底部按钮一律降级为 secondary/ghost。
5. **一种浮层外壳**：右侧面板统一用 `PanelShell`（U1），锚定在按钮旁的小浮层统一用 `Popover`/`Menu`（U1）。
6. **空态要能直接动手**：空态必须给出 1 个主动作，而不是只有一段说明。

---

## 4. U0 · 缺陷速修（一个 PR，无设计争议）

| ID | 改动 | 文件 |
|---|---|---|
| U0.1（A1） | 把 `.directory-panel .floating-panel-header` 的样式提升为全局 `.floating-panel-header`（去掉 `.directory-panel` 前缀），保证状态摘要的 `×` 在右上角。U1 落地后该类会被 `PanelShell` 替代，这里先止血 | `styles.css:1741` |
| U0.2（S1） | `SettingSection` 新增可选 prop `hideHeader?: boolean`；`FeaturesPage` 传 `hideHeader`。检查其余 settings pages，凡是 section 标题等于 `definition.label` 的同样处理 | `settings/components.tsx`，`settings/pages/*.tsx` |
| U0.3（S2） | `FeaturesPage` 渲染 `card.actions` 时，过滤掉 `kind==='OPEN_SURFACE' && url==='settings:websearch'`（已有 `FeatureManagement` 入口）。通用规则：action 的目标与 `FeatureManagement` 打开的面板相同就不重复渲染 | `FeaturesPage.tsx:683` |
| U0.4（C5） | `ConversationHeader`：Git 图标换成 `branch`；导出换成新图标 `download`（在 `Icon.tsx` 增加 `download: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14']`） | `ConversationHeader.tsx`，`Icon.tsx` |
| U0.5（G1） | 页码显示改为 `page + 1`；`!hasMore && page===0` 时隐藏整个 `.git-file-pager`；工具栏不再显示“第 N 页”，只在有多页时显示 `第 N 页` | `EvidencePanels.tsx:586, 611-615` |
| U0.6（G2） | 文件头 `MODIFIED` → 映射 `新增/修改/删除/重命名/未知`（复用文件里已有的 `glyphLabel` 逻辑，抽成 `changeTypeLabel()`） | `EvidencePanels.tsx:598, 622` |
| U0.7（T1/A6） | `WorkPane` 去掉 `<span className="eyebrow">面板</span>`；终端 pane 的 `title` 改为“终端”；`TerminalDock` 删除自身的 `<h3>终端</h3>`（`terminal-unavailable` 分支保留 h3，因为它不在 WorkPane 里时也会被测试渲染——先确认 `terminal-dock.test.tsx` 断言后再删）。`ActivitySummaryPanel` 删除 `panel-eyebrow` | `WorkPane.tsx`，`App.tsx:4604`，`TerminalDock.tsx:995`，`ActivitySummaryPanel.tsx:152` |
| U0.8（S9） | “全部重新检测”改为 `Promise.allSettled(cards.map(c => preflight.mutateAsync(c.featureId)))`，用组件内 `recheckingAll` state 控制按钮 disabled/文案“检测中…” | `FeaturesPage.tsx:497` |

**验收**：`typecheck` + `test` 通过；新增/更新断言：
- `features-page.test.tsx`：Web 搜索卡片上“管理搜索配置”按钮只有 1 个；`features-section` 内不再出现与页头相同的标题。
- `ew6-panels.test.tsx`（或 Git 页对应测试）：单页时不渲染 `git-page-indicator`；多页时首页显示“第 1 页”。

---

## 5. U1 · 统一浮层外壳（PanelShell / Popover / StatusBadge）

### 5.1 新增 `src/renderer/app/ui/PanelShell.tsx`

```tsx
export function PanelShell(props: {
  title: string;                 // 唯一标题，无 eyebrow
  subtitle?: React.ReactNode;    // 单行，超出省略，完整内容放 title 属性
  status?: React.ReactNode;      // 标题右侧的状态 badge（StatusBadge）
  actions?: React.ReactNode;     // 关闭按钮左侧的图标按钮组
  onClose: () => void;
  closeLabel: string;
  footer?: React.ReactNode;      // 粘底操作区；没有就不渲染
  testId?: string;
  children: React.ReactNode;     // 可滚动 body
}): React.JSX.Element
```

布局规范（写入 `styles/panels.css`）：

```
┌──────────────────────────────────────────────┐ 48px header，padding 0 var(--space-4)
│ 标题(--fs-lg/600)  [status]      [actions][×] │ border-bottom: var(--border-subtle)
│ 副标题(--fs-xs, --text-muted, 单行省略)       │
├──────────────────────────────────────────────┤
│ body：overflow-y:auto，padding var(--space-4)  │
│ 区块间距 var(--space-4)，区块标题 --fs-xs/600 │
├──────────────────────────────────────────────┤
│ footer（可选）：右对齐 secondary 按钮          │ border-top，padding var(--space-3) var(--space-4)
└──────────────────────────────────────────────┘
```

- `WorkPane` 内部改用 `PanelShell` 的 header（保留 resize handle、dock 按钮作为 `actions`、所有现有 `aria-label`/`title`）。
- `ActivitySummaryPanel`、`BuildPlanPanel`、`DirectoryPanel`、`ExportDrawer` 的自制 header 全部替换为 `PanelShell`。
- 删除 `styles.css` 中 `.floating-panel-header`、`.panel-eyebrow`、`.work-pane-header`、重复的 `.work-pane-floating`（只保留一份定义，迁到 `panels.css`）。

### 5.2 新增 `src/renderer/app/ui/Popover.tsx` + `Menu`

- `Popover`：锚定在触发按钮上方/下方，点外部或 Esc 关闭，关闭后焦点回到触发按钮（复用 `ComposerModelSelector` 现有的 mousedown/keydown 关闭逻辑，抽成 `useDismiss(ref, onClose)` hook）。
- `Menu` + `MenuRadioItem`：`role="menu"` / `role="menuitemradio"`，↑↓ 移动、Enter/Space 选择、Esc 关闭；每项结构为 **图标 + 标题 + 一行说明 + 右侧 ✓**；支持 `disabled` 和 `disabledReason`（以说明文字显示，不是只有 tooltip）。
- 审批设置（U2）、模型选择（U2）、终端新建菜单（U5）都用它。

### 5.3 新增 `src/renderer/app/ui/StatusBadge.tsx`

```tsx
type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'busy' | 'info';
export function StatusBadge(props: { tone: Tone; label: string; title?: string; testId?: string })
```

图标：ok `check`，warn `alert`，bad `x`，off 空心圆，busy `loader`（带旋转，受 `data-reduce-motion` 控制），info 圆点。替换本次涉及组件里的 `status-pill`、`badge success/stale`、`settings-badge check-*`（**只替换视觉，保留原有 `data-testid` 挂在 StatusBadge 上**）。

### 5.4 新增 `src/renderer/app/ui/labels.ts`（人话映射，原则 2）

集中放：`runStateLabel`（已存在于 App/ActivitySummaryPanel 各一份，合并）、`changeTypeLabel`、`activityActionLabel`（`decision→决策中`、`tool_call→调用工具`、`edit→编辑文件`、`shell→执行命令`、`read→读取文件`、`plan→规划`；以 `activityTypes.ts` 中实际 kind 为准补全）、`envIssueLabel`（`TOOLCHAIN_NOT_FOUND→未找到工具链`、`BUILD_SCRIPT_MISSING→缺少构建脚本`）、`terminalStateLabel`。全部 `fallback = 原始值`。

**验收**：新增 `tests/renderer/ui-primitives.test.tsx`：PanelShell 只渲染一个 heading；Popover Esc 关闭并还原焦点；Menu 键盘导航；labels 未知值回退原值。

---

## 6. U2 · Composer 与权限模式（对标 Claude Code / Codex）

### 6.1 权限模式 chip（解决 C1/C2）

目标形态：

```
composer 底栏左侧： [📎] [扩展] [目录] [🛡 标准 ▾]
                                         └ 点击弹出 Menu：
   ┌────────────────────────────────────────┐
   │ 权限模式 · 作用于当前会话               │
   │ ● 🛡 标准         需要时询问         ✓ │
   │ ○ ⚡ 自动批准     延时后自动继续        │
   │ ○ ⚠ 完全访问     不再逐次询问          │
   │    （已锁定：组织上限为 自动批准）      │  ← lockedModes 的原因
   │ ─────────────────────────────────────  │
   │ 2 项审批等待决定 · 跳转            →    │  ← 只在 >0 时出现
   │ 自动批准调度：运行中   [暂停]           │  ← 只在能力可用时出现
   │ 项目默认权限在 设置 › 权限 中修改   →   │
   └────────────────────────────────────────┘
```

- 新组件 `conversation/PermissionModeMenu.tsx`，内部复用 `PermissionModeSelector` 的**全部判定逻辑**（`permissionModeOperation`、`canChange`、`status` 文案、locked/supported、semantics v1 提示、activation 非 ACTIVE 提示）。建议把这些逻辑抽成 `usePermissionModeModel(props)` hook，`PermissionModeSelector`（设置页还在用）和 `PermissionModeMenu` 共用，避免两套规则。
- chip 文案 = 当前模式短名（标准 / 自动批准 / 完全访问）；`FULL_ACCESS` 时 chip 用 `--warning` 描边；`activationStatus !== 'ACTIVE'` 时 chip 加 `⚠` 并在菜单顶部显示 `授权未生效：…`。
- `canChange === false` 时 chip 仍可点开，但菜单项全部 disabled，顶部显示 status 文案（fail-closed，不隐藏原因）。
- **项目默认权限从 composer 浮层移除**，改为菜单底部的一个链接，跳转 `SETTINGS` 路由 `PERMISSIONS`（或 `PROJECTS_SESSIONS`，以现有哪个页面承载项目默认为准；若都没有，把现有 `PermissionModeSelector label="项目默认权限"` 整块移到 `ProjectsSessionsPage`）。
- 保留 testid：`approval-settings-panel`（挂到 Menu 容器）、`permission-mode-row`、`approval-pending-summary`、`automation-control`、`automation-control-toggle`、`project-defaults-row`（随块迁移到设置页）。触发按钮保留 `aria-controls="approval-settings-panel"`，`aria-label` 改为 `权限模式：{当前模式}`。
- `permission-approval.test.tsx` 中按“审批设置”文案找按钮的断言改为按 `aria-controls` 或新 testid `permission-mode-chip` 查找。

### 6.2 模型选择器收敛（解决 C4）

- composer 右侧只保留：`[模型短名 ▾]` `[发送/停止]`。
- 模型短名规则：`modelAlias` 取最后一个 `/` 之后的部分（`deepseek/deepseek-v4.1-flash` → `deepseek-v4.1-flash`），完整 id 放 `title`。
- 点开后是一个 Popover，分三块：
  1. 模型列表（`MenuRadioItem`，默认项文案“默认（xxx）”，不可用项 disabled 并写原因）
  2. 推理强度、上下文窗口（把现有两个 select 原样搬进来，改成分段按钮或 radio 行）
  3. 用量（现有 `composer-usage-panel` 的两行：上下文容量、缓存命中率），删除单独的 `chart` 图标按钮
- 保留 testid：`composer-model-selector`、`${testId}-select`（挂在模型列表上，若测试用 `selectOptions` 操作原生 select，则模型列表**先保留原生 select 放在 Popover 内**，下一轮再替换）、`${testId}-usage`（挂在 Popover 的用量区块上）。

### 6.3 会话头部（C6）

- 运行状态点移入“状态”按钮内部（按钮左侧图标替换为 8px 状态点），删除按钮外的独立 `header-run-dot`。
- 头部动作顺序：`变更` `状态` `终端` `证据` `导出`（“Git”按钮文案改为“变更”，与 Cursor/Codex 的 “Review changes” 对应；testid `conversation-header-git` 不变）。

### 6.4 运行结束后的变更条（对标 Cursor “Review changes” / Codex diff 摘要）

当会话最新 run 为终态且 `run.diff.read` 可用时，在 composer 上方显示一条 32px 高的变更条：

```
 12 个文件  +2526  −2328                      [查看变更]
```

- 数据：复用 `ActivitySummaryPanel` 的 `loadDiffSummary`（抽到 `queries.ts` 作为 `useRunDiffSummary(runId)`，queryKey 沿用 `['activity-summary-diff', runId]` 以共享缓存）。
- `complete === false` 时数字后加 `（不完整）`；查询失败或能力不可用时**整条不显示**。
- testid：`composer-diff-strip`。

**验收**：`permission-approval.test.tsx` 全过；新增 `tests/renderer/permission-mode-menu.test.tsx`（chip 显示当前模式；locked 项 disabled 并显示原因；capability 缺失时 status 文案出现且不能切换；FULL_ACCESS 选中直接调用 onChange）。

---

## 7. U3 · 状态摘要面板重做（解决 A1–A5）

目标布局（宽 380–420px，PanelShell）：

```
状态  [● 运行中]                                   [×]
run 7f818030 · kosmos-509dbc83                       ← subtitle

正在做    决策中                                     ← activityActionLabel
已运行    3 分 12 秒 · 105 项活动
子代理    未启动

── 变更 ─────────────────────────────────────
 运行中：变更会在 Run 结束后统计                    ← 运行中只显示这一行
 结束后：12 个文件 · +2526 · −2328    查看变更 →    ← 链接，不是满宽按钮

── 环境 ─────────────────────  [验证计划] [重新探测]
 工具链
   ✓ python          ✕ uv.exe          ? pnpm.cmd
 构建目标（9）                                  ▾   ← 默认折叠，有问题时默认展开
   ⚠ apps/web            PNPM    未找到工具链
   ⚠ packages/kosmos…    PNPM    缺少构建脚本
   ✓ packages/shared     PYTHON
 验证      无记录
```

实施要点：

1. 删除 4 个指标卡片（`activity-summary-metrics`）。保留 `data-testid="activity-summary-metrics"`，挂在新的“变更”区块上，测试若断言具体数字则同步更新。
2. “分支”行：只有拿到 `branchName/branch` 时才渲染；拿不到不显示占位句（这个字段本来就不是 Service 保证的，而且占位句用 code 字体容易被误读成分支名）。
3. 已运行时长：若 `RunLike` 有 `startedAt`/`createdAt`，复用 `useRunDisplayClock` + `formatDuration`；没有就不显示该行。
4. 构建目标改为表格（`<table>` 或三列 grid）：状态图标 / 目录（中间省略，见 §8.2）/ 工具 / 问题（`envIssueLabel`，原始码放 `title`）。`target.issue` 存在的行排在前面。
5. 工具链改为 chip 行：`StatusBadge tone=ok|bad|off` + 可执行名；`available === undefined` 显示 `?` 并 tooltip“未解析到可执行文件”。
6. 底部满宽主按钮删除；“查看变更 →”作为变更区块内的 link-button，仍调用 `props.onOpenGit`。保留 testid `status-environment`。

**验收**：新增/更新 `tests/renderer/activity-summary-panel.test.tsx`：运行中不渲染数字；有 issue 的构建目标排在前面且显示中文；未知 action 回退原始值；分支缺失时不渲染分支行。

---

## 8. U4 · Git 变更页（对标 GitHub PR Files / VS Code diff / Cursor review）

### 8.1 Diff 正文（G3）

`DiffPatchView` 改为解析 unified patch，**不引入依赖**：

- 解析 `@@ -a,b +c,d @@` 得到起始行号，逐行累加：`ctx` 两列都 +1，`del` 只 old +1，`add` 只 new +1。
- 每行渲染为 grid：`[old 行号 48px][new 行号 48px][符号 16px][代码]`；行号 `--text-muted`、`user-select:none`、右对齐、`font-variant-numeric: tabular-nums`。
- 背景只铺在 add/del 行上，行号列也铺浅一档底色（与 GitHub 一致）；`ctx` 行无底色。现有 `.diff-line.tone-*` 颜色保留，并补齐浅色主题覆盖（`styles.css:1855-1857` 已有，迁到 `git.css`）。
- hunk 头 `@@ … @@` 渲染为一行灰色分隔条，带 `函数上下文` 文本（`@@` 之后的部分）。
- 代码列 `white-space: pre`，横向滚动（不要 `pre-wrap` 折行，否则行号对不上）；提供工具栏开关“自动换行”，打开后改 `pre-wrap`。
- 保留：`PREVIEW_LINES` 折叠与“展开剩余 N 行”按钮、`file.truncated` 提示、binary 提示。
- `diff-file-body` testid 不变。

### 8.2 文件列表（G4/G5）

```
变更文件  12                         [≡ 列表 | 🗀 树]
 M  bun_postgres.go          +12 −85
    internal/pkg/bun/postgres
 M  environment_helpers.go    +4 −26
    internal/pkg/config
 A  sql_helper.go            +60
    internal/pkg/utils
```

- 两行结构：第一行 = 变更字母 + **文件名**（不截断，过长时才省略）+ 右侧 `+N −M`（`patchStats(file.patch)`，0 不显示）；第二行 = 目录（`--fs-2xs`，`--text-muted`，**从左侧省略**：`direction: rtl; text-align: left; unicode-bidi: plaintext` 或 JS 截断成 `…/bun/postgres`）。
- 可选“树”视图（P2，放在 G8 同一轮）：按目录分组、可折叠；状态存 localStorage `codeagent.git.fileView`。
- 选中行左侧 2px `--accent` 竖条；键盘 `j/k` 或 `↑/↓` 切换文件（焦点在列表时）。

### 8.3 工具栏（G6/G7/G8）

```
go-food-delivery-microservices-0e5580a4      [● 已完成]   run c3399b62
变更 (12) | Worktree                                  [证据] [返回会话]
──────────────────────────────────────────────────────────────────────
12 个文件 · 新增 1 · 修改 11       +2526 −2328（本页）  [统一|并排] [换行]
```

- 统计在有多页时加 `（本页）`；单页时不加。
- 选中文件的 header 改为 sticky：`[M] internal/pkg/bun/postgres/bun_postgres.go   修改   +12 −85   [定位文件] [复制路径]`，“定位文件”从 patch 底部移到这里（G7；保留按钮文案与行为）。
- 统一/并排切换（P2）：并排模式把同一 hunk 的 del/add 行配对左右排列；容器宽 < 900px 时强制统一视图并禁用切换。偏好存 localStorage `codeagent.git.diffLayout`。

**验收**：`ew6-panels.test.tsx` 全过；新增 `tests/unit/diff-parse.test.ts`（行号累加、多 hunk、`\ No newline at end of file`、只有删除的文件、空 patch）；新增渲染断言：文件名不被目录挤掉（DOM 上文件名与目录在不同元素中）。

---

## 9. U5 · 终端面板（对标 VS Code / Cursor 终端面板）

### 9.1 结构

```
终端   kosmos-509dbc83 · 会话隔离工作区              [📌][×]   ← PanelShell，subtitle = 工作区（只出现一次）
┌ PowerShell ● ┐┌ Agent: pnpm dev ● ┐  [+ ▾]                  ← tabs 永远显示（1 个也显示）；+ 新建，▾ 菜单
├──────────────────────────────────────────────────────────┤
│ xterm 区域（TerminalView，占满剩余高度）                   │
│                                                           │
├──────────────────────────────────────────────────────────┤
│ 本端控制 · RUNNING           [复制输出] [打开链接] [关闭]   │  ← 底部细状态栏，原 controls 收进来
└──────────────────────────────────────────────────────────┘
```

### 9.2 要点

1. **标题与工作区各只出现一次**（T1/T2）：删除 `terminal-dock-header` 和 `terminal-context` 两处，工作区摘要作为 `PanelShell.subtitle`。
2. **新建入口收进 `+ ▾`**（T3）：`+` 直接新建 PowerShell（等价现在的“打开 PowerShell”按钮，保留其 `disabled` 条件与 `busyAction` 文案）；`▾` 打开 Menu：
   - `PowerShell`
   - `运行命令…` → 弹出一个小输入框（单独一行，足够宽），回车执行现有 `runShellCommand()`
   - `自定义启动…` → 展开现有 `terminal-dock-create` 表单（执行工作区 / 可执行文件 / 参数 / 模式），表单原样保留，只是改为在菜单之后的面板里展开
3. **打开面板即可用**（T4）：面板首次打开、`canCreate === true`、当前会话没有终端、且 Service 没报错时，**自动创建一个 PowerShell**（与 VS Code 一致）。必须加一个偏好开关保护：`general` 设置里新增“打开终端面板时自动启动 Shell”（默认开）；若设置页暂无对应 preference 字段，先用 localStorage `codeagent.terminal.autoStart`，并在 PR 中说明。自动创建失败时回到空态，空态只保留一个主按钮“启动 PowerShell”和一行说明。
4. Tab 文案（T6）：`名称` + 状态点（`terminalStateLabel` 做 tooltip）；退出码只在已退出时显示 `已退出 (1)`。
5. 不可用分支（`!props.enabled`）保持 fail-closed 文案不变，只套 PanelShell 视觉。
6. 保留 testid `terminal-dock`；按钮文案“打开 PowerShell”在测试中被断言的话，`+` 按钮的 `aria-label` 设为“打开 PowerShell / 新建 PowerShell”（与现逻辑一致）。

**验收**：`terminal-dock.test.tsx` 全过；新增断言：标题“终端”在面板内只出现一次；`autoStart=false` 时不自动创建；命令输入在菜单展开后宽度不受其他按钮挤压（断言其所在容器独占一行即可）。

---

## 10. U6 · 设置 › 功能与环境（对标 Cursor / Claude Desktop 设置）

### 10.1 设置页接管左侧（S3）

`activeSurface === 'SETTINGS'` 时隐藏 `.session-rail`（加类 `workbench.surface-settings`，CSS 中 `grid-template-columns` 去掉 rail 列）。设置分类导航顶部加一个 `← 返回` 按钮（与右上角“完成”行为一致，复用 dirty guard）。窄屏抽屉逻辑不变。

### 10.2 摘要区压缩（S6）

```
11 项能力   ✓ 7 可用   ⚠ 2 需处理   ○ 2 未启用          [全部重新检测]
⚠ 2 项修改需重启 Service 后生效                         [立即重启]   ← 仅在 pendingRestart>0
```

- 删除 TOC chip 行（`feature-toc` testid 保留：改为挂在“需处理”计数上，点击后滚动到第一张需处理卡片；若测试断言 chip 数量，则保留 TOC 但默认折叠在 `<details>` “全部能力”中）。
- 计数可点击做过滤：`全部 / 需处理 / 可用 / 未启用`（本地 state），默认“全部”，但**需处理卡片排在最前**。
- “修改写入 Service 数据库，重启 Service 后生效”这句说明只保留一处（开关的 `title` + `aria-describedby` 已覆盖），从摘要区删除可见文字，`features-apply-note` 的 id 节点保留为 `sr-only`。

### 10.3 卡片重排（S4/S5/S7）

```
┌──────────────────────────────────────────────────────────────┐
│ 沙箱执行 (Sandbox)   ✕ 需处理                    [重新检测] (●)│ ← 标题行：名称 + 一个状态 + 次要动作 + 开关
│ 隔离执行 Agent 的命令与文件写入                              │ ← 一句话说明（有就显示，Service 无此字段则省略）
│                                                              │
│ ✕ 暂存目录权限未验证                                          │ ← check.label（人话）
│   沙箱暂存目录包含所有者 SYSTEM/Administrators 以外的权限……   │ ← fixHint，最多 2 行，超出“展开”
│   [复制命令] [打开指南]                     详情 ▸           │ ← card.actions；“详情”里放 check.code / detail
│ ✓ 沙箱模式 AUTO                                              │
│                                                              │
│ [配置参数 · 22]  [管理…]                       已应用 · 数据库 │ ← 底栏：左边配置入口，右边弱化的元信息
└──────────────────────────────────────────────────────────────┘
```

- 状态只显示**一个**：合成规则 = 有 FAIL → `✕ 需处理`；`ENABLED_NOT_READY`/`NOT_INSTALLED`/`APPLY_FAILED`/WARN → `⚠ 需处理`；`NOT_ENABLED` → `○ 未启用`；`READY` → `✓ 可用`；其余 → `? 状态未知`。原 `feature-state-*` testid 挂在这个 badge 上，`feature-pending-*`（重启后生效）作为第二个 badge 保留。
- meta 行（S4）缩成底栏右侧一行弱化文字：只显示 `applyStatus` 和 `来源`；“期望/当前生效”**仅在两者不一致时**显示为 warning 文本 `已设为启用，重启 Service 后生效`；`安装` 只在非 `INSTALLED` 时显示。`feature-installation-*`、`feature-apply-*` testid 保留（不显示时渲染 `hidden` 元素或改测试，二选一，PR 中说明）。
- 检查项（S5）：`check.label` 作为主文案；`check.code`、`check.detail` 移进“详情”折叠，用 `<code>` 显示；`fixHint` 去掉“处理建议：”前缀，超过 2 行 clamp。全部通过时保持现在的折叠（`✓ N 项检查全部通过`）。
- “重新检测”（per-card RECHECK action）移到标题行，做成 ghost 小按钮；其余 actions 留在检查项下方。
- 卡片左侧 3px 色条（`tone-warn`/`tone-bad`）保留。

### 10.4 分类 IA 建议（S8，仅调整前端分组，不改路由 id）

| 组 | 分类 |
|---|---|
| 常用 | 概览、通用、外观、Agent 与模型 |
| 权限与数据 | 权限、项目与会话、隐私与证据、知识 |
| 能力 | 功能与环境、扩展 |
| 高级 | Service、运行时、诊断、关于 |

- `SettingsRouteDefinition.group` 扩展为 `'common' | 'governance' | 'capabilities' | 'advanced'`，`SettingsCenter` 按组渲染组标题。`settings-center.test.tsx` 中若按 `'main'` 断言，同步更新。
- “扩展”页与“功能与环境”的 MCP/Skills 卡片重叠：本轮不合并，只在“扩展”页顶部加一行链接“MCP 与 Skills 的启用状态见 功能与环境 →”。

**验收**：`features-page.test.tsx`、`settings-center.test.tsx`、`ew9-settings.test.tsx` 全过；新增断言：需处理卡片排在最前；Web 搜索卡片管理按钮唯一；期望与生效一致时不显示“期望”文字。

---

## 11. U7 · 会话侧栏轻量化（R1–R3）

1. **新建会话按钮**降级为描边按钮：`border: 1px solid var(--border-strong); background: transparent;`，hover 时 `--bg-hover`；`Ctrl N` kbd 保留。
2. **导航与视图切换合并**：`会话 / Git / 设置` 三个导航项改为侧栏底部的一行图标按钮（与 Claude Desktop / Codex 一致，设置在左下角）；`按项目 / 按时间` 切换移入 `⋯` 菜单（`sidebar-view-toggle`、`sidebar-view-projects`、`sidebar-view-recent` testid 保留，放在菜单里）。
3. **相同标题区分**（R3）：同一项目内存在重复标题时，第二行显示**已有字段**中能区分的信息（优先级：最近 run 状态短语 > 相对时间），不新造标题；会话重命名若 Service 已有 title 更新 mutation 则在行 hover 菜单中提供“重命名”，否则不做（不虚构能力）。
4. **活动托盘**：行内去掉 `run 7f818030`（移到 tooltip），只保留 `状态图标 + 会话标题 + 项目`；“中断”按钮改为 hover 才出现的 `stop` 图标按钮（`aria-label="中断"` 保留以兼容测试）。

**验收**：`workbench.test.tsx` 全过；手动检查：侧栏首屏可见会话行数 ≥ 改造前 + 2。

---

## 12. 优先级与里程碑

| 里程碑 | 内容 | 用户可感知收益 |
|---|---|---|
| M1 止血 | U0 | 5 屏中所有“明显是 bug”的地方消失 |
| M2 统一 | U1 + U3 | 所有浮层一个样子，状态面板可读 |
| M3 核心交互 | U2 + U4 | 权限模式一眼可见；diff 有行号、文件名完整 |
| M4 打磨 | U5 + U6 + U7 | 终端开箱即用；设置页一屏看懂哪里要处理；侧栏清爽 |

U2.4（变更条）、U4 并排视图、U4 树视图、U6.4 IA 调整、U7.2 为可选项，可在对应 Phase 中最后做或单独 PR。

---

## 13. 人工走查清单（每个 Phase 合并前过一遍）

- [ ] 浅色 / 深色主题各截一张图，确认无硬编码颜色漏网
- [ ] 窗口宽 1024 / 1440 / 1920 三档，确认无截断、无按钮挤压
- [ ] 外观设置里缩放 90% / 125% 各看一次
- [ ] 键盘：Tab 能到所有新控件，Esc 能关所有新浮层，焦点会回到触发按钮
- [ ] Service 断开状态下打开每个改过的界面，确认 fail-closed 文案仍在
- [ ] 本 Phase 涉及的旧 CSS 规则已删除，没有只叠加覆盖

---

## 14. 实施记录表

| 日期 | Phase | 改动摘要 | 测试结果 | 回滚方式 |
|---|---|---|---|---|
| 2026-10-04 | U0 | .floating-panel-header 提为全局规则；SettingSection 支持 hideHeader 去重设置页标题；过滤 Features 页重复管理入口；状态摘要关闭按钮换 Icon；Git 页码/变更类型人类可读化；终端内层 h3 去重 | typecheck ✅；pnpm test 142/142 通过（ew6/ew9/settings-center/terminal-dock/directory-panel/build-plan-panel/workbench 等；首轮并行全量 19 例超时为并发 flake，重跑全绿） | git revert 本阶段改动 |
| 2026-10-04 | U1 | 新增 ui/PanelShell、ui/Popover（useDismiss/Menu/MenuRadioItem）、ui/StatusBadge、ui/labels；panels.css 承接唯一定义 .work-pane-floating 及全部浮层规则；WorkPane/状态摘要/验证计划/目录/导出抽屉/审批设置面板换共享头部；删除 .floating-panel-header/.panel-eyebrow/.work-pane-header/三处重复 .work-pane-floating/.approval-panel-header/.export-drawer-header | typecheck ✅；新增 ui-primitives 7 例通过；回归 150+ 例全绿 | git revert 本阶段改动 |
| 2026-10-13 | U2 | PermissionModeSelector 抽出 usePermissionModeModel（canChange/status/locked/semantics/activation 单一判定源）；新增 PermissionModeMenu（chip 短名+warn 描边+MenuRadioItem+待审批/调度/设置链接，保留 approval-settings-panel 等 testid）；项目默认权限块迁至 ProjectsSessionsPage（project-defaults-row）；ComposerModelSelector 收敛为 chip+Popover（保留原生 select 与全部 testid，删除 chart 按钮）；会话头部 Git→变更、顺序 变更/状态/终端/证据/导出、状态点入按钮、删 header-run-dot；loadDiffSummary 提取为 queries.useRunDiffSummary 共享缓存并新增 composer-diff-strip | typecheck ✅；新增 permission-mode-menu 5 例通过；workbench/permission-approval/ui-primitives 更新后通过；全量 pnpm test 482 例全绿 | git revert 本阶段改动 |
| 2026-10-13 | U3 | ActivitySummaryPanel 重做：删除 4 指标卡（testid 挂到“变更”区块）、PanelShell status 位放 StatusBadge+subtitle（run id · workspace）；分支行仅在有真实值时渲染；已运行时长用 useRunDisplayClock+formatDuration；变更区运行中只显示提示/终态显示文件数+±行+“查看变更→”link；环境区工具链改 StatusBadge chip 行（unknown 显示 ? 并 tooltip）、构建目标改 details+表格行（issue 行排前、中文 issue label、目录左侧省略）、删除底部满宽按钮 | typecheck ✅；新增 activity-summary-panel 4 例通过；ui-primitives/ew6-panels/css-contract 回归全绿 | git revert 本阶段改动 |
| 2026-10-13 | U4 | 新增 diff/diffParse.ts（无依赖 unified patch 解析：hunk 头重置行号、ctx 双列累加、del 仅 old、add 仅 new、`\ No newline` 与 prologue 为 meta 不计行、纯 +x 无 hunk 不给行号）；DiffPatchView 改 grid [48/48/16/code]（行号 muted+tabular-nums+user-select:none+右对齐、add/del 行号列铺浅一档底色、hunk 头为分隔条带上下文文本、代码列 pre+横向滚动）；新增 styles/git.css（承接浅色主题覆盖、两行文件行、sticky header、换行开关）；工具栏加“换行”开关（pre-wrap）与（本页）标记；文件行两行结构：文件名独占一行 + 目录行 rtl 左省略 + 行内 +N −M 统计，按钮 aria-label=完整路径；j/k、↑/↓ 在列表内换选文件；选中文件 header 变 sticky 工具条（glyph+完整路径+变更类型+±统计+定位文件+复制路径，定位文件自 patch 底部移入）；ew6 文件名/目录分离断言、cli-activity-row 断言适配 codeLine matcher | typecheck ✅；新增 diff-parse 6 例通过；ew6-panels 16 例（含新增 U4 §8.2 断言）/cli-activity-row 41 例通过；全量 pnpm test 493 例全绿 | git revert 本阶段改动 |
| 2026-10-13 | U5 | TerminalDock 重构：删除 terminal-dock-header 与 terminal-context（工作区摘要经 onWorkspaceSummary 回调上报为 WorkPane.subtitle，App.tsx 新增 TerminalDockPane 包装）；tab 栏改为常驻 terminal-tabbar（单终端也显示），tab 文案 = 名称 + 状态点（terminalStateLabel 作 tooltip），已退出才显示“已退出 (N)”；新建入口收为 [+][▾]（+ aria-label=打开/新建 PowerShell 保留 disabled 条件；▾ 经 Popover+Menu 给 PowerShell/运行命令…/自定义启动…）；运行命令改为独占一行输入框，自定义启动表单原样保留并新增“收起”；meta+controls 合并为 terminal-dock-statusbar（左 meta 右 controls）；空态只留“启动 PowerShell”主按钮+说明；新增 autoStart 偏好（localStorage codeagent.terminal.autoStart，默认开，通用设置页新增 toggle，面板首开且无终端且 Service 无错时自动创建）；Popover 新增 MenuItem；新增 styles/terminal.css 并删除 styles.css 中 header/context/primary-toolbar/secondary-action 等被替代规则；fail-closed 分支去重 h3 | typecheck ✅；terminal-dock 18 例通过（新增：标题唯一、autoStart 开/关、命令输入独占一行）；全量 pnpm test 并发下个别 workbench/ew6 用例超时为负载 flake，重跑三文件 63/63 全绿 | git revert 本阶段改动 |
| 2026-10-13 | U6 | 设置面：activeSurface===SETTINGS 时 workbench 加 surface-settings，session-rail display:none 且 app-layout 去掉 rail 列；settings-nav 顶部新增「← 返回」（与「完成」共用 requestExit 脏守卫）；设置路由 group 扩为 common/governance/capabilities/advanced 四组（route id 不变，nav 按组渲染标题，搜索结果显示组名）；扩展页新增「MCP 与 Skills 的启用状态见 功能与环境 →」链接。功能与环境页：摘要计数改为可点击过滤钮（全部/需处理/可用/未启用，feature-toc testid 挂在需处理钮上并滚动定位首卡），feature-apply-note 改 sr-only，删除 feature-toc 目录行；卡片状态合成单一 StatusBadge（FAIL→✕需处理 / ENABLED_NOT_READY·NOT_INSTALLED·APPLY_FAILED·WARN→⚠需处理 / NOT_ENABLED→○未启用 / READY→✓可用 / 其余→?状态未知，原 state 文案移入 title 提示）；RECHECK 类 action 移入标题行 ghost 钮（testid 不变）；检查项 code/detail 收进 <details>详情<code>，fixHint 去「处理建议：」前缀并两行截断；期望/生效仅在不等时显示警示行（feature-mismatch-*）；底部改为 settings-feature-foot（左配置入口右弱元信息：applyStatus·来源·安装仅在非 INSTALLED 时显示）；需处理卡片恒排最前 | typecheck ✅；features-page 22 例（新增排序/过滤/详情折叠/期望文字断言）、settings-center 16 例（新增 rail 隐藏+四分组+返回+扩展链接断言）、ew9 4 例、css-contract 4 例，聚焦 42+ 全绿 | git revert 本阶段改动 |
| 2026-10-13 | U7 | 会话侧栏轻量化：new-session-trigger 降为描边按钮（border-strong/transparent，hover bg-hover，Ctrl N kbd 保留并改弱样式）；顶部 rail-nav 整块移除，会话/Git/待处理/设置改为 rail-nav-bottom 图标行（icon-only+title/aria-label，active 指示改顶部 inset）；按项目/按时间切换移入 ⋯ rail-menu（rail-menu-view radiogroup，sidebar-view-toggle/projects/recent testid 保留，选择后关菜单）；重复标题消歧——同 workspaceAlias 同名会话第二行前置消歧短语（有 run→status.label，无 run→relativeTimeLabel），duplicateTitleIds/sessionHasRuns 各 useMemo；活动托盘删 run xxxxxxxx 行（id 保留在 title/aria-label），中断按钮改 hover/focus-within 才显示的 stop 图标钮（aria-label=中断 保留，run-controls-hover 规则）；rail-collapsed 下 attention-badge 保持可见 | typecheck ✅；全量 pnpm test 58 文件 504 例全绿；新增：rail-nav-bottom 三项、重复标题消歧（执行中/1 天）；适配：view-toggle 用例先开 ⋯ 菜单、托盘等待行改按 name /run-1/ 匹配（workbench/ew6/ew7） | git revert 本阶段改动 |
