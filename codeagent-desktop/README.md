# CodeAgent Desktop

Electron 桌面端是 Service 的客户端。默认连接模式是 `SHARED_ATTACH`：先连接已经运行的本地
Service；它不会因为 attach 失败而偷偷启动第二个 Service。`OWNED_PRIVATE` 只能由显式配置选择，
并且只允许 supervisor 停止自己实际 spawn 且仍持有句柄的子进程。

## 快速启动

在 BusinessAgentCode 根目录已有 Service 和有效 bearer token 时：

```powershell
Set-Location D:\project\codex-workspace\BusinessAgentCode\apps\codeagent-desktop
.\start-with-service.ps1 -CheckOnly
.\start-with-service.ps1 -Build
```

`-CheckOnly` 只检查 loopback `/health/live` 和带 token 的 `/api/v2/capabilities`，不启动 Electron，
也不写入 token。脚本会把 endpoint/token 仅注入本次 PowerShell 子进程；PowerShell 不使用 Unix
`export`。开发环境需要重新构建时使用 `-Build`，已有构建则省略。

显式 profile：

```powershell
$env:CODEAGENT_DESKTOP_PROFILE = 'operator-a'
.\start-with-service.ps1 -CheckOnly
```

更完整的安装/升级/回滚顺序见
[docs/mc-wu13-operations.md](docs/mc-wu13-operations.md)，故障诊断和取证见
[docs/mc-wu13-debug.md](docs/mc-wu13-debug.md)。

## Profile 与秘密边界

默认 profile 根是 `%USERPROFILE%\.codeagent\desktop-profiles`；打包运行时目录为
`<root>\<channel>\<profileId>`，通常是 `stable\<profileId>`；开发运行时 channel 为 `dev`。
`--desktop-profile <id>` 优先于 `CODEAGENT_DESKTOP_PROFILE`；两者冲突会 fail closed。profile id
必须是小写安全标识（最多 48 个字符），profile root 不能与仓库 `.git` 或 Service `stateDir`
重叠，也不能通过 symlink/junction 穿越。

profile 目录下由 Main 管理：

```text
profile-manifest.json       稳定 clientId、当前 processInstanceId、schema/channel
user-data/config.json       attachEndpoint、非秘密 bundledService、上次 serviceInstanceId
user-data/token.enc         仅在 OS safeStorage 可用时保存的加密 bearer token
user-data/preferences.json  版本化非秘密 UI preferences
session-data/ logs/ crash-dumps/ diagnostics/
```

旧 `config.json` 中的 endpoint、bundled service 元数据和 UI preference 可以作为非秘密配置导入；
`preferences.notificationsEnabled` 只有在同一 profile 的 `preferences.json` 尚不存在时自动迁移。
bearer token、model API key 等秘密必须重新配置或通过一次性环境变量提供；不要把明文秘密写入
`config.json`、命令行、备份清单或诊断包。safeStorage 不可用时 token 只留在本次进程内。

## 当前实现的运维事实

- `SHARED_ATTACH` attach 失败不会 fallback 到本地 child；`OWNED_PRIVATE` 启动 child 时使用随机端口、
  随机 token 和启动 nonce，并在 capability handshake 成功前保持失败态。
- Service 返回不兼容协议、无效 capabilities、401/404 或 schema mismatch 时，桌面保持降级/失败，
  不猜测协议，也不把旧 Service 当成新 Service。
- 多客户端 Service 为 Electron 注册短期 client-session；session token 只在 Main 内存中，后续请求和
  durable event stream 使用 `X-CodeAgent-Client-Token`。heartbeat 失败会清掉旧 session 并重新注册。
- event stream 遇到 cursor 过期或严格 cursor gap 时，先读取有界、固定 high-water mark 的 snapshot，
  只有 `complete=true` 后才从 snapshot cursor 续流；不会用 `restart(0)` 冒充恢复。
- mutation 的网络超时、断连或 5xx 不代表未执行。保留原 idempotency key，查 operation receipt；状态为
  `UNKNOWN` 时禁止新建 key 盲重放。

## 个人接入（`client-access/1`）

桌面端在 Service 连接之外提供一条独立的个人接入通道：直接连个人访问服务（PAC），
按 `client-access/1` 工作，不经过 Service，也不因为 Service 不可用而改指向。

- 入口：左侧导航「个人接入」。首次使用填写服务地址、基础路径、可选 CA 证书路径与访问令牌，
  `保存并连接` 后 `CONFIGURE` + `CONNECT`。
- 令牌只经 `CONFIGURE` 写入一次，由主进程保存（safeStorage 可用时加密落盘，否则仅本次进程内有效），
  渲染端拿不到令牌，也不会回显。
- 自签证书的 PAC 用 `caPemPath` 指定 PEM；证书校验始终开启，不会降级为跳过校验。
- 面板只提交有界操作（`STATUS/CONFIGURE/CONNECT/DISCONNECT/AGENTS/CONVERSATIONS/CONVERSATION/REPLIES/CONTENT/SEND/ACTION/LOOKUP`），
  URL、方法、消息 binding、动作 binding 与幂等键都由主进程决定。
- 回复是 POLL；`TEXT_SNAPSHOT` 整体替换，`unchanged` 轮询不会清掉正在阅读的正文。
- 发信或动作失败时保留原 requestId 并给「查询回执」，不会自动重发；不可用动作保留在界面上并显示原因码。
- 审批类动作在提交前展示完整问题上下文。

实现位置：`packages/client-access/src/`（端口、操作白名单、状态类型）、
`electron/main/personal-access/`（绑定、令牌、CA 钉扎 fetch、持久 pending）、
`electron/main/ipc/personalAccess.ts`、`src/renderer/app/PersonalAccessPanel.tsx`。
确定性测试：`tests/unit/client-access-port.test.ts`、`personal-access-session.test.ts`、
`personal-access-ipc.test.ts`、`personal-access-loopback.test.ts`（回环 HTTP 线路，非真实 ACS）、
`tests/renderer/personal-access-panel.test.tsx`。

本节的通过范围仅限上述本机测试/构建；真实 PAC 配对、真实模型旅程与其它前端采用不在本节范围内。

## 证据边界

本目录的 `pnpm test`、`pnpm build` 和 `-CheckOnly` 只能证明对应的本地测试/构建/握手结果。除非另有
完整运行记录，不得据此宣称真实跨进程多客户端 E2E、升级回滚 E2E、故障注入、Provider 或 GA 已通过。

## 本机个人 Mac 任务入口

显式设置 `CODEAGENT_PERSONAL_ENDPOINT=http://127.0.0.1:<管理网关端口>` 后启动桌面，
显示独立的 Mac 任务界面。此模式连接生产 `/api/personal/v1`，不要求或宣称 ACS
`/api/v2` 握手资格。未设置时继续使用原 Workbench 连接流程。

endpoint 仅在 main 读取，必须是无路径、凭据或查询的本机 HTTP origin。main 持有生产
个人网关的 cookie/tab 会话，通过原 preload/IPC 的固定操作白名单代理；renderer 不持有
endpoint、cookie、bearer 或任意 HTTP 权限。该网关采用本机 owner 会话，无需另造 bearer。

界面只创建已登记 `macos` / `MAC_MANAGED` 任务。预检未支持的操作不启用。
创建请求的五字段正文及原请求键保存在本 profile 的本机界面存储中；重启后可只读恢复原请求，
回执未确认时仅允许按服务端读回的原正文和原键继续核对。STOP 保存完整 guard 和原键，
后续按钮只读取原回执。任务状态、公开输出、活动与成果来自原来源；成果核对实际 bytes 的
SHA-256，STOP 的请求受理、remoteStopConfirmed、localQuiescent、quiescent 分别呈现。

`pnpm e2e:mac` 需由 EDC `distribution/macos/verify-web-electron.py --lane electron`
注入独立真实 Host/管理网关环境；同时传入 `--drop-create-reply` 验证回执丢失后的原键恢复。
runner 使用真实 Electron 窗口点击、进程重启、preload/IPC 与 main HTTP，不装假 bridge 或路由响应。
输出 `MAC_E2E_OUTPUT_DIR/result.json`（`mac-electron-e2e/1`）及过程截图；真实资格仍需核对
外层 runtime 的 Host 账本、Apple 验收报告和 STOP 事实，客户端退出码不能单独授予整链资格。
