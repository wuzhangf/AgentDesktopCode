# PAE P6 — 个人 App/Web 项目管理体验（`src/personal/`）

归属：任务单 §9（Business `apps/control-plane-web/src/personal/**` + 通用展示组件 +
Desktop 窄端口适配）。消费 P0 冻结的 `/api/personal/v1` 合同
（`codeagent-desktop/packages/protocol/src/personal.ts` 为唯一 owner）。

## 入口与面（surface）

- `personal.html` + `src/personal/main.tsx`：独立 Vite 入口（worker.html 先例），
  旧管理台任务/项目导航已转向该入口；与 Worker 管理共用正式监听服务。
- `resolvePersonalSurface()`（`port.ts`）按序解析宿主：
  1. `?demo=1` → `createDemoTransport()` 示例数据（App 持续显示「示例数据」横幅）；
  2. `window.codeAgentDesktop.personalOperation` 存在 → Desktop IPC 窄桥；
  3. 其余 → 同源 `fetch /api/personal/v1`。
  `?readonly=1` / `?surface=mobile` → 只读面：所有写按钮隐藏（手机式窄接口预留，
  未实现的远程写权限不显示按钮）。
- `window.codeAgentDesktop` 只在 `port.ts` 一处做结构探测；页面只见到
  `PersonalGateway` typed port——不把它搬进浏览器组件树（§9.6）。

## 页面 ↔ 冻结操作

| 路由 | 页面 | 消费操作 |
|---|---|---|
| `#/overview` | 总览/待处理 | OVERVIEW + OPERATION(+EVENTS/CANCEL 抽屉) |
| `#/projects` | 项目列表/登记 | PROJECTS + REGISTER_PROJECT |
| `#/projects/:id` | 项目详情→运行环境 | PROJECT + PROJECT_ENVIRONMENT + ENVIRONMENT_PLAN + ENVIRONMENT_OPERATION + OPERATION* |
| `#/tasks` | 名称选择、真实启动、持久列表 | PROJECTS_AVAILABLE + REGISTER_PROJECT + TASK_OPTIONS + TASK_CREATE + TASKS + TASK_REQUEST |
| `#/tasks/:taskId` | 真实执行详情、活动、输出与用量 | TASK + TASK_ACTIVITY + TASK_OUTPUT + TASK_METRICS；原 key 续接 TASK_CREATE |
| `#/workers` | 我的 Workers | WORKERS + WORKER（抽屉详情） |
| `#/reports` | 报告 | REPORTS + REPORT_CREATE + REPORT + REPORT_FILES |
| `#/settings` | 设置/用量 | OVERVIEW（meta 展示） |

## 交互约定（§9.2–§9.7）

- **写按钮门禁**：`canWrite(meta, action, readonly)` —— `meta.supportedActions`
  是服务端权威名单；缺失/为空/不含该动作一律不显示（未声明即不支持，
  freeze §0）。只读面隐藏全部写动作。
- **需要/已有/缺少**：`needs`/`have`/`missing` 三栏；`have` 只放实测
  readinessFacts，未实测不显示为已有。版本选择把 `needs` 中工具项做成
  可编辑版本输入，进入 `toolchainSelections`（非秘密版本选择）。
- **一键准备**：`PREPARE` 写操作带 `requestKey`（生成并镜像到
  `Idempotency-Key` 头）+ `expectedRevision`+`planDigest`；提交后登记到
  `localStorage[pae.p6.pendingOp.<projectId>]`，刷新/重启后按原
  operationId 恢复查询（§11.3：关 App/刷 Web 不取消后台准备）。
- **原操作恢复**：`OperationView` 按 operationId 直达——状态/进度
  （progress 为 null 显示「进度未知」）/有界事件页（nextCursor 不透明）/
  取消（仅 QUEUED|RUNNING|UNKNOWN 显示）。UNKNOWN 慢轮询核对，不重放；
  NEEDS_INPUT 只显示状态——personal 通道续接命令路由未冻结（P0 交接缺口）。
- **版本冲突**：错误 `code` 含 `CONFLICT` → 提示并自动刷新视图；
  不用最后写覆盖先前运行绑定。
- **常用动作**：试跑（`:run` → ActionTrialReceiptView：exitStatus +
  evidenceVerdict + 时间 + 输出/报告引用数）与保存（`:save` → descriptor）
  分离呈现；保存失败只显示保存错误，不触发再次执行（E05）。
- **任务启动**：按项目名称选择，自动读取 TASK_OPTIONS；默认 ACS 真实执行，
  高级选项只来自当前画像/模型目录。必需条件通过才允许启动；原请求不明时按原 key 核对。
- **Workers**：`ACS_DIRECT` →「外部连接·仅观察与已授权动作」；
  `DAEMON`/`CORE_LOCAL` →「本人受管实例」。停止/改镜像/重启不在冻结路由，
  不伪造按钮。联合能力缺件显示 OFF。
- **报告**：列表/详情/真实文件（name/size/digest/mediaType）；新建只提交
  已登记 sourceRef 与显式选择的 dataScope；服务未配置显示未配置；
  订阅/调度未启用如实标注。
- **设置/用量**：默认策略与用量汇总不在冻结路由——显示「未提供/未知」；
  主题/动效为本机偏好（复用 `lib/motion`），不冒充服务端策略。

## P8 路由接入清单

1. **Vite input**（`apps/control-plane-web/vite.config.ts`，P8 文件）：
   `rollupOptions.input` 增加 `personal: resolve('personal.html')`。
   dev 服务器无需改动即可访问 `/personal.html`；vite proxy `/api` 已覆盖
   `/api/personal/v1`。
2. **服务端挂载**（P5/P8）：`/api/personal/v1` 由 management server 提供；
   构建产物 `dist/personal.html` 由静态服务送出。
3. **Desktop IPC**（`apps/codeagent-desktop`，P8 文件）：
   - `electron/main/ipc/channels.ts`：`personal: 'app/personal'`；
   - `registry.ts`：`personalDefinition: IpcDefinition<PersonalOperation>`，
     `validate` 用 `validPersonalOperation`（P0 已交付）；
   - handler：`client.personalOperation(operation)`（ServiceClient P0 已交付）；
   - `electron/preload/preload.ts`：
     `personalOperation: op => ipcRenderer.invoke('app/personal', op)`；
   - `electron/shared/api-types.d.ts`：`DesktopApi` 增加
     `personalOperation?(op: PersonalOperation): Promise<DesktopResult<PersonalEnvelope<unknown>>>`；
   - P6 探测名固定为 `window.codeAgentDesktop.personalOperation`。
4. **导航挂载点**（P8）：`AppShell` sidenav 增加 `/personal.html` 外链，
   或将 personal 面挂为控制台的二级入口；P6 侧无侵入需求。
5. **任务创建通道**：已接 `/api/personal/v1/tasks` → 普通 ACS Session/Message。
   固定 ACS 与隔离工作树；不要求环境 PREPARE、Docker、daemon 或观测。
   localStorage 仅存未核对 requestKey；服务端保留原输入和源身份，GET 不派发。
6. **项目登记**：Web 只接受已登记 projectRef；Desktop 若要目录选择器入口，
   复用现有 `chooseAndRegisterProject` IPC（P8 决定是否在 personal 面接通）。

## 测试源码（未运行）

- `tests/personal-gateway.test.ts`：19 条操作 method+path、requestKey 幂等、
  `{error}` 解码、envelope fail-closed、desktop 桥、demo 幂等回放。
- `tests/personal-viewmodel.test.ts`：门禁/合并/轮询/启动检查/登记恢复纯函数。
- `tests/personal-pages.test.tsx`（jsdom）：E05 保存失败不重跑、只读面无写按钮、
  总览合并呈现。

## 当前任务页

任务列表来自服务端，按创建时间降序分页；旧索引明确显示“历史索引”。详情分节读取
原 Run、公开活动/输出和精确观测。等待/失败/完成取源状态，不从正文推断。源不可读
保留带时间的上次观察；活动/输出/用量故障不会覆盖 Run。token、费用不把未知当成零，
不相加可能重叠的费用来源或币种。当前 Web 首片不包含移动端控制或多核心切换。
