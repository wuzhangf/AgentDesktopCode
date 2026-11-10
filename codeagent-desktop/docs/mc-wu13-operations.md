# MC-WU13：CodeAgent Desktop 安装、升级与回滚

本文是当前实现的可执行运维切片。命令以 Windows PowerShell 为主；路径必须替换成当前机器的
绝对路径。所有步骤都假定 BusinessAgent Service 只绑定 loopback。若 Service 由其他工具托管，
该托管工具仍是唯一的 stop/start owner。

## 0. 术语与不可混淆的边界

| 名称 | 含义 | 运维结论 |
| --- | --- | --- |
| `profileDir` | Desktop 的本地 profile：`<profileRoot>\<channel>\<profileId>` | 备份 UI 身份和偏好；不要放进仓库、`.git` 或 Service `stateDir` |
| `stateDir` | Service 的共享持久状态，当前 control-plane SQLite 默认文件为 `gui-sessions.db` | 升级/回滚前须停 Service 并备份；不要让两个 Service 指向同一目录 |
| `SHARED_ATTACH` | Electron 连接外部/已运行 Service | attach 失败不启动本地 child；停止 Desktop 不等于停止 Service |
| `OWNED_PRIVATE` | Electron 显式 spawn 自己的 Service child | 只可停止本 supervisor 持有的 child 句柄；不能按端口/PID 杀未知 Java 进程 |
| profile manifest | Desktop 身份与当前进程实例 | `clientId` 跨进程稳定，`processInstanceId` 每次启动变化；profile/schema 不匹配必须留证 |
| client-session | Service 给一个客户端进程的短期 session | token 不落盘；断线/过期后重新注册，不复制旧 token |

当前源码没有可证明的通用 `stateDir` 文件 owner lock/owner proof。SQLite 的 busy timeout、迁移备份和
桌面单实例锁不能替代 Service 进程级 owner proof。因此涉及 stateDir 的操作必须由运维者完成“唯一
托管者 + 已停机 + 配置指向一致”的证明，并记录 PID、配置绝对路径、stateDir、时间和 hash。

## 1. 安装/首次运行

### 1.1 选择并冻结路径

```powershell
$desktop = '<repo>\apps\codeagent-desktop'
$serviceConfig = '<config>\service.properties'
$profileRoot = Join-Path $env:USERPROFILE '.codeagent\desktop-profiles'
$profileId = 'operator-a'
$channel = 'stable'
$env:CODEAGENT_DESKTOP_PROFILE_ROOT = $profileRoot
```

profile root 必须是绝对路径，且不能位于仓库 `.git`、Service `state.dir` 或其父子重叠路径内。
用只读审计脚本先确认路径和已有身份：

```powershell
Set-Location $desktop
.\scripts\profile-state-audit.ps1 -Action Inspect `
  -ProfileRoot $profileRoot -Channel $channel -ProfileId $profileId `
  -ServiceConfig $serviceConfig
```

脚本输出只包含路径、文件大小、schema/身份摘要和秘密是否存在，不输出 token 内容。脚本默认不写文件、
不启动/停止进程、不修改 profile/stateDir。

### 1.2 先验证 Service，再启动 Desktop

```powershell
Set-Location $desktop
$env:CODEAGENT_DESKTOP_PROFILE = $profileId
.\start-with-service.ps1 -ServiceConfig $serviceConfig -CheckOnly
```

成功条件：`/health/live` 为 200，带 bearer 的 `/api/v2/capabilities` 为 200，且返回非空
`protocolVersion`。`-CheckOnly` 成功不等于客户端已注册、不等于任务执行成功。

```powershell
.\start-with-service.ps1 -ServiceConfig $serviceConfig -Build
```

首次启动会创建 profile 目录和 `profile-manifest.json`。检查记录至少包括：

```text
profileId / channel / profileDir
manifest.schemaVersion / clientId / processInstanceId
Service endpoint（只记 loopback origin）/ protocolVersion / serviceInstanceId
SHARED_ATTACH 或 OWNED_PRIVATE
若有 multi-client：storeId、bootId、client-session 是否 REGISTERED
safeStorage 可用性；不得记录 token
```

## 2. 旧配置导入与秘密重新配置（必须分开）

### 2.1 先备份，再导入非秘密配置

旧版本可能使用旧的 Electron user-data 目录。不要把旧目录整体覆盖到新 profile；先关闭 Desktop，
保留原目录只读副本，然后只迁移以下字段：

- `config.json.attachEndpoint`（必须仍为 loopback、无 userinfo/query/fragment/path）。
- `config.json.bundledService`（仅在明确选择 `OWNED_PRIVATE` 时使用；逐项复核 command/args/cwd）。
- `config.json.preferences.notificationsEnabled`。应用在同一新 profile 中仅当 `preferences.json` 缺失时
  自动把这一项种入新 preferences store；其它旧/未知字段不会成为新配置。
- `config.json.lastServiceInstanceId` 仅作为“上次见过的身份”提示，不能当作当前 Service 的证明。

不要把旧 `token.enc` 当成可迁移秘密。它依赖当前 OS/Electron safeStorage 密钥；可保留在备份中，
但不能把复制成功当作解密成功，也不能把它转换成明文。

### 2.2 单独重新配置秘密

endpoint/token 以 `busi-agent-config/service.properties` 为准（`auth.token`），启动器读取后只注入本次
Electron 进程；校验握手：

```powershell
.\start-with-service.ps1 -Profile $profileId -CheckOnly
```

注入只进入本次 Electron 进程，不会覆盖 profile 中已有的 credential record。若使用 UI/安全存储
保存 token，只接受 OS safeStorage 可用且 UI 明确显示已持久化的结果；不可用时通过启动器重新注入。
model API key 属于 Service 配置，写入受控的 `model-providers.properties` 对应环境变量；不得写进 Desktop
profile、诊断输出或 Git。

成功握手后记录非秘密证据：HTTP 状态、protocolVersion、serviceInstanceId、token 是否“已提供/已持久化”
布尔值。不要记录 bearer 本身、client-session token、启动 nonce 或完整命令行。

## 3. Service / Desktop 升级顺序

### 3.1 升级前冻结与 owner proof

1. 让所有 GUI/CLI/Web 客户端停止新 mutation；等待正在运行的任务进入终态或由业务 owner 决定如何处理。
2. 记录当前 Service 的绝对 config path、`state.dir`、监听 endpoint、PID、`serviceInstanceId`、
   `storeId/bootId`（若能力返回），以及 `gui-sessions.db` 的 SHA-256/大小。
3. 明确谁拥有该 PID 和 stateDir。只接受托管器/终端能够解释“此 PID 使用此 config、此 config 指向此
   stateDir”的证据；端口占用本身不是 owner proof。
4. 停止 Service，并重新检查该 PID 已退出、端口不再由该 Service 占用。不要使用端口扫描结果去杀 PID。
5. 在 Service 停止后执行审计脚本的 Backup 动作。它需要显式目标目录，目标已存在或 Service 进程仍匹配
   config 时会拒绝，且从不覆盖：

```powershell
Set-Location $desktop
$backup = 'D:\ops\codeagent-backups\2026-09-05\state-before-upgrade'
New-Item -ItemType Directory -Path (Split-Path -Parent $backup) -Force | Out-Null
.\scripts\profile-state-audit.ps1 -Action Backup `
  -ProfileRoot $profileRoot -Channel $channel -ProfileId $profileId `
  -ServiceConfig $serviceConfig -BackupDestination $backup
```

`Backup` 只复制 stateDir，并在复制后报告文件数和 `gui-sessions.db` hash；若发生错误，目标可能是不完整，
必须标为 `INCOMPLETE`，不可拿来回滚。

### 3.2 先升级 Service，再逐个升级客户端

1. 用新 Service 二进制、原 config path 和原 stateDir 启动。当前 control-plane 迁移是 additive、事务化的，
   已有数据库升级前会在 `stateDir\control-plane-migration-backups\gui-sessions-before-v<oldVersion>.db`
   留一份一次性备份；不要删除它。
2. 若旧数据库的 `PRAGMA user_version` 高于该 Service 支持的迁移数，启动应失败并报告
   `STATE_STORE_ERROR`/“schema is newer than supported”。不要强行改 `user_version`，改用匹配版本的
   Service 或备份恢复流程。
3. 用 `start-with-service.ps1 -CheckOnly` 验证健康、bearer、capability handshake 和 protocol；确认
   `serviceInstanceId` 变化是预期的重启/重装，而不是连到了另一套 stateDir。
4. 保持 `clients.mode=LEGACY_COMPAT`，逐客户端升级并确认每个新客户端完成 client-session registration。
   只有所有写客户端均已升级并有独立记录后，才由 Service owner 明确切换 `clients.mode=SHARED_STRICT`；
   这不是 Electron 的 `CODEAGENT_SERVICE_MODE` 环境变量。
5. 每个 Desktop profile 逐一启动并记录 manifest、capability、client-session、事件流状态。profile
   schema mismatch、旧配置损坏或旧 Service 均应停在降级/失败状态，不做猜测式修复。

### 3.3 旧 Service 与旧客户端的行为

- 旧 Service 没有 `/api/v2/capabilities`、返回 404、protocol 不兼容或 capabilities 结构不完整：停止升级，
  保留 HTTP 响应和日志证据，不能把 404 当作“无能力但可继续写”。
- 新 Service + 未注册旧客户端：在兼容模式下，旧的 bearer/legacy stream 只用于有限读取；需要注册的
  snapshot、operation receipt、terminal control/input 会返回 `CLIENT_REGISTRATION_REQUIRED`（428）。
  严格模式还会拒绝未注册 mutation。不要通过删除 header 退回 legacy write。
- 新 Desktop + 旧 Service：握手 fail closed；不要把旧 `serviceInstanceId`、旧 cursor 或旧 receipt 当成新
  Service 的事实。
- `serviceInstanceId` 改变只说明当前连接看到的 Service 身份不同；它可能是重装/重启/换实例，必须和
  stateDir、storeId、bootId、备份记录一起判断。

## 4. 回滚

回滚分为“客户端文件/界面回退”和“共享 Service 状态回退”，两者不能混为一次操作。

### 4.1 Desktop 回滚（优先）

1. 停止新 Desktop；保留新 profile 和 diagnostics，不删除。
2. 恢复旧 Desktop 安装包，但继续使用同一个 profile 时先确认它能理解
   `profile-manifest.json` schema；若不能，切换到独立的旧 profile 目录，不覆盖新目录。
3. 重新提供旧版本需要的 endpoint/token；不要复制新 client-session token，不要把新 profile 的未知字段
   改写成旧格式。
4. 只验证 read/attach/界面状态。新版本已经提交的命令、Run、receipt、event journal 不会因 UI 回滚而撤销。

### 4.2 Service/stateDir 回滚

仅当新 Service 无法读取旧数据或迁移结果不可接受时执行：

1. 进入维护窗口，停止所有客户端新 mutation，等待/记录在途 Run、receipt 和 outbox；网络超时或无响应的
   mutation 先查 receipt，`UNKNOWN` 不得重放。
2. 重新取得唯一 owner proof，停止 Service，确认 PID 退出；制作当前 stateDir 的第二份只读备份。
3. 校验 `state-before-upgrade` 备份的目录、文件清单、`gui-sessions.db` hash 与记录一致；不接受
   `INCOMPLETE` 备份。
4. 将当前 stateDir 移到人工保留目录（不要删除），再把经过校验的备份复制为一个新的、明确的 stateDir。
   这一步是有破坏风险的人工操作；本文脚本不执行覆盖、删除、rename 或 stop。
5. 用旧 Service 启动并检查它能读 schema；若旧 Service 不能读，立即停止，不修改 SQLite schema，改走
   匹配版本的恢复路径。
6. 以新的启动记录重新确认 endpoint、`serviceInstanceId`、store/boot identity 和 receipt 查询，再逐一
   让客户端 attach。旧 cursor 必须按 snapshot 恢复，不得假设旧 cursor 在新 journal 上仍有效。

回滚只恢复持久事实的一个已校验副本，不会“撤销”已对外部 workspace 或模型执行的副作用。对未知执行结果，
保留 `UNKNOWN` 并人工对账。

## 5. 失败恢复与证据记录

每次安装/升级/回滚建立一个不含秘密的 `incidentId`，记录：

```text
incidentId / operator / UTC start-end / host
desktop build/version / profileId / channel / profileDir
manifest schemaVersion / clientId / processInstanceId
service config absolute path / stateDir / PID / endpoint origin
serviceInstanceId / storeId / bootId / protocolVersion
mode: SHARED_ATTACH|OWNED_PRIVATE
capability HTTP status + reasonCode/operation availability（如有）
client-session: REGISTERED|EXPIRED|RECONNECTING|NOT_SUPPORTED
event stream: CONNECTED|RECONNECTING|DISCONNECTED；snapshotCursor/highWaterMark/complete/truncated
operationId/receiptId/requestHash/status（仅记录业务允许的非秘密标识）
stateDir backup destination / file count / db size+SHA-256 / COMPLETE|INCOMPLETE
commands executed + exit code + stdout/stderr file paths（先脱敏）
```

不要记录 bearer、client-session token、model API key、safeStorage 明文、启动 nonce、完整环境变量或完整
命令行。测试绿灯只能作为局部证据；没有真实多进程、多客户端和故障场景记录时，结论写成
`NOT_RUN`、`NOT_PROVEN` 或 `BLOCKED`，不能写 `E2E PASSED`。
