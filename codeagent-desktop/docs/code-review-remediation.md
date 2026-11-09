# CodeAgent Desktop — 可执行代码审查与修复实施指南

> 审查范围：`electron/`、`src/renderer/`、`packages/`、`tests/`、仓库根配置
> 审查方式：只读审查（read-only analysis），不修改任何源码
> 证据口径：所有结论均来自对工作区文件的直接读取；行号标注为“约”，以符号名称为准
> 与既有文档关系：本文**取代** `docs/code-review.md` 作为可执行修复依据（既有文档存在过期度量与少量非缺陷建议，见 §6）
> 代码量（本次实测，排除 `node_modules/`、`dist/`、`dist-electron/`、`*.map`）：148 个匹配文件、43,410 物理行（含空行与注释行）

---

## 0. 结论摘要

| 编号 | 级别 | 问题 | 位置 | 是否需改产品行为 |
|------|------|------|------|------------------|
| R-1 | **P1** | IPC 入站大小限制对 object 载荷完全失效 | `electron/main/ipc/registry.ts`（`admit`，约 1686） | 否（仅加固） |
| R-2 | **P1** | `noPayloadValidation` 无条件接受任意载荷，破坏“每通道校验”不变量；且 `channel: '' as never` 是误注册陷阱 | `registry.ts`（约 1355） | 否 |
| R-3 | **P1** | 日志脱敏表缺失 `x-codeagent-client-token`（该头确实是凭据） | `electron/main/security/redaction.ts` | 否 |
| R-4 | **P2** | `app.quit()` 后未提前返回，第二实例继续执行模块级副作用 | `electron/main/main.ts`（约 185） | 否 |
| R-5 | **P2** | preload 硬编码通道字符串字面量，与 `IPC_CHANNELS` 存在漂移风险 | `electron/preload/preload.ts` | 否 |
| R-6 | **P2** | 全局 durable 流的 gap 检测默认关闭（`strictCursor=false`），可能静默丢帧 | `electron/main/transport/durableEvents.ts`（约 120、231） | 否 |
| R-7 | **P2** | `redactSecrets` 对 <8 字符的 secret 不脱敏，策略未在调用侧强制 | `electron/main/security/redaction.ts` | 否 |
| R-8 | **P3** | `openExternalHttps` 存在两份并行校验器，易漂移 | `ipc/channels.ts` 与 `ipc/registry.ts` | 否 |
| R-9 | **P3** | `supervisor.attachOrStart` 存在不可达分支 `throw new Error('unreachable')` | `electron/main/service/supervisor.ts` | 否 |
| R-10 | **P3** | `typecheck` 脚本中 tests 工程缺少 `--noEmit` | `package.json` | 否 |
| R-11 | **P3** | 存在 `eslint-disable-next-line no-control-regex`，但仓库无 ESLint 依赖/配置 | `registry.ts` | 需确认 |
| R-12 | **P3** | `missionsList` 对非对象载荷静默降级为 `sessionId: null` | `registry.ts` | 否 |
| R-13 | 文档 | `docs/code-review.md` 度量过期（如 `App.tsx` 声称 2,781 行，实测 3,025 行） | `docs/code-review.md` | 否 |

**总评：** 安全基线扎实（沙箱、CSP、`app://` 路径穿越防护、loopback 校验、token 仅经子进程环境传递、按通道类型化校验），核心风险集中在**边界加固的“最后一公里”**——校验器声明与实现存在可绕过缝隙，以及凭据脱敏清单不完整。上述修复均为**收敛式加固**，不新增产品行为。

---

## 1. 已确认的良好实践（请勿在修复中破坏）

修复前必须保留以下已被验证的正确设计，任何改动不得回退：

1. **窗口安全基线**（`electron/main/security/windowSecurity.ts`）：`nodeIntegration:false`、`contextIsolation:true`、`sandbox:true`、`webSecurity:true`、`allowRunningInsecureContent:false`、`webviewTag:false` 全部显式关闭；`buildWebPreferences` 对空 preload 路径 fail-closed 抛错。
2. **`app://` 静态资源路径穿越防护**（`security/appProtocol.ts`）：先 `decodeURIComponent`，再拒绝 NUL、拒绝反斜杠、拒绝 `.`/`..` 段，最后用 `path.resolve` + `path.sep` 前缀做包含性校验。该实现是正确且完整的，**不要以“简化”为由重写**。
3. **导航 fail-closed**（`security/navigation.ts`）：`navigationDecision` 对任一端非 `app:` 一律 `DENY`；外链仅允许 https、无 host 或带凭据一律拒绝。
4. **子进程凭据传递**（`service/supervisor.ts`）：token 经 `env` 传入（`CODEAGENT_SERVICE_TOKEN`），**不经 argv**；`stderr` 通过 `resume()` 主动排空以防管道写阻塞；仅能停止本 supervisor 持有的子进程。
5. **loopback 端点校验**（`supervisor.isLoopbackEndpoint`）：仅 `http:`，仅 `127.0.0.1`/`localhost`/`::1`/`[::1]`，且拒绝凭据、query、hash、非根路径。
6. **IPC 无通用代理**（`ipc/registry.ts`）：`IpcRegistry.register` 对重复通道抛错；`admit` 先验发送方 origin（`app://codeagent`）再验通道白名单，`event.senderFrame?.url` 在帧已分离时得到 `undefined` → 拒绝，方向正确。
7. **主进程不向外泄露 token**：`serviceStatusDefinition` 只暴露 `tokenPersisted` 布尔值，`diagnostics` 只暴露 `nonce`（非 token）。

---

## 2. P1 问题（建议优先修复）

### R-1 IPC 入站大小限制对 object 载荷失效

**证据**（`electron/main/ipc/registry.ts`，`admit`，约 1686）：

```ts
if (typeof payload === 'string' && payload.length > MAX_IPC_PAYLOAD_CHARS) {
  return { ok: false, reason: 'payload exceeds size limit' };
}
```

`MAX_IPC_PAYLOAD_CHARS = 1024 * 1024`。但 preload 的所有数据面调用都以**对象**形式发送（例如
`ipcRenderer.invoke('app/sessions/create', idempotencyKey === undefined ? body : { body, idempotencyKey })`，
见 `electron/preload/preload.ts`）。因此该限制对绝大多数真实调用**永不触发**。

叠加因素：大量定义只校验 `body` 是对象、不限制其字段规模，例如 `deliveryIdAndBody`、`missionsCreate`、`createWorkspaceExecution`（`admission.value` 整包转发）等：

```ts
const body = (payload as Record<string, unknown>).body;
if (typeof body !== 'object' || body === null) {
  return { ok: false, reason: 'body must be an object' };
}
```

**影响：** 渲染进程（或任何能注入渲染器内容的路径）可提交超大 JSON，主进程会先完整反序列化并持有该对象，再透传给 Service；构成主进程内存/CPU 的资源耗尽面，`MAX_IPC_PAYLOAD_CHARS` 的防护语义名存实亡。

**修复建议：** 在 `admit` 中对所有载荷类型统一按字节计量，不可序列化者直接拒绝。

```ts
// 语义变更为字节数；同步重命名常量并更新引用
export const MAX_IPC_PAYLOAD_BYTES = 1024 * 1024;

function estimatePayloadBytes(payload: unknown): number | null {
  if (payload === undefined || payload === null) return 0;
  if (typeof payload === 'string') return Buffer.byteLength(payload, 'utf8');
  try {
    const serialized = JSON.stringify(payload);
    return serialized === undefined ? null : Buffer.byteLength(serialized, 'utf8');
  } catch {
    return null; // 循环引用 / BigInt 等不可序列化载荷 -> 拒绝
  }
}

// admit 内部替换原片段
const size = estimatePayloadBytes(payload);
if (size === null || size > MAX_IPC_PAYLOAD_BYTES) {
  return { ok: false, reason: 'payload exceeds size limit' };
}
```

**验收：**
- `tests/unit/ipc-registry.test.ts` 中 `'x'.repeat(MAX_IPC_PAYLOAD_CHARS + 1)` 用例改为使用新常量，且新增两条用例：`{ body: { blob: 'x'.repeat(2MiB) } }` 被拒绝；`{ sessionId: 'ok', body: {} }` 被接受。
- 现有“拒绝超大字符串”用例仍通过。

**注意：** 不要为此引入 `v8.serialize` 等新依赖；`JSON.stringify` + 字节计量足够，且与现有 `try/catch` fail-closed 风格一致。

---

### R-2 `noPayloadValidation` 无条件接受任意载荷 + 空通道名陷阱

**证据**（`registry.ts`，约 1355）：

```ts
const noPayloadValidation: IpcDefinition<Record<string, never>> = {
  channel: '' as never,
  validate: () => ({ ok: true, value: {} })
};
```

该定义被 `policyLayersList`、`settingsGet`、`knowledgeList`、`preferencesGet`、`modelsCatalog`、`mcpServersList`、`skillsList`、`hooksList`、`hooksExecutions` 复用。两个问题：

1. `validate` 返回 `ok: true` 且**不检查入参**，与同文件内 `bootstrapDefinition`/`serviceRestartDefinition`/`projectsListDefinition` 采用的
   “仅接受 `undefined`/`null`”严格风格自相矛盾，使“每个通道都有独立 schema 校验”的架构声明出现例外。
2. `channel: '' as never` 依赖对象展开顺序（`{ ...noPayloadValidation, channel: IPC_CHANNELS.x }`）覆盖通道名；一旦书写顺序颠倒或漏写，将以**空字符串通道**注册，静默脱离白名单语义。

**修复建议：** 改为工厂函数，显式传入通道名，并保留 `{}` 兼容（preload 对上述通道正是发送 `{}`，见 `preload.ts` 中 `listPolicyLayers`、`getProductSettings`、`listKnowledge`、`getDesktopPreferences`、`getModelCatalog`、`listMcpServers`、`listSkills`、`listHooks`、`listHookExecutions`）：

```ts
/** 无载荷通道：接受 undefined/null，或键集为空的普通对象（preload 发送 {}）。 */
export function noPayloadDefinition(channel: string): IpcDefinition<Record<string, never>> {
  return {
    channel,
    validate: (payload) => {
      if (payload === undefined || payload === null) return { ok: true, value: {} };
      if (typeof payload === 'object' && !Array.isArray(payload)
          && Object.keys(payload as Record<string, unknown>).length === 0) {
        return { ok: true, value: {} };
      }
      return { ok: false, reason: 'channel takes no payload' };
    }
  };
}

export const policyLayersListDefinition = noPayloadDefinition(IPC_CHANNELS.policyLayersList);
export const settingsGetDefinition = noPayloadDefinition(IPC_CHANNELS.settingsGet);
// …其余通道同样替换
```

**验收：**
- 上述 9 个通道：`admit(channel, TRUSTED, {})` 与 `admit(channel, TRUSTED, undefined)` 均 `ok`；`admit(channel, TRUSTED, { injected: true })` 与 `admit(channel, TRUSTED, [1])` 均被拒绝。
- 新增断言：注册表中不存在空字符串通道（`expect(registry.channels()).not.toContain('')`）。
- **回归红线：** 若把 `{}` 一并拒绝，将直接打断设置中心与知识库等页面的全部读取路径——因此本修复必须保留空对象放行。

---

### R-3 日志脱敏表缺失客户端会话令牌头

**证据：** `electron/main/transport/durableEvents.ts`（约 123）确实把客户端会话令牌放进请求头：

```ts
if (this.clientSessionToken) {
  headers['X-CodeAgent-Client-Token'] = this.clientSessionToken;
}
```

而 `electron/main/security/redaction.ts` 的脱敏集合为：

```ts
const REDACTED_HEADER_NAMES = new Set([
  'authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'
]);
```

**影响：** 任何对请求头的日志输出（含诊断导出路径）会以明文记录 `X-CodeAgent-Client-Token`。该头承载多客户端注册会话凭据，属于与 `authorization` 同级的机密（`redaction.ts` 头注释亦声明“Authorization、cookies 与 API keys 绝不进入桌面日志”）。

**修复建议：** 将其加入集合（`redactHeaders` 已按 `toLowerCase()` 比较，故小写键名即可）：

```ts
const REDACTED_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'proxy-authorization',
  'x-codeagent-client-token',
  'x-codeagent-service-token'
]);
```

**验收：** 在 `tests/unit/security.test.ts` 增加断言：`redactHeaders({ 'X-CodeAgent-Client-Token': 'abc' })` 返回 `'[REDACTED]'`；大小写混写形式（`x-codeagent-client-token`）同样被脱敏。

---

## 3. P2 问题

### R-4 第二实例在 `app.quit()` 后继续执行

**证据**（`electron/main/main.ts`，约 185）：

```ts
const gotLock = app.requestSingleInstanceLock(buildSecondInstanceIntent(process.env, { … }));
if (!gotLock) {
  app.quit();
}

let mainWindow: BrowserWindow | null = null;
const supervisor = new ServiceSupervisor({ … });
const registry = new IpcRegistry();
```

`app.quit()` 不中断同步执行流，因此未持锁的实例仍会继续构造 `ServiceSupervisor`、注册 IPC handler、创建 profile 目录等副作用，直到退出流程真正完成。

**修复建议：** 采用显式早退（把后续初始化包进条件分支，或使用受控的提前 return 辅助函数）。最小改动形态：

```ts
if (!gotLock) {
  app.quit();
} else {
  bootstrapMainProcess();   // 将现有模块级初始化整体迁入此函数
}
```

若不做大范围搬迁，至少在 `app.quit()` 之后立即 `return`（需将模块级初始化移入函数，因为顶层 `return` 在 CJS 中虽合法但可读性差，推荐前者）。

**验收：** 现有 `tests/unit/runtime-scripts.test.ts` 与 `second-instance` 意图校验用例保持通过；新增断言 `validateSecondInstanceIntent` 相关行为不变（该函数本身已正确：限定键集、校验 profileId 与 buildId 字符集）。

---

### R-5 preload 硬编码通道字符串

**证据：** `electron/main/ipc/channels.ts` 定义了 `IPC_CHANNELS`（唯一事实源），但 `electron/preload/preload.ts` 全部使用字面量：

```ts
bootstrap: () => ipcRenderer.invoke('app/bootstrap'),
…
ipcRenderer.on('app/events/status', (_event, status) => { … });
ipcRenderer.on('app/events/durable', handler);
```

**影响：** 通道改名时 TypeScript 无法发现漂移；失败形态是运行期 `unknown channel` 拒绝（`admit` 返回 `'unknown channel'`），属于“只在运行时暴露”的静默破坏。

**修复建议：** 新增**纯常量模块**（不得引入 Electron 或 main-only 依赖），由 main 与 preload 共享：

1. 新建 `electron/shared/ipc-channels.ts`：把 `channels.ts` 中的 `IPC_CHANNELS` 常量**原样迁入**（`as const`），不包含任何 `validate` 逻辑。
2. `electron/main/ipc/channels.ts` 改为 `export { IPC_CHANNELS } from '../../shared/ipc-channels';`，其余校验函数保持不变。
3. `electron/preload/preload.ts` 导入该模块并使用 `IPC_CHANNELS.bootstrap` 等常量，含两个推送通道 `eventStatusPush`、`durableEventsPush`。

**约束：** 不要从 preload 直接 import `ipc/registry.ts` 或 `ipc/channels.ts`——`registry.ts` 依赖 `bootstrap/preferencesStore`、`packages/protocol` 等主进程侧模块，会污染沙箱预加载包。

**验收：** preload 中不再出现 `'app/...'` 字面量（用源码检索确认）；`tsc -p tsconfig.preload.json --noEmit` 通过。

---

### R-6 全局流 gap 检测默认关闭

**证据**（`electron/main/transport/durableEvents.ts`）：

```ts
this.strictCursor = options.strictCursor ?? false;
```

且仅在 `strictCursor` 为真时执行“游标必须 +1 连续性”判定：

```ts
if (this.strictCursor && this.lastSeenCursorInStream !== null
    && cursor !== this.lastSeenCursorInStream + 1) {
  this.onStatus('DISCONNECTED');
  this.stopped = true;
  this.onResync('GAP');
  this.abort?.abort();
  return;
}
```

模块注释已说明“session-scoped 流会过滤事件，故 gap 检测是可选”。这里的风险在于**默认值方向**：未过滤的全局流（`GLOBAL`，`main.ts` 的 `resyncDurableStream` 使用全局快照）若忘记显式传参，将静默接受序号跳跃，导致渲染层状态与 Service 事实漂移，而 `onResync('GAP')` 永不触发。

**修复建议：**
1. 在调用点显式传参并在代码注释中写明依据；**需在实施时确认** `main.ts` 中 `new DurableEventClient({ … })` 的实际构造处是否已传 `strictCursor`（本次审查读取了 `resyncDurableStream` 与状态推送路径，但未读到该构造点，故不作为“已确认缺陷”断言）。
2. 更稳妥的做法是将默认语义改为“调用方必须显式声明”：把 `strictCursor` 改为必填，或在构造函数中对未提供该字段时抛出明确错误，强制每个调用点做出选择。

**验收：** `tests/unit/durable-events.test.ts` 新增/确认用例：非连续游标（如 5 → 7）在严格模式下触发一次 `onResync('GAP')` 且 `stopped=true`；重复游标（5 → 5）被丢弃且不触发 resync。

---

### R-7 `redactSecrets` 的 <8 字符豁免

**证据**（`security/redaction.ts`）：

```ts
for (const secret of secrets) {
  if (secret && secret.length >= 8) {
    out = out.split(secret).join('***');
  }
}
```

`split/join` 而非正则的做法值得保留（无正则注入风险）。但长度阈值意味着任何短于 8 字符的 secret 会原样进入日志。当前真实凭据（`randomBytes(32)` → 43 字符 base64url；nonce 22 字符）远高于阈值，因此这不是即时漏洞，而是**策略与调用侧脱节**：阈值是否安全取决于调用方只传入“足够长的”秘密，该前提未被任何代码强制。

**修复建议（择一，不得同时做行为扩张）：**
- 方案 A（推荐，最小）：保留阈值，但在 `main.ts` 的日志调用点保证传入的 secrets 均来自 token/nonce 生成器，并在 `redactSecrets` 文档注释中写明“长度阈值仅用于避免误替换，禁止传入用户可控短串作为 secret”。
- 方案 B：改为不设长度下限，仅做精确匹配替换。风险是短串可能造成日志文本大面积 `***` 污染，需评估。

**验收：** `tests/unit/security.test.ts` 增加用例固化所选方案（方案 A：断言 43 字符 token 被替换；方案 B：断言任意长度精确匹配被替换）。

---

## 4. P3 与工程质量项

### R-8 重复的外链校验器
`ipc/channels.ts` 的 `validateOpenExternalPayload` 与 `ipc/registry.ts` 的 `openExternalDefinition.validate` 校验同一通道，逻辑等同但为两份实现（`main.ts` 导入并使用 `channels.ts` 版本）。**建议**：保留 `registry.ts` 中的类型化定义作为唯一实现，`channels.ts` 改为复用（`import { openExternalDefinition } from './registry'` 会引入 cricle，建议把 `isHttpsExternalUrl` 校验收敛到 `security/navigation.ts`，两处仅调用它）。**验收：** 两处都不再内联 URL 判定逻辑。

### R-9 不可达分支
`service/supervisor.ts` 中 `attachOrStart` 尾部：

```ts
if (bundled) return this.startBundled(bundled);
…
if (!bundled) {
  this.state = 'START_FAILED';
  throw new HandshakeError('INVALID_CAPABILITIES', 'OWNED_PRIVATE requires a bundled service config');
}
throw new Error('unreachable');
```

在该位置 `bundled` 必为假值，故最后一行永不可达。**建议**删除 `throw new Error('unreachable')`，保留带语义的 `HandshakeError`。**验收：** `tests/unit/supervisor.policy.test.ts` 保持通过。

### R-10 `typecheck` 缺少 `--noEmit`
`package.json`：

```
"typecheck": "tsc -p tsconfig.main.json --noEmit && tsc -p tsconfig.preload.json --noEmit && tsc -p tsconfig.tests.json && tsc -p tsconfig.renderer.json --noEmit"
```

tests 工程是唯一没有 `--noEmit` 的。**先确认** `tsconfig.tests.json` 内部是否已设 `noEmit`/`outDir`；若未设，`pnpm typecheck` 会向工作区落盘 JS 产物。**建议**统一补上 `--noEmit`。

### R-11 悬空的 `eslint-disable` 注释
`registry.ts` 中存在 `// eslint-disable-next-line no-control-regex`，但 `package.json` 的 `devDependencies` 中**没有** ESLint，仓库根也无 ESLint 配置文件，且没有任何 `lint` 脚本。**建议**（二选一，属工具链决策，需产品/团队确认，不要擅自加依赖）：补齐 ESLint 与配置使其生效；或移除悬空注释并把该约束改为单元测试（对 `mcpResourceRead` 传入含 `\u0000-\u001f` 的 uri 断言被拒绝——现有实现已具备该拒绝逻辑，测试化更可靠）。

### R-12 `missionsList` 非对象载荷静默降级

```ts
const sessionId = (payload as Record<string, unknown> | null)?.sessionId;
if (sessionId !== null && sessionId !== undefined && typeof sessionId !== 'string') {
  return { ok: false, reason: 'sessionId must be a string or null' };
}
```

传入数字/字符串等原始值时，属性访问得到 `undefined`，于是返回 `{ sessionId: null }` 并被接受。**建议**先 `requireObjectPayload(payload)` 再取字段，与同文件其他定义保持一致。

### R-13 文档度量过期
`docs/code-review.md` 声称 `App.tsx` 2,781 行、`main.ts` 1,942 行、`queries.ts` 1,117 行。本次实测：**`src/renderer/app/App.tsx` 3,025 行**、`electron/main/main.ts` 1,970 行、`electron/main/ipc/registry.ts` 1,702 行、`src/renderer/app/queries.ts` 1,186 行、`packages/service-client/src/index.ts` 1,504 行。**建议**在修复批次中同步更正，避免后续读者按错误行号定位。

---

## 5. 对既有 `docs/code-review.md` 结论的更正

1. **CSP 缺 `font-src` 不构成缺陷。** 既有文档建议补 `font-src`；实际 `CSP_HEADER` 已含 `default-src 'self'`，`font-src` 会回落到 `default-src`，自托管字体已被允许。仅当引入外部字体源时才需要显式声明——此条应从问题清单移除，避免无意义的策略改动。
2. **`connect-src 'self'` 无需“确保 app:// 不被阻断”。** `app://` 已通过 `privilegedSchemes()` 以 `standard:true, secure:true` 注册，渲染页 origin 即 `app://codeagent`，同源请求属于 `'self'`。既有表述属于不必要的担忧。
3. **`redactSecrets` 的真正缺口不是“短 secret 边界”，而是脱敏清单漏项（R-3）。** 既有文档只提到长度阈值与 `x-forwarded-for`，却未发现 `X-CodeAgent-Client-Token` 这一真实凭据头。
4. **“153 个文件 / 52,299 行”口径不明。** 本次按排除 `node_modules`、`dist`、`dist-electron`、`*.map` 的口径实测为 148 文件 / 43,410 物理行。建议在文档中明确统计口径，否则数字无法复核。

---

## 6. 给 AI IDE 的实施指导（可直接执行的批次计划）

### 6.0 通用约束（每个批次都必须遵守）

- **只做收敛式加固**：不得新增产品功能、不得改变 IPC 通道语义、不得调整 UI 行为。
- **先读后改**：动手前完整读取目标文件与对应测试文件；`registry.ts`、`main.ts`、`preload.ts` 文件体积大，必须分段读全再改。
- **单文件小步提交**：一次只改一个文件，改完立刻跑该文件相关测试，再进入下一个。
- **禁止新增依赖**（R-11 的 ESLint 决策除外，且需人工确认）。
- **每批结束必须全绿**：`pnpm typecheck` + `pnpm test`。
- **失败即停**：若发现本文件与本文描述不一致（例如行号/符号已变动），停止并报告差异，不要凭猜测继续。

### 批次 1（P1，独立可并行验证）
1. `electron/main/ipc/registry.ts`：实现 R-1（`estimatePayloadBytes` + 字节上限、常量更名）。
2. `tests/unit/ipc-registry.test.ts`：更新常量引用，新增“大对象被拒”“合法对象被收”用例。
3. 运行 `pnpm vitest run tests/unit/ipc-registry.test.ts`。

### 批次 2（P1）
1. `electron/main/ipc/registry.ts`：实现 R-2（`noPayloadDefinition(channel)` 工厂），替换 9 个复用 `noPayloadValidation` 的定义。
2. `tests/unit/ipc-registry.test.ts`：新增空对象放行、非空对象拒绝、无空字符串通道三条断言。
3. 运行 `pnpm vitest run tests/unit/ipc-registry.test.ts tests/unit/settings-ipc.test.ts`。
4. **手工回归检查点**：确认 preload 对 `getDesktopPreferences`、`getProductSettings`、`listKnowledge`、`listPolicyLayers`、`getModelCatalog`、`listMcpServers`、`listSkills`、`listHooks`、`listHookExecutions` 均发送 `{}`，与批次 2 的放行规则一致。

### 批次 3（P1）
1. `electron/main/security/redaction.ts`：R-3 补入 `x-codeagent-client-token`、`x-codeagent-service-token`。
2. `tests/unit/security.test.ts`：新增脱敏断言（含大小写混写）。
3. 运行 `pnpm vitest run tests/unit/security.test.ts`。

### 批次 4（P2，按 4 → 5 → 6 → 7 顺序）
1. `electron/main/main.ts`：R-4 早退/初始化搬迁；运行 `tests/unit/runtime-scripts.test.ts`。
2. 新增 `electron/shared/ipc-channels.ts`，改 `ipc/channels.ts` 与 `preload/preload.ts`（R-5）；运行 `pnpm typecheck`。
3. `electron/main/transport/durableEvents.ts`：R-6（先确认调用点，再决定显式传参或改必填）；运行 `tests/unit/durable-events.test.ts`。
4. `electron/main/security/redaction.ts`：R-7 方案 A 或 B；同步 `tests/unit/security.test.ts`。

### 批次 5（P3 清理，可与其他批次拆分提交）
R-8、R-9、R-10、R-12、R-13 逐项单独提交，每项附最小验证命令。

### 6.1 每批完成后的验证命令

```
pnpm typecheck                 # 主进程 / preload / tests / renderer 四套 tsconfig
pnpm test                      # vitest run（全量）
pnpm build                     # 可选：tsc main + tsc preload + vite build
```

**相关测试文件锚点：** `tests/unit/ipc-registry.test.ts`（IPC 准入）、`tests/unit/security.test.ts`（沙箱/脱敏/导航）、`tests/unit/supervisor.policy.test.ts`、`tests/unit/supervisor.process.test.ts`、`tests/unit/durable-events.test.ts`、`tests/unit/connection-coordinator.test.ts`、`tests/unit/settings-ipc.test.ts`、`tests/unit/runtime-scripts.test.ts`。

### 6.2 完成定义（Definition of Done）

- [ ] R-1：object 载荷超限被拒绝，且不可序列化载荷 fail-closed。
- [ ] R-2：无载荷通道放行 `undefined`/`null`/`{}`，拒绝其他一切；注册表无空通道名。
- [ ] R-3：`X-CodeAgent-Client-Token` 在脱敏后不再出现明文。
- [ ] R-4：未持锁实例不再执行服务/窗口初始化副作用。
- [ ] R-5：preload 无 `'app/...'` 字符串字面量，通道名单一事实源。
- [ ] R-6：全局流的 gap 语义在调用点被显式声明并有测试覆盖。
- [ ] R-7：所选脱敏策略被单元测试固化。
- [ ] 上述批次全部完成后 `pnpm typecheck` 与 `pnpm test` 全绿。
- [ ] `docs/code-review.md` 度量已更正（R-13）。

### 6.3 明确不做（Non-Goals）

- 不拆分 `App.tsx`（3,025 行）/ `main.ts`（1,970 行）/ `registry.ts`（1,702 行）等巨型文件——那是独立重构议题，不属于本次缺陷修复。
- 不改动 CSP 指令集、不新增 `font-src`（见 §5 更正 1）。
- 不调整 `strictCursor` 之外的流控参数、不改 batch/backoff 默认值。
- 不引入 ESLint/Prettier 等新工具链（R-11 需人工决策）。

---

## 7. 未验证项 / 需实施时确认（诚实声明）

1. **`DurableEventClient` 的实际构造参数**（`strictCursor` 是否已传）——本次未读到 `main.ts` 中的构造点，R-6 的严重度需在该处确认后才能定级为“已确认缺陷”。
2. **`tsconfig.tests.json` 是否已在文件内设置 `noEmit`/`outDir`**——R-10 建议在确认后再改脚本，避免重复配置。
3. **`dist-electron/` 与 `dist/` 内的产物是否为当前源码构建结果**——本次审查基于源码，未做产物与源码一致性比对。
4. **`packages/protocol/src/openapi-schema.gen.ts`（7,842 行，生成文件）**——按生成文件处理，未纳入逐行审查；修改协议类型应通过 `pnpm gen:protocol` 重新生成。
5. **`docs/del-doc/2026-09-07-desktop-ui-mainstream-alignment-detailed-design.md`** 与代码的一致性——未逐条比对设计条款。
6. 本次审查为**只读分析**：未执行 `pnpm test` / `pnpm typecheck`，因此 §1 中所有结论均基于源码阅读，构建与测试结果需由实施阶段产出。
