# Agent Operations Console (control-plane-web)

## Worker Lab 本机体验页

入口 `/worker.html` 消费 Desktop 的公开合同、ServiceClient 和协作面板，覆盖主会话控制、冻结快照、旁路问答、边界建议、画像接管以及隔离写候选、预览和显式采纳。

在本目录运行：

```powershell
powershell.exe -NoProfile -File .\scripts\start-worker-lab.ps1
```

打开 `http://127.0.0.1:8796/worker.html`，点击“连接本机 Host”和“创建 / 打开体验任务”。默认从中央环境读取 OpenCode 的 `MODEL_BASE_URL`、`MODEL_NAME` 和 `MODEL_API_KEY`，运行 `demo-springboot-crud` 的独立克隆，预填员工计数接口与回归测试场景。页面会明确显示真实模型名称。原项目与并行施工目录不作为写入目标。

1. 等待项目初始化完成，在“可写协作”创建计划、确认范围和预算、授权并开始。
2. 点击“推进一步”让主任务到达冻结边界。子任务使用真实模型独立产出候选；预览不会修改主目录。
3. 选择候选、固定选择、创建预览并明确采纳。主任务暂停时，采纳同样会执行真实 Maven 验证并提交 V6 上下文。
4. 在“旁路与接管”冻结材料、独立提问、明确发送建议或切换 reviewer。暂停/恢复/接管均持续查询原回执；手动步进模式下，需要“推进一步”让等待中的主模型返回并到达控制边界。
5. “允许主任务连续执行”释放后续主模型响应。每次启动最多转发 48 个 HTTP 请求，每次输出最多 4096 tokens；任务终态后可创建下一次隔离任务。“第二端打开”提供独立标签页注册。

脚本支持 `-Port`、`-SkipBuild`、`-RealProject`、`-ModelProvider Central`；`-ProtocolModel` 使用不调用外部模型的 x.txt 协议样例。当前预填业务场景针对 `demo-springboot-crud`。Ctrl+C 关闭当前启动器创建的服务。所有服务只监听 loopback；密钥仅经中央环境、内存和私有进程管道传递。

运行输入为封存 `.7` Host/Product/Worker JAR 加独立的本地修正 JAR，启动时核对发行 manifest、修正包哈希及实际 Daemon 回归 PASS。不会覆盖封存发行物，也不把本地修正标为正式发行。修正源码位于独立 `worker-live-e2e-*` 工作区。

重建修正包（先编译 Worker 回归测试）：

```powershell
mvn -B -ntp -o '-Dmaven.repo.local=D:/project/workspace/.worktrees/worker-phase3-acs/.local/r7/m2' -f D:/project/workspace/.worktrees/worker-live-e2e-worker/pom.xml -pl agent-worker-core -am '-Dtest=GitEvidenceBaselineTest' '-Dsurefire.failIfNoSpecifiedTests=false' test
python scripts/worker-regression.py --release-root D:/project/workspace/.worktrees/worker-phase3-acs/.local/r7 --worker-root D:/project/workspace/.worktrees/worker-live-e2e-worker --acs-root D:/project/workspace/AgentCodeService --runtime-patch-source D:/project/workspace/.worktrees/worker-live-e2e-acs --product-patch-source D:/project/workspace/.worktrees/worker-live-e2e-products --out .local/worker-live-e2e/regression-final
```

启动后，使用启动器打印的本次目录保存真实 E2E 证据：

```powershell
python scripts/worker-e2e.py --url http://127.0.0.1:8796 --out .local/worker-live-e2e/<本次run目录>/evidence.json
```

该测试沿真实 demo-control → daemon → provider → ACS → Product 执行；检查精确 Worker 绑定、PAUSE/RESUME 回执、冻结快照、真实模型候选、采纳前后文件隔离、实际 Maven 验证、独立隐藏验收、打包后的 HTTP 接口、真实旁路回答、同 Run 画像接管、显式边界建议、主任务终态及 Worker 交付。原始模型响应、哈希、测试和应用日志只保留在忽略的 `.local/`。

连接已有 ACS：通过中央环境加载 `WORKER_CONTROL_API_URL`、`WORKER_CONTROL_API_TOKEN`，运行 `npm run worker:build` 和 `npm run worker:serve`。此模式不提供本地样例的推进按钮，能力以目标会话为准。原只读分析台保持独立入口。

React + TypeScript + ECharts operations console over the existing SQLite
observation store. All reads go through a local read-only Node API
(`server/`, `/api/v2`); the observation database is never modified and
registration semantics are unchanged.

Design: `../../docs/2026-09-19-react-agent-operations-control-plane-detailed-design.md`

## Commands

```bash
pnpm install
pnpm dev:all          # API (:8788) + Vite dev server (:5180)
pnpm dev:server       # API only; also serves dist/ when built
pnpm dev              # Vite only (proxies /api -> :8788)
pnpm build            # production build -> dist/
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run (server metric/lib fixture tests)
pnpm check-source     # baseline audit of configured observation DBs
pnpm generate-demo    # rebuild demo-data/agent-operations-demo.db
```

## 个人管理台 E2E（L1）

`tests/e2e/` 是 Playwright 端到端套件：真浏览器 × 进程内管理 BFF × node 假守护进程。
不需要 java、不需要封存发行树，也不读写 `.local/personal-console/`。

```bash
pnpm build                    # 必跑：fixture 打的是 dist 构建产物，不是 dev server
pnpm e2e:install              # 首次：安装 chromium（内网用 PLAYWRIGHT_DOWNLOAD_HOST）
pnpm e2e                      # 全部用例
pnpm e2e --grep "E2E-UI-04"   # 按用例 ID 过滤
pnpm e2e:report               # 打开上次的 HTML 报告
```

- 每个用例一个 `mkdtemp` 状态根 + 随机端口（`tests/e2e/fixtures/console.ts`），可并行；
  默认 4 workers，`PW_WORKERS` 可覆盖（受管探测每次要起 PowerShell 查命令行，机器弱时下调）。
- 受管 Worker 经 `lifecycleDeps.planSpawn` 注入 `tests/e2e/fixtures/bin/fake-daemon.mjs`；
  它的 `POST /__ctl` 可在运行中翻转 `ready/draining/attemptId`（封装在 `fixtures/seed.ts` 的 `setStub`）。
- 用例标题带 `E2E-UI-NNN`；API 矩阵在 `tests/management-api.test.ts`，随 `pnpm test` 跑（vitest）。
- trace/video/report 落在 `.local/`（已 gitignore）。fixture 起服务前会校验 `dist/index.html` 存在。

## Data sources

Configured in `server/config/sources.mjs` — clients select by alias only,
arbitrary paths are never accepted:

| alias               | mode     | path                                   |
|---------------------|----------|----------------------------------------|
| `specified-snapshot` (default) | SNAPSHOT | `data/observations.db`          |
| `local-state`       | LIVE     | live observation DB (polled; pauses when tab hidden) |
| `demo`              | DEMO     | `demo-data/agent-operations-demo.db` (generated, clearly synthetic) |
| GUI sessions        | —        | `data/gui-sessions.db`                 |

`SNAPSHOT` treats the file as immutable; `LIVE` re-reads and carries
`dataAsOf`; `DEMO` marks every response `mode: "DEMO"` and CSV exports carry
a `# DEMO DATA` banner.

## API

`/api/v2` — see `server/routes/index.mjs`. Highlights:

- `meta/sources` `meta/capabilities` `meta/dimensions`
- `analytics/overview|models|context|tools|efficiency|quality|collaboration`
- `runs`, `tasks/:id`, `runs/:id/summary|timeline|facts`
- `model-attempts`, `model-attempts/:id`
- `entities`, `events`, `events/:id`, `issues`, `artifacts/:id`, `sessions`
- `exports/analytics.csv?metricId=runs.created|models.attempts|tools.table`

Every response carries a `meta` envelope (apiVersion, metricVersion,
sourceEpoch, mode, scope, schemaVersion, snapshotId, dataAsOf, window,
filtersApplied, warnings, queryDurationMs). Metrics distinguish
`AVAILABLE` / `PARTIAL` / `UNAVAILABLE` / `UNSUPPORTED`, keep `null`
unknowns separate from zero, and expose coverage + reason codes.

## Layout

```
server/    Node read-only API (worker threads, short transactions)
  config/    source whitelist, authority policies
  db/        read-only sqlite, worker pool
  lib/       validation, cursors, buckets, csv, dto, errors
  metrics/   cohorts, duration, cost, usage, hierarchy semantics
  repositories/  v1 schema queries
  routes/    route table
shared/contracts/  enums + DTO types shared with the frontend
src/       React app (TanStack Query, React Router, ECharts, Motion)
scripts/   check-source, generate-demo, dev-all
tests/     vitest fixture tests for metric/lib semantics
```

## Notes

- Windows shell: use `./node_modules/.bin/vitest run` if `npx`/`pnpm exec`
  resolves through WSL.
- Demo DB is generated (`pnpm generate-demo`) and git-ignored.
- Host allow-list: the API only answers `localhost/127.0.0.1/[::1]`.
