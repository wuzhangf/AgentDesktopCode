# PAE P7 — 源码/数据报告服务入口（`server/management/reports/**`）

任务单 §10 实现。真实 `LocalReportProvider`（有界作业执行器 + 确定性汇总，
非模型语义审查），两类来源适配，请求/结果按原 key 幂等持久化。

## 路由（P0 §4 冻结，本模块不增不减）

| 方法+路径 | handler |
|---|---|
| `GET /api/personal/v1/reports` | `service.listReports`（可选 `?requestKey=&state=&limit=`，server-side 附加过滤） |
| `POST /api/personal/v1/reports` | `service.createReport`（body 白名单=冻结 REPORT_CREATE 键） |
| `GET /api/personal/v1/reports/{id}` | `service.getReport` |
| `GET /api/personal/v1/reports/{id}/files` | `service.listReportFiles` |

响应 `{meta,data}`；错误 `{error:{code,message,retryable,requestId}}`。
`meta.supportedActions` 携带 `REPORT_PROVIDER:<ref>` 广告**已配置** provider；
`meta.reasonCodes` 携带 `REPORT_PROVIDER_NOT_CONFIGURED` 表示存在已声明未配置的
provider（真实状态，不造假）。

## P5 对接（仓储 + 迁移）

- `ReportsRepository` 窄接口见 `ports.mjs` 尾部 typedef。方法可返回值或
  Promise（调用方一律 await）。P5 用 `node:sqlite` `DatabaseSync` 在
  management.db 上实现适配器；表定义见 `ddl.sql`（草案，登记归 P5）。
  记录字段为 camelCase（reportId/createdAt/…），列为 snake_case
  （report_id/created_at/…）；`data_scope_json`/`last_data_scope_json`
  存 `JSON.stringify(array)`（NULL 表示未声明）。
- 语义要求：`report_request.request_key UNIQUE`；`updateReport` 局部更新；
  `listReports` 支持 `limit/requestKey/state` 过滤，按 `created_at DESC`。
- `deps`：`{repository, outputDir, dataDir?, upstreamGateway?, providers?,
  limits?, controlPlaneId?, instance?}`。
  - `upstreamGateway`：P5 用 `createServiceClientGateway(serviceClient)`
    包装现有 ServiceClient 公开读接口（`getProject`/`listProjectDeliveries`/
    `getDelivery`/`getDeliveryChanges`/`getRun`/`getSessionSummary`）。
    未接线时 `project:|delivery:|run:|session:` 来源创建失败
    `REPORT_SOURCE_UNAVAILABLE`（真实未连接）。
  - `providers`：`Record<ref, ReportProvider|null>`，null=已声明未配置。
  - 挂载处必须调一次 `router.reconcile()`（或首个请求自动触发）做重启重核对。

## P8 接入

```js
import { createReportsRouter } from './management/reports/index.mjs';
const reports = createReportsRouter({ repository, outputDir, dataDir, upstreamGateway });
// 在 server 请求循环中：
const r = await reports.handle({ method: req.method, pathname: url.pathname,
  searchParams: url.searchParams, body: parsedJsonOrUndefined });
if (r) send(r.status, r.body); // undefined → 非 reports 路由，继续匹配
```

前端页面 slot：`src/personal/reports/index.ts` 导出 `ReportsPage` 与
`PERSONAL_REPORTS_ROUTE = 'reports'`（建议挂在 `/personal/reports`）。

## 语义约定（P7 局部冻结，ReportDescriptor.state 为开放 string）

- state：`QUEUED|RUNNING|READY|FAILED|UNKNOWN`。
- sourceRef scheme：`data:<name>`（数据目录登记的 .csv/.json，只 basename+
  扩展名、防穿越、有界读取）、`project:|delivery:|run:|session:`（经
  ReportSourceGateway → ServiceClient 公开接口）。
- outputFormat：`markdown+json`（默认）|`markdown`|`json`。
- reportProfileRef：`local/summary`（本版唯一本地 profile）。
- dataScope 已识别 token：`SUMMARY_ONLY`（默认行为）、`SAMPLE_ROWS`（输出含
  有界行样例）、`INCLUDE_SCHEMA`。其他 token 原样记录进报告，不拒绝。
- 报告产物：`<outputDir>/<reportId>/report.md|report.json`（tmp+fsync+rename
  原子写）；`result_digest`=canonical report.json 的 sha256。
- 重启：QUEUED/RUNNING 且 provider `deterministic:true` → 重排执行；否则
  →`UNKNOWN`+`EFFECT_UNKNOWN`（不重复外部效果）。
- 订阅草稿：`report_subscription_draft.enabled` 恒 0（CHECK 约束兜底），
  不创建任何调度/系统任务；UI 显示"未启用"。
- 凭据：合同与持久化只有 ref/digest，无秘密值；不读 env.properties。

## 已知缺口（回 P0 候选）

- 无报告文件内容下载路由（`GET /reports/{id}/files/{fileId}` 类），页面只
  展示文件元数据+digest。
- 无偏好/订阅草稿 HTTP 路由（service 层已持久化，供未来合同补充）。
