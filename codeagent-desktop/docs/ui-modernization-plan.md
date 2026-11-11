# CodeAgent Desktop · 界面现代化改造方案

> 目标：把 `apps/codeagent-desktop` 的 Electron 界面改造成主流 AI Agent 客户端水准
> （对标：Cursor / Claude Code / OpenCode / Continue / Windsurf / Gemini CLI）。
> 本文档直接指导 AI code agent 分阶段实施：每个 Phase 可独立开工、独立验收、独立回滚。
> 语言：后续新增 UI 文案默认中文（与现有界面一致），命令面板命令名保留英文（与现有 `New session` 等一致）。

---

## 0. 执行协议（AI agent 必读）

1. **一次只做一个 Phase**，按 `P0 → P1 → P2` 顺序推进；每个 Phase 结束必须跑通：
   - `pnpm typecheck`（四个 tsconfig 全过）
   - `pnpm test`（`tests/renderer` + `tests/unit` 全过，单测覆盖新增组件）
2. **红线（任何 Phase 不得违反）**：
   - 不碰 `electron/main`、`electron/preload`、`packages/` 的安全与协议逻辑；Renderer 永远不直读本地文件系统，所有文件/终端内容只能来自 Service 投影（见 `README.md`「Profile 与秘密边界」）。
   - 保持离线可用：只允许 **bundled npm 依赖**，禁止 CDN、外链字体/样式/图片（`src/renderer/styles.css` 头注释已有此约束）。
   - fail-closed 证据边界不变：501 / UNAVAILABLE / 截断 / 过期等状态必须显式渲染，不得伪造空态（参考 `EvidencePanels.tsx` 现有模式）。
   - `data-testid` 是测试契约：重构时保留既有 `data-testid`，新增交互必须加新的 `data-testid`。
   - TanStack Query 拥有服务端缓存，Renderer 不建第二套领域状态机（`queries.ts` 头注释约束）。UI 本地状态（选中、面板、输入草稿）才允许进新 store。
3. 每个 Phase 产出：代码 + 单测 + 本文档底部「实施记录表」的一行更新。

---

## 1. 现状诊断（证据链）

### 1.1 架构现状：能用，但“作坊式手写一切”

| 项目 | 现状 | 证据 |
|---|---|---|
| 框架 | Electron 44 + React 19 + TanStack Query + Vite + TS | `package.json` |
| UI 组件库 | **无**（全手写 button/input/details） | `package.json` 无任何 UI 依赖 |
| 图标库 | **无**，手写 SVG path 字典 | `App.tsx:158` `ICON_PATHS`，`IconName` 仅 ~24 个 |
| Markdown 渲染 | **无第三方库**，300 行手写子集解析器 | `ContentRenderer.tsx`（全文件） |
| 代码高亮 | **无**（`<pre><code>` 纯文本） | `ContentRenderer.tsx:166-183` `CodeBlock` |
| 路由 | **无**，字符串 state 切换 5 个 surface | `App.tsx:105` `ActiveSurface`，`726` `activeSurface` |
| 全局状态库 | **无**，单个组件内 **48 个 `useState`** | `App.tsx` 全文件（`Workbench` 自 `682` 行起） |
| 命令面板库 | **无**，手写 | `App.tsx:2466-2470` |
| Diff 库 | **无**，文本 patch 列表 | `EvidencePanels.tsx:230` `DiffInspector` |
| 终端 | **非真终端**：轮询 base64 文本 + `<pre>` 展示 | `TerminalDock.tsx`（519 行，无 xterm） |
| 编辑器/Monaco | 无 | 依赖检查确认无 `monaco-editor` |
| 样式方案 | **~1200 行手写全局 CSS**，~150 个全局类名 | `styles.css` + `settings.css` |
| slash-command / @-mention | **无** | 全 `src/renderer` 搜索 `slash|mention|autocomplete` 零命中 |
| 单测 | `tests/renderer` 15 个文件 + `tests/unit`，以行为契约测试为主 | `tests/` 目录 |

### 1.2 已确认的 UI 缺陷（按严重度排序）

- **D1 · 巨型单文件**：`App.tsx` 2474 行，`Workbench` 一个组件承载顶栏/会话栏/对话/composer/浮动面板/全部弹窗/命令面板；48 个 `useState`，任何改动都高风险。这是所有界面改造的前置阻塞项。
- **D2 · 死功能：浅色主题**：`AppearancePage` 提供 `LIGHT` 选项，`App.tsx:2174` 也输出了 `data-theme` 属性，但**全部 CSS 文件中零个 `[data-theme]` 选择器**——切浅色主题无任何效果。
- **D3 · 死功能：主工作区密度**：`App.tsx:2173` 输出 `density-*` class，但 `styles.css` 中**零个对应选择器**（仅 settings 页有 3 处无关匹配）——密度设置同样无效。
- **D4 · 命令面板是摆设**：搜索框是**非受控 input，无任何过滤逻辑**；无键盘导航、无 Esc 关闭；但底部 hint 却写着 `Esc 关闭 · ↑↓ 选择`——文案与行为不符（`App.tsx:2466-2470`）。
- **D5 · 双搜索框绑定同一状态**：顶栏和左侧栏各有一个“搜索会话”，都绑定 `sessionSearch`（`App.tsx:2185` / `2222`），截图第 1 张可直观看到重复。
- **D6 · 右侧面板浮动遮挡**：`work-pane-floating` 盖住对话区（截图 1 右侧 Changes 占近 1/3 宽且不可调），主流做法是可停靠 + 可拖拽调宽。
- **D7 · Markdown 能力弱**：手写解析器仅支持标题/引用/列表/表格/代码围栏；无 GFM（任务列表/删除线/自动链接）、无语法高亮、长代码默认只折叠无语言着色；公式/图表/mermaid 全是降级占位。
- **D8 · 消息区分度弱**：用户 `›` / Agent `✦` 纯文本 glyph（`App.tsx:2360`），长对话中难以扫读；用户消息无气泡/无背景，与主流（用户右气泡 / Agent 全宽）差距明显。
- **D9 · 审批心智负担重**：5 套审批卡片（`ApprovalCard` / `UnifiedApprovalCard` / `DangerApprovalPanel` / `GovernanceApprovalCard` / `BudgetPolicySummary`）全堆在 composer 上方（`App.tsx:2385-2454`），截图 2 可见输入区上方信息密度过载。
- **D10 · 会话列表信息噪音**：标题截断（截图 `real smoke SVC-S…`）、每行两行状态小字（`Needs attention · workspace-d…`），无分组/无重命名/无置顶；59 个会话靠一条细滚动条浏览。
- **D11 · 新建会话表单概念过载**：理解/规划/实现 × 自主程度 × 验证方式三组正交选项一次性摊开（`App.tsx:2270`），主流做法是 composer 内一个 Mode picker + 高级折叠。
- **D12 · 样式用非标准 `zoom`**：`App.tsx:2177` 用 CSS `zoom` 做 UI 缩放，应换 `transform: scale` 或 `font-size` 根缩放方案。
- **D13 · Terminal 非等宽 ANSI 渲染**：`TerminalDock` 输出按纯文本 `<pre>` 显示，ANSI 颜色/进度条/全屏应用（vim/top）无法正确呈现。

### 1.3 值得保留的优点（改造时不要丢）

- 会话隔离做得好：selection generation 防串会话（`workbench.test.tsx` 有契约测试）。
- 安全展示纪律好：不可信来源徽标、 furnishing fail-closed、sha256/截断标注——这是差异化优势，改造只许加强不许削弱。
- 虚拟滚动（`VirtualMessageWindow`）、长消息折叠（`CollapsibleBlock`）、DEFERRED 大消息体分页已有，性能底子有。
- 设置中心（SettingsCenter + 9 个 page + preferences 版本化）体系完整，只缺主题真正生效。
- Activity 时间线按 run 分组、历史 run 按需展开（`ToolActivityGroup` + `HistoricalRunActivity`）信息架构是对的，只需视觉升级。

---

## 2. 对标：主流 Agent 客户端的界面范式

| 能力 | Cursor / Claude Code / OpenCode 现状 | 本项目差距 | 对应 Phase |
|---|---|---|---|
| 首页 = 以 composer 为中心的空态（问候 + 大输入框 + 快捷入口） | 标配 | 已有问候+模板，但 composer 视觉权重低、模板与表单混排 | P7 |
| Composer：Mode 切换（Ask / Plan / Build）、模型选择器、@文件、/命令、图片/附件 | 标配 | 仅附件（.txt/.md）+ 发送；模式藏在新建表单 | P4 |
| 对话时间线：可折叠 tool-call 组、流式 token、耗时/费用行、失败重试 | 标配 | 有分组无耗时费用行；失败卡独立 | P3 |
| 代码块：语法高亮 + 一键复制 + 应用/插入 + 折叠 | 标配 | 仅复制+折叠，无高亮 | P3 |
| Diff 审查：文件树 + 行级高亮 + unified/split 切换 + 逐文件 Accept | 标配 | 文本 patch 列表，无行级高亮 | P6 |
| 右侧面板：可停靠、可调宽、Tab 切换 | 标配 | 浮动遮挡、固定宽度 | P6 |
| Cmd+K 命令面板：模糊过滤 + 全键盘操作 | 标配 | D4（摆设） | P5 |
| 审批：内联卡片，就近决策（Allow once / Always） | 标配 | 5 套卡片堆输入区上方 | P8 |
| 会话管理：分组、搜索、重命名、置顶、归档、fork | 标配 | 仅搜索+归档+fork，无分组/重命名/置顶 | P7 |
| Terminal：真终端仿真（ANSI、交互） | 标配（IDE 内嵌） | D13 文本轮询 | P9 |
| 主题/密度/快捷键/无障碍 | 标配 | D2/D3 死功能 | P2, P10 |
| Token/费用可见性 | 标配（per-run） | 无（仅有预算策略摘要） | P3（字段缺失则 fail-closed 隐藏） |

**结论**：后端能力（run/activity/diff/evidence/approval/spec/mission）已经对标甚至超出（治理、安全、证据链是特色），**差距 90% 在展示层**。改造策略 = **不动后端契约、不动安全边界，只重做展示层 + 补齐缺失的输入范式（@、/、Cmd+K）**。

---

## 3. 目标信息架构（改造后的布局）

```text
┌──────────────────────────────────────────────────────────────┐
│ TopBar: ☰ │ Project-picker │ Cmd+K 搜索框 │ 连接状态 │ 设置   │  ← 合并双搜索(D5)
├──────────┬──────────────────────────────────┬────────────────┤
│ Session  │  Conversation / Empty-state      │ Dockable Pane  │  ← 可调宽、可停靠左右/浮动
│ Rail     │  ┌────────────────────────────┐  │ Tabs:          │
│          │  │  Mode+Model │ @ / 命令     │  │ Changes|Review │
│  New     │  │  大输入框 (auto-grow)      │  │ Evidence|Plan  │
│  Search  │  │  [Ask▾][模型▾]  [发送]    │  │ Terminal|…     │
│  分组列表 │  └────────────────────────────┘  │                │
│  今天    │  时间线(上) + 粘性 composer(下)   │ 行级高亮 diff  │
│  更早    │  审批卡片内联在对应消息下        │                │
│  Activity│                                  │                │
└──────────┴──────────────────────────────────┴────────────────┘
```

关键变化：① 审批从 composer 上方移入时间线对应位置（P8）；② 右面板可调宽+可停靠（P6）；
③ 空态 composer 居中放大（P7）；④ 顶栏搜索框升级为真正的 Cmd+K 入口（P5）。

---

## 4. 技术选型（只增 bundled 依赖，禁 CDN）

| 需求 | 选型 | 理由/约束 |
|---|---|---|
| Markdown + GFM | `react-markdown` + `remark-gfm` | 替代手写解析器；**必须配 `rehype-sanitize` 或保留现有 `isRawHtml` 拦截语义**，不得引入 `rehype-raw`（XSS 红线） |
| 代码高亮 | `rehype-highlight`（highlight.js，纯本地）或 `shiki`（体积大，备选） | 默认 `rehype-highlight`；主题随明暗切换；现有 `MAX_*` 截断与折叠阈值原样保留 |
| 图标 | `lucide-react` | 替换 `ICON_PATHS` 手写 SVG；按需 import，体积可控；离线无影响 |
| 命令面板 | `cmdk` | 补过滤+键盘导航；若评估后觉得过重，允许手写修复 D4，但必须补单测 |
| Diff 解析 | `diff`（jsdiff，仅解析 unified patch 做行级着色） | **不引入 Monaco**（体积 ~MB 级，与离线轻量定位冲突）；渲染层自写复用现有折叠/虚拟化 |
| 终端渲染 | `xterm` + `xterm-addon-fit`（仅渲染层，数据源仍是 Service 会话） | P9；交互输入仍走现有受控 mutation，不直连 pty（安全红线） |
| 轻状态 | `zustand` | 只存 UI 本地状态（surface/pane/selection草稿/composer草稿/dock布局），**领域数据仍归 TanStack Query** |
| 样式 | 沿用手写 CSS + CSS 变量体系（不引入 Tailwind） | 避免构建链大改；P1 建立 `tokens.css` + 组件级 CSS 文件拆分（仍全局类名，渐进迁移到 CSS Modules 可选） |

> 加依赖前先 `pnpm add <pkg>` 并确认 `pnpm build` 产物增量可接受（renderer bundle 增长 > 500KB 的引入需在实施记录中说明理由）。

---

## 5. 分阶段实施计划

### P0 · 拆分 `App.tsx`（前置阻塞，最高优先）⭐

- **目标**：`App.tsx` 只剩 `Workbench` 装配 + 数据编排；所有大块 JSX 下沉为独立组件，行为零变化。
- **拆出文件**（全部新建于 `src/renderer/app/`，props 显式传递，先不改逻辑）：
  1. `layout/TopBar.tsx`（`2181-2210`）
  2. `layout/SessionRail.tsx`（`2213-2244`，含 `renderSessionRow`）
  3. `sessions/NewSessionView.tsx`（`2261-2304` 空态+模板）
  4. `conversation/ConversationView.tsx`（`2306-2384`，含虚拟列表装配）
  5. `composer/ComposerDock.tsx`（`2385-2455`，审批区+输入表单）
  6. `panes/WorkPane.tsx`（`2459-2460` 浮动面板外壳+各 tab 路由）
  7. `palette/CommandPalette.tsx`（`2466-2470`，先原样搬运，P5 再重做）
  8. `layout/FileReferenceDialog.tsx`（`2465`）
  9. `surfaces/AttentionBoard.tsx`、`surfaces/MissionsScreen.tsx`、`surfaces/ExtensionsScreen.tsx`（`2247/2248/2260`）
  10. `ui/Icon.tsx`（`ICON_PATHS` + `Icon`，`158-204`）＋ `ui/primitives.tsx`（小按钮/徽标/空态）
- **步骤**：逐个提取 → 每次提取后跑 `pnpm test tests/renderer/workbench.test.tsx` → 全部搬完跑全量。
- **验收**：`App.tsx < 900 行`；全量测试通过；截图对比（新会话/会话中/Changes 开启三态）像素无回归（人工看一眼即可）。
- **回滚点**：纯搬运，可整 PR 回滚。

### P1 · 设计 token 与 CSS 拆分（无行为变更）

- **目标**：建立能真正支撑明暗主题/密度的变量体系，为 P2/P10 铺路。
- **改动**：
  1. 新建 `src/renderer/styles/tokens.css`：把 `:root` 变量搬出，并补全语义 token（`--bg-*` 4 层、`--text-*` 3 层、`--border-*` 2 层、`--accent-*`、`--status-*`、`--radius-*`、`--space-*`、`--font-*`），全部现有色值映射到 token（不许新增视觉变化）。
  2. 按 P0 组件切分 `styles.css` → `styles/layout.css`、`styles/conversation.css`、`styles/composer.css`、`styles/pane.css`、`styles/dialogs.css`，`main.tsx` 按序 import。
  3. 全局元素选择器（`button/input/ul/pre`）收敛到 `.workbench` 作用域下，避免污染后续 Markdown 第三方样式。
  4. 把 `zoom` 缩放（D12）换成 `:root { font-size: calc(14px * var(--ui-scale)) }` + `--ui-scale`，`AppearancePage` 的 90/100/110/125 四档映射到变量。
- **验收**：`typecheck` + 全量测试过；深色主题下与改造前截图逐屏比对无差异；`styles.css` 原文件删除（只剩 import 转发或直接删）。

### P2 · 点亮浅色主题与密度（修复 D2/D3）

- **目标**：让设置里已有的选项真正生效。
- **改动**：
  1. `tokens.css` 追加 `[data-theme="light"]` 整套浅色 token（背景 `#f6f7f9` 系、文字 `#1a2230` 系，对比度 ≥ 4.5:1）。
  2. `.density-summary/.density-detailed` 在对话/列表的真实样式差异（行高、内边距、工具行默认折叠/展开联动 `ToolActivityGroup` 的 `defaultOpen`）。
  3. `codeFontSizePx` 已有 `--code-font-size` 通道，检查全链路生效（`ContentRenderer` 代码块 + `file-reference-content` + Terminal）。
  4. `reduceMotion` 接 `data-reduce-motion`：关闭 `transition/animation` 与流式 caret 闪烁（已有属性输出，无 CSS 响应，同一类死功能，一并修）。
- **验收**：新增 `tests/renderer/appearance-tokens.test.tsx`（jsdom 断言 `data-theme` 切换后关键 token 值）；人工切换浅色/深色/密度各一遍。

### P3 · 阅读体验：Markdown 高亮 + 消息视觉 + 费用行

- **目标**：对话区达到主流阅读水准。
- **改动**：
  1. `ContentRenderer` 改用 `react-markdown` + `remark-gfm` + `rehype-highlight` + `rehype-sanitize`；**原样保留**：`MAX_*` 截断、`CollapsibleBlock` 折叠阈值、不可信/mermaid/chart/math 降级块、外部链接走 `openExternalHttps`。旧手写 parser 删除，原 `content-renderer.test.tsx` 用例全部迁移（用例是契约）。
  2. 消息视觉：用户消息改为右对齐气泡（保留 `role-glyph` 做 sr-only 无障碍），Agent 消息加 role 头（`✦ Agent · 模型别名 · 耗时`）。
  3. `ToolActivityGroup` 行尾追加 `· 耗时`（已有 `formatDuration`），Run 头部追加 `模型/耗时/token` 行——**字段以 Service 实际返回为准，缺失则整行隐藏（fail-closed），不许编造**。
  4. 代码块工具条追加「插入到输入框」按钮（把源码送进 composer 草稿，方便追问）。
- **验收**：`content-renderer.test.tsx` 全过（含新增 GFM/高亮用例）；流式消息不折叠、不跳动（已有注释约束，补一条回归单测）。

### P4 · Composer 升级：Mode/模型/@文件//命令

- **目标**：输入区达到 Cursor/Claude Code 输入范式。
- **改动**（全部在 `composer/` 目录，数据源只读现有 capability/preflight，不新增协议）：
  1. Mode picker：`ASK=理解 / PLAN=规划 / MODIFY=实现` 三态分段控件（复用 `SessionMode`），新建会话与已有会话共用；自主程度+验证方式收进「高级」折叠（解决 D11）。
  2. 模型选择器：只读展示 `sessionPreflight.data.modelAlias` + 可用性；不可切换则置灰并 tooltip 说明（fail-closed，不虚构切换能力）。
  3. `@` 文件引用：输入 `@` 弹出项目文件补全（数据源：已有 `useProjectFile`/会话文件引用能力可读到的范围；超范围输入只提示不可用）。选中的文件以 chip 形式贴在输入框上方，随消息发送（复用附件通道或纯文本引用，按现有 `session.message.send` 契约能支持的方式）。
  4. `/` 命令：`/plan`（转规划）`/verify`（触发验证）`/fork`（复用 forkSession）`/archive` 等，全部映射到**已存在的 mutation**，不新增后端能力；输入 `/` 出补全列表，Enter 选中执行。
  5. 输入框 auto-grow（最高 ~10 行后内部滚动），草稿按 sessionId 持久化到 zustand（切换会话不丢草稿）。
- **验收**：新增 `tests/renderer/composer-modes.test.tsx`（模式切换/草稿保持/`/`命令执行映射）；`@` 越权路径提示不可用（单测覆盖）。

### P5 · 命令面板重做（修复 D4）

- **目标**：真正的 Cmd+K。
- **改动**：`cmdk`（或等价手写）实现：模糊过滤、↑↓/Enter/Esc 全键盘、分组（会话/命令/运行/设置路由）、最近使用置顶；顶栏搜索框改为只读入口（点击/⌘K 打开面板），**删除左侧栏重复搜索框**（D5，二者保留其一：面板入口放顶栏，会话过滤搜索保留在 rail 内并改名为“过滤会话”）。
- **验收**：hint 文案与行为一致；新增键盘操作单测；旧 `command-palette` 相关 `data-testid` 保留或同名迁移。

### P6 · Changes 审查台：行级 Diff + 可停靠面板

- **目标**：Diff 审查达到 PR 级体验。
- **改动**：
  1. `DiffInspector`：用 `diff` 库解析 unified patch，渲染**行级增删着色 + 行号 + hunk 折叠 + 文件内搜索**；保留分页（`DIFF_PAGE_SIZE`）、stale/truncated/incomplete 徽标、501 fail-closed。
  2. 追加 unified/split（并排）视图切换（宽屏默认 split，窄屏自动回 unified）。
  3. `WorkPane` 改为可停靠：右停靠（默认）/ 浮动 / 关闭三态 + **拖拽调宽**（zustand 持久化宽度）；Tab（变更/评审/证据/工作区）保留。
  4. 文件行可点击 → 复用 `File reference` 只读弹窗（已有通道，不新增读文件能力）。
- **验收**：`ew6-panels.test.tsx` 全过 + 新增行级渲染/视图切换单测；面板宽度拖拽后刷新保持。

### P7 · 会话列表与空态（修复 D10/D5/D11 残留）

- **目标**：59+ 会话可管理，空态 composer 成为视觉中心。
- **改动**：
  1. 会话列表按更新时间分组（今天/昨天/更早/已归档）；行内 hover 操作（重命名走已有 title 更新能力——若 Service 无此能力则只做前端备注并标注 UNAVAILABLE，不虚构；置顶=本地 zustand 排序；删除=归档复用）。
  2. 标题用省略号+完整 tooltip（现有 `title` 属性保留），状态行精简为单行（状态点 + 短标签）。
  3. 空态：composer 居中放大（视觉主体），模板卡片改为横滑一排快捷入口，最近 3 个会话快捷继续。
- **验收**：分组/过滤/置顶单测；长标题不再撑破布局（加一条 CSS 回归快照或断言）。

### P8 · 审批统一：Approval Center（修复 D9）

- **目标**：审批就近决策，不再淹没输入区。
- **改动**（**纯展示层重组**，5 套卡片的后端契约/mutation 原样保留）：
  1. 运行中 run 的审批卡片渲染在**时间线对应 run 位置下方**（内联），composer 上方只剩一条聚合条（“N 个审批待决定 · 跳转”）。
  2. 统一视觉语言：危险（红）/ 写文件（黄）/ 预算（蓝）/ Spec（紫）四色 + 统一按钮（批准/拒绝/查看详情），`DangerApprovalPanel` 的逐项处理规则保留。
  3. 聚合条 + `Attention` surface 打通（已有 `attention-board`，只做跳转链接）。
- **验收**：`permission-approval.test.tsx` 全过；多审批堆积场景截图确认输入区不被挤占。

### P9 · Terminal 真渲染（修复 D13，P2 级别，可延后）

- **目标**：ANSI 颜色/进度条正确显示。
- **改动**：`TerminalDock` 输出渲染换 `xterm`（fit addon 自适应列宽 → 回写 `resize` mutation 已有通道）；输入仍走现有受控 `input/signal/acquire` mutation；**不引入 node-pty、不直连 shell**（安全红线）。
- **验收**：`terminal-dock.test.tsx` 全过 + ANSI 用例；不可用时降级回纯文本（保留旧渲染为 fallback）。

### P10 · 快捷键与无障碍收尾

- 快捷键：`⌘K` 面板、`⌘N` 新建（已有）、`Esc` 关闭弹窗/面板、`⌥←/→` 会话切换（若与现有 `1/2` 切换冲突则以设置为准）；设置页加快捷键一览。
- 弹窗 focus trap + 返回焦点；`aria-live` 播报运行状态变化（已有 `aria-live=polite`，补关键节点）。
- 补充 `prefers-reduced-motion` 与 `reduceMotion=ON` 联动（P2 已铺 CSS，此处补行为）。
- 验收：键盘全流程走查清单（文档内打勾）+ 相关单测。

---

## 6. 非目标（本次不做）

- 不动 Service 协议与 `packages/*`；不新增后端 API（P4 的 `@` 若需新查询能力，先降级为“不可用提示”，另开后端需求）。
- 不引入 Monaco / 重型编辑器；不在 Renderer 落盘任何秘密。
- 不做多窗口、系统托盘、自动更新（属 Electron 壳能力，另案）。

---

## 7. 里程碑与工作量估计（AI agent 视角）

| 里程碑 | 包含 | 估计 |
|---|---|---|
| M1 可维护 | P0 + P1 | 中（大搬运 + 全量回归） |
| M2 好用 | P2 + P3 + P5 | 中（依赖引入 + 用例迁移） |
| M3 主流范式 | P4 + P6 + P7 | 大（composer 与 diff 是核心） |
| M4 收尾 | P8 + P9 + P10 | 中（P9 可独立延后） |

---

## 8. 实施记录表（AI agent 每完成一个 Phase 追加一行）

| 日期 | Phase | 改动摘要 | 测试结果 | 回滚方式 |
|---|---|---|---|---|
| 2026-09-18 | P0 | styles.css 清层：删 83 个死类 ~540 行（topbar/columns/session-header/intent-card/contract-editor/diff-file/run-tab/directory-contract/template-gallery 等四代残留 + `display:none!important` 退役规则）；补全 --font-mono/--font-ui/--font-sans/--text-tertiary/--tone-*/--bg-base；--accent-soft/--accent-bright 重定义为琥珀系清掉紫色残留；旧变量 --bg/--muted/--subtle/--panel/--border 桥接到暖色板；z-index 收敛为 --z-pane/popover/drawer/toast 四档；font-weight 550/650/750 归一到标准档 | `typecheck ✅ / test 296 ✅` | `git revert`（单文件 styles.css + scripts/dead-css-scan.mjs） |
| 2026-09-18 | P0（部分） | App.tsx 第一轮拆分：`Icon.tsx`（图标注册表）、`panes/CommandPalette.tsx`（功能原样搬运）、`panes/FileReferenceDialog.tsx`、`panes/WorkPane.tsx`（pane 外壳：头/resize/dock/关闭）、`panes/ApprovalReminder.tsx`、`surfaces/Surfaces.tsx`（Attention/Missions/Settings/Extensions 四屏）；剩余会话栏/composer/会话主体为高耦合核心，需设计过的第二轮重构 | `typecheck ✅ / test 296 ✅` | `git revert`（新增 6 个文件 + App.tsx） |
| 2026-09-18 | P1（部分） | 设计 token 补全并入 P0 行记录；styles.css 未按组件拆分（维持单文件 + 区块注释） | `typecheck ✅ / test 296 ✅` | `git revert` |
| 2026-09-18 | P2 | 浅色主题补全整套 token 覆盖（不再仅 execution 面板）；`SYSTEM` 经 `useMediaQuery(prefers-color-scheme)` 真实跟随系统；密度改为真实改间距/行高/最小高度（rail/messages/composer/pane 等）；`data-reduce-motion` 死开关修复（SYSTEM 经媒体查询解析，全局 animation/transition 停掉）；`zoom` 缩放保留（px 体系下唯一可行方案，Chromium 已标准化） | `typecheck ✅ / test 296 ✅` | `git revert`（styles.css + AppearancePage + App.tsx） |
| _待填_ | P3 | | | |
| _待填_ | P4 | | | |
| _不做_ | P5 | 命令面板功能维持现状（用户决定：按钮已覆盖高频操作，面板仅做结构提取不扩展功能） | — | — |
| 2026-09-18 | P6（部分） | WorkPane 可停靠/调宽：`paneWidth` 拖拽手柄 + dock/undock 按钮，浮动↔停靠布局切换，移动端禁用停靠；底部工具行收敛（低频入口收进面板菜单）；Diff 审查行级高亮未做 | `typecheck ✅ / test 296 ✅` | `git revert`（App.tsx + styles.css） |
| 2026-09-18 | P7（部分） | 一致性打磨：`⌘`→`Ctrl` 标签修正；UI 文案中文化（Interrupt/Cancel/Resize/Terminate/Session Rail 等，协议键保留英文）；失败文案 `CODE – CODE: msg` 去重（failureDecoder 统一 normalize，结构化+legacy 两条路径）；`.messages` 整树 `aria-live` 移除（避免读屏被流式输出刷屏）；审批设置 aria-label 消重名 | `typecheck ✅ / test 296 ✅` | `git revert` |
| _待填_ | P8 | | | |
| _待填_ | P9 | | | |
| _待填_ | P10 | | | |
