# MC-WU13：CodeAgent Desktop 故障诊断与取证

先保留现场，再修复。不要先删除 profile、token.enc、stateDir、migration-backups、日志或旧安装包。
任何“重启”都必须明确是 Desktop 重启、外部 Service 重启，还是 supervisor 自有 private child 重启。

## 1. 最短安全诊断路径

```powershell
$desktop = '<repo>\apps\codeagent-desktop'
$serviceConfig = '<config>\service.properties'
$profileRoot = Join-Path $env:USERPROFILE '.codeagent\desktop-profiles'
$profileId = 'operator-a'
$env:CODEAGENT_DESKTOP_PROFILE_ROOT = $profileRoot

Set-Location $desktop
.\scripts\profile-state-audit.ps1 -Action Inspect `
  -ProfileRoot $profileRoot -Channel stable -ProfileId $profileId `
  -ServiceConfig $serviceConfig
.\start-with-service.ps1 -ServiceConfig $serviceConfig -CheckOnly
```

记录两个结果的时间、退出码和脱敏输出。`-CheckOnly` 只证明当前 endpoint 的 liveness/capability，
不能证明 renderer 已加载、client-session 已注册、事件已恢复或 Run 已完成。

## 2. 按信号区分问题

### 2.1 Service 不可达 / 401 / 404

| 信号 | 可能含义 | 处置与证据 |
| --- | --- | --- |
| `/health/live` 非 200或超时 | Service 未运行、端口/配置错误、Service 启动失败 | 保存响应/超时、Service stdout/log path；由 owner 启动或修复配置 |
| liveness 200，capability 401 | bearer 与 Service `auth.token` 不一致，或秘密未提供 | 重新配置秘密；只记录 HTTP 状态和 token-present 布尔值，不打印 token |
| liveness 200，capability 404 | 旧 Service/旧发行目录/错误端口 | 保存 `Server` 响应头、Service PID/config/stateDir；切换到匹配版本，不在客户端降级写 |
| capabilities JSON 无 `protocolVersion`/operations | 旧或损坏 Service，协议契约不完整 | Desktop fail closed；保留 body（脱敏）和 build provenance |
| protocol incompatible / `SERVICE_TOO_OLD`/`SERVICE_TOO_NEW` | 版本 skew | 逐层对齐 Service/Desktop；不要改 manifest 或伪造 protocol |

### 2.2 `PROFILE_ARGUMENT_CONFLICT` / `INVALID_PROFILE_ROOT`

Profile 选择顺序是：`--desktop-profile` > `CODEAGENT_DESKTOP_PROFILE` > 打包默认 channel > 开发默认
（由 app root 的 canonical path 派生）。若显式参数和环境变量不同，启动拒绝。

检查：

```powershell
Get-ChildItem Env:CODEAGENT_DESKTOP_PROFILE,Env:CODEAGENT_DESKTOP_PROFILE_ROOT -ErrorAction SilentlyContinue
Resolve-Path -LiteralPath $profileRoot
```

修复：清除冲突变量或使用同一个小写 profile id；profile root 改到仓库和 Service `stateDir` 之外的绝对
普通目录。不要通过 junction/symlink 绕过检查，也不要把 `stateDir` 当 Desktop profile root。

### 2.3 `profile-manifest.json` 损坏或 schema mismatch

实现行为是：读取失败、JSON 非法、schema/profile/channel 不匹配、字段集/值非法或超过 4096 bytes 时，
原文件会被改名为 `.profile-manifest.json.invalid.<uuid>.json`，随后以新 `clientId` 创建当前 manifest。
这不是“自动恢复旧身份”的证明。

处置：

1. 复制 invalid 文件和当前 manifest 到 incident 目录，记录大小/hash；不要覆盖 invalid 文件。
2. 确认启动参数中的 profileId/channel 与目录一致。
3. 若必须保留旧 clientId，先停 Desktop，由 owner 从备份中选择与当前 schema 完全匹配的 manifest；不手工
   拼接 UUID、时间戳或未知字段。
4. 重启后记录新旧 `clientId`、新的 `processInstanceId`，并把“身份是否改变”作为迁移影响，而不是故障已修复。

### 2.4 `SHARED_ATTACH`、`OWNED_PRIVATE`、单实例锁

| 现场 | 解释 | 安全动作 |
| --- | --- | --- |
| attach 失败后没有 Service child | 这是 `SHARED_ATTACH` 的预期 fail-closed 行为 | 启动/修复外部 Service；不要期待 Desktop 自动补起第二个 writer |
| `OWNED_PRIVATE` 启动失败/timeout | child 未在 handshake deadline 内返回合法 capabilities，supervisor 会清理自己 spawn 的 child | 保存 Desktop 日志和 child pid/port；不要杀同端口其他进程 |
| 新窗口秒退/旧窗口被 focus | 同一 `profileId` 的 `requestSingleInstanceLock` 生效 | 关闭已知旧 Desktop；不要按 `electron`/端口批量杀进程 |
| 停 Desktop 后 Service 仍在 | `SHARED_ATTACH` 下 Service 不归 Desktop 所有 | 由 Service owner 操作托管器；先证明 PID/config/stateDir |
| `serviceInstanceId` 与上次不同 | 当前连接看到不同 Service identity | 同时比较 stateDir、storeId、bootId、PID和备份；不要只看端口 |

Desktop diagnostics IPC 可提供 `serviceState`、自有 child 的 pid/port/nonce、日志位置和 safeStorage 可用性；
nonce 只用于内部诊断，不应进入共享工单或普通日志。

### 2.5 client-session 过期、旧客户端或 428

正常注册顺序是 bearer capability handshake → `POST /api/v2/client-sessions` → 保存短期 token 到 Main 内存
→ heartbeat → 带 `X-CodeAgent-Client-Token` 访问需要注册的路线。`clientId` 来自 profile manifest；
`processInstanceId` 来自本次启动。

看到 `CLIENT_REGISTRATION_REQUIRED`（428）、`CLIENT_SESSION_EXPIRED`（401）或 client-session
`RECONNECTING` 时：

1. 不复制/重放旧 client-session token；不把它写入 config 或诊断。
2. 重新执行 capability handshake，确认 Service identity 未变化。
3. 让 Desktop 重新注册；记录 registration HTTP 状态、storeId/bootId、TTL 的非秘密数值。
4. 如果是旧客户端，先保持 `LEGACY_COMPAT`，但不要假设所有写路线兼容；需要 receipt/snapshot/terminal
   的路线必须升级客户端。
5. `SHARED_STRICT` 下未注册 mutation 被拒绝是预期门禁，不是网络重试理由。

### 2.6 receipt、超时和未知结果

以下状态不能混为“失败且未执行”：

| 状态/信号 | 结论 | 下一步 |
| --- | --- | --- |
| `APPLIED` | Service 已应用该命令/记录；不等同于长任务已成功 | 查询关联 Run/资源状态 |
| `NOT_APPLIED` | 明确未应用 | 只有合同允许时用原 key 重试；保留原 request hash |
| `UNKNOWN`、网络超时、断连、未知 5xx | 效果未能证明 | 用原 operation/receipt 查询和下游状态对账；禁止新 key 盲重放 |
| `IDEMPOTENCY_CONFLICT` | 同 key 对应了不同请求 | 停止重试，保存 key/request hash，修正调用方 |
| receipt 查询也不可达 | 事实暂不可证 | 标 `UNKNOWN`，不要把 UI 错误改写成未执行 |

receipt 取证只保留 operation、resourceId、receiptId、requestHash、status、reasonCode 和时间；请求正文、
token、模型输入和 workspace 秘密按最小必要原则脱敏。

### 2.7 event stream 断流、cursor 过期、snapshot 不完整

Electron durable stream 使用 `afterCursor`/`Last-Event-ID`，严格模式要求未过滤 global stream 连续递增。
出现 HTTP 409、`EVENT_CURSOR_EXPIRED` 或 `GAP` 时，正确路径是：

```text
停止旧流
→ GET bounded event snapshot（固定 high-water mark，按 nextPageToken 分页）
→ 每页验证 cursor 单调、scope、pageSize/bytes 上限
→ 仅 complete=true 且 highWaterMark 已知时接受
→ 从 snapshotCursor/highWaterMark restart
→ 只应用 cursor 大于 snapshotCursor 的 live event
```

如果 `complete=false`、`truncated=true`、high-water mark 移动、分页无进展或 scope 不符，标为
`EVENT_SNAPSHOT_INCOMPLETE`/`EVENT_SNAPSHOT_MOVED`/`EVENT_SNAPSHOT_NO_PROGRESS`，停止自动恢复并保存
响应元数据。不要用 `restart(0)`，不要把“重新连上”写成“事件已完整恢复”。

### 2.8 stateDir 锁、owner proof、schema mismatch

现有 Service 启动会打开 `stateDir\gui-sessions.db`，设置 SQLite `busy_timeout=5000`，并执行控制面迁移；
这解决同一进程内连接等待，不构成跨 Service 的 owner lock。启动时若 schema 高于支持版本会拒绝打开，
旧 schema 会事务化迁移并保留 migration backup。

在任何 stateDir 复制/恢复前，必须有以下证据：

```text
owner = 托管器或人工 owner
servicePid = <已退出或当前唯一受控 PID>
configPath = <绝对路径>
stateDir = <由该 config 解析出的绝对路径>
endpoint = <loopback origin>
pid/config/stateDir 一致性检查时间
```

PowerShell 审计脚本会在 `Backup` 时拒绝仍能匹配该 config 的 Service 进程、拒绝已存在目标、拒绝源/目标
重叠；它不停止进程、不删除旧目录、不覆盖备份。`schema_mismatch` 的首选动作是停机、保留当前目录、
选择匹配版本，绝不直接编辑 SQLite `user_version`。

## 3. 证据包最小目录

```text
<incidentId>/
  commands.txt                 脱敏后的命令和退出码
  profile-audit.json           脚本 stdout（不含秘密）
  capability-response.json     脱敏 body + HTTP status
  desktop-log.txt              只保留相关时间窗
  service-log.txt              只保留相关时间窗
  manifest.sha256.txt         manifest/invalid 文件 hash
  state-inventory.txt         文件名/大小/时间；不复制秘密到工单
  receipt-summary.json         receipt 元数据和 UNKNOWN 判定
  snapshot-summary.json        retentionFloor/highWaterMark/snapshotCursor/complete/truncated
  result.md                    APPLIED/NOT_APPLIED/UNKNOWN、NOT_RUN/NOT_PROVEN/BLOCKED
```

证据包生成后再次扫描 `bearer|token|api[_-]?key|nonce|secret|authorization` 等敏感模式；若命中，
不要上传原包，先脱敏。没有真实跨进程、多客户端、升级/回滚和故障注入记录时，最终状态必须明确写
`NOT_PROVEN`，不能声称真实 E2E 已通过。
