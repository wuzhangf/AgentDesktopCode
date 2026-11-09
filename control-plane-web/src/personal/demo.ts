// PAE P6 个人管理面 — 示例数据 transport（纯展示，不连接真实服务）。
// 用途：P5 服务端并行施工期间按冻结 DTO 渲染页面，验证交互。
// 数据全部为虚构示例；envelope meta.source 恒为 'demo-fixture'，
// App 层据此持续显示「示例数据」横幅，不冒充真实环境（§9 编码授权）。
import {
  PERSONAL_ROUTES,
  type AdaptiveActionDescriptor,
  type ActionTrialReceiptView,
  type PersonalAttentionItem,
  type PersonalEnvelope,
  type PersonalEnvironmentOperation,
  type PersonalMeta,
  type PersonalOperation,
  type PersonalOperationEventsPage,
  type PersonalWorkerView,
  type ProjectEnvironmentView,
  type ReportDescriptor,
  type PersonalProjectView,
  type PersonalOverview,
  type PersonalEnvironmentPlanPreview,
  type PersonalOperationAccepted,
  type PersonalOperationEvent,
  type PersonalReportFile,
} from '../../../codeagent-desktop/packages/protocol/src/personal';
import type { PersonalTransport } from './client';
import { PersonalClientError } from './client';

// 示例面不得自动宣告本次「任务可靠控制」可用：三条控制动作从 supportedActions
// 过滤，落到 transport 的 default 分支按 INVALID_OPERATION 报错（无示例数据）。
const ALL_ACTIONS = (Object.keys(PERSONAL_ROUTES) as PersonalOperation['action'][])
  .filter(a => !['TASK_COMMANDS', 'TASK_COMMAND_CREATE', 'TASK_COMMAND',
    // Stream-control ops belong to the Electron main bridge, not the demo
    // surface — the fixture has no worker-events/1 source to subscribe to.
    'TASK_EVENTS_SUBSCRIBE', 'TASK_EVENTS_UNSUBSCRIBE'].includes(a));

function demoMeta(): PersonalMeta {
  return {
    source: 'demo-fixture',
    instance: 'example',
    controlPlaneId: 'demo-local',
    observedAt: new Date().toISOString(),
    revision: '1',
    supportedActions: [...ALL_ACTIONS],
    reasonCodes: [],
  };
}

function envelope<T>(data: T): PersonalEnvelope<T> {
  return { meta: demoMeta(), data };
}

// ---- 示例状态（内存，仅本会话；幂等按 requestKey 回放） ----

interface DemoOp {
  operationId: string;
  requestKey: string;
  kind: string;
  projectId: string;
  createdAtMs: number;
  canceledAtMs?: number;
}

interface DemoState {
  projects: PersonalProjectView[];
  ops: DemoOp[];
  opSeq: number;
  reports: Map<string, { descriptor: ReportDescriptor; createdAtMs: number }>;
  reportSeq: number;
  savedActions: Map<string, AdaptiveActionDescriptor>;
  /** requestKey → 首次回执（示例幂等回放，语义与冻结写操作一致）。 */
  idempotent: Map<string, PersonalEnvelope<unknown>>;
}

const DEMO_PROJECTS: PersonalProjectView[] = [
  { projectId: 'p-demo-java', projectRef: 'spring-petclinic', displayName: '宠物诊所（示例 Java 项目）', registeredAt: '2026-10-10T02:00:00Z', updatedAt: '2026-10-17T09:30:00Z', revision: '3' },
  { projectId: 'p-demo-web', projectRef: 'storefront-ui', displayName: '门店前端（示例前端项目）', registeredAt: '2026-10-12T08:00:00Z', updatedAt: '2026-10-16T11:00:00Z', revision: '2' },
];

const DEMO_WORKERS: PersonalWorkerView[] = [
  {
    workerId: 'w-demo-local', displayName: '本机 Worker', connectionKind: 'DAEMON', connectionState: 'CONNECTED',
    capabilities: { projectEnvironmentPrepareV1: true, environmentBoundExecutionV1: true, adaptiveActionV1: true },
    supportedCores: ['acs', 'pi', 'codex'], version: '1.4.0', platform: 'win32-x64',
    operatorState: 'READY', revision: '7', observedAt: '2026-10-18T01:00:00Z',
  },
  {
    workerId: 'w-demo-nas', displayName: 'NAS 上的 Worker（外部连接）', connectionKind: 'ACS_DIRECT', connectionState: 'CONNECTED',
    capabilities: { projectEnvironmentPrepareV1: false, environmentBoundExecutionV1: true, adaptiveActionV1: false },
    supportedCores: ['acs'], version: '1.3.2', platform: 'linux-x64',
    revision: '2', observedAt: '2026-10-18T00:50:00Z', reasonCodes: [],
  },
];

const DEMO_ATTENTION: PersonalAttentionItem[] = [
  { kind: 'ENV_MISSING', projectId: 'p-demo-java', reasonCode: 'TOOLCHAIN_MISSING', message: '项目「宠物诊所」缺少 JDK 21', observedAt: '2026-10-18T00:58:00Z' },
  { kind: 'ENV_MISSING', projectId: 'p-demo-java', reasonCode: 'TOOLCHAIN_MISSING', message: '项目「宠物诊所」缺少 JDK 21（来源：.mvn/wrapper）', observedAt: '2026-10-18T00:57:00Z' },
  { kind: 'OPERATION_UNKNOWN', projectId: 'p-demo-web', operationId: 'op-demo-lost', reasonCode: 'EFFECT_UNKNOWN', message: '「门店前端」一次环境准备失去连接，效果未知', observedAt: '2026-10-17T13:12:00Z' },
  { kind: 'TASK_QUESTION', refId: 't-demo-docs', projectId: 'p-demo-java', message: '任务「整理部署文档」等待你确认范围', observedAt: '2026-10-17T10:20:00Z' },
];

const DEMO_ACTIONS: AdaptiveActionDescriptor[] = [
  { actionId: 'a-demo-test', actionVersion: '3', name: '运行项目测试', scope: 'PROJECT', objective: '在项目环境内执行既有测试入口', targetDirectory: '.', interpreter: 'mvnw', provenance: 'SAVED_PROJECT', saved: true, revision: '3' },
  { actionId: 'a-demo-scan', actionVersion: '1', name: '临时：统计接口数量', scope: 'TASK', objective: '生成一次性统计脚本并试跑', targetDirectory: '.', interpreter: 'node', provenance: 'TASK_ADHOC', saved: false, revision: '1' },
];

function demoEnvironment(projectId: string, ops: DemoOp[]): ProjectEnvironmentView {
  const active = ops.filter(o => o.projectId === projectId).at(-1);
  // op-demo-lost 是「失去连接、效果未知」的原操作——环境视图同样显示 UNKNOWN，
  // 不把未知效果投影成就绪。
  const activeState = active
    ? (active.operationId === 'op-demo-lost' ? 'UNKNOWN' : opState(active, Date.now()))
    : null;
  if (projectId === 'p-demo-web') {
    return {
      projectId, environmentId: 'env-demo-web-1', environmentRevision: '4',
      state: activeState ?? 'READY',
      needs: [
        { requirementId: 'rq-w1', kind: 'TOOL', name: 'node', version: '20', source: 'packageManager', detail: 'package.json: pnpm@9 + node>=20' },
        { requirementId: 'rq-w2', kind: 'TOOL', name: 'pnpm', version: '9', source: 'lockfile', detail: 'pnpm-lock.yaml' },
      ],
      have: [
        { factId: 'f-w1', kind: 'TOOL_VERSION', name: 'node', version: '20.11.1', observedAt: '2026-10-17T12:00:00Z' },
        { factId: 'f-w2', kind: 'TOOL_VERSION', name: 'pnpm', version: '9.1.0', observedAt: '2026-10-17T12:00:00Z' },
        { factId: 'f-w3', kind: 'WRITABLE_PATH', name: 'workspace', detailRef: 'fact-w3', observedAt: '2026-10-17T12:00:00Z' },
      ],
      missing: [],
      warnings: [],
      supportedCores: ['acs', 'codex'],
      planDigest: 'sha256:' + 'b'.repeat(64),
      imageDigest: 'sha256:' + 'c'.repeat(64),
      activeOperationId: active?.operationId ?? null,
      observedAt: '2026-10-18T00:50:00Z',
    };
  }
  return {
    projectId,
    environmentId: null,
    environmentRevision: null,
    state: activeState,
    needs: [
      { requirementId: 'rq-j1', kind: 'TOOL', name: 'jdk', version: '21', source: 'mvnw', detail: '.mvn/wrapper + pom.xml 要求 Java 21' },
      { requirementId: 'rq-j2', kind: 'TOOL', name: 'maven', version: 'wrapper', source: 'mvnw', detail: 'wrapper 可用，无需独立安装' },
    ],
    have: [
      { factId: 'f-j1', kind: 'DEPENDENCY_ENTRY', name: 'maven-wrapper', detailRef: 'fact-j1', observedAt: '2026-10-18T00:55:00Z' },
    ],
    missing: [
      { requirementId: 'rq-j1', kind: 'TOOL', name: 'jdk', version: '21', source: 'mvnw', detail: '未找到 JDK 21' },
    ],
    warnings: ['未观察到可复用的既有环境'],
    supportedCores: ['acs'],
    activeOperationId: active?.operationId ?? null,
    observedAt: '2026-10-18T00:55:00Z',
  };
}

function opState(op: DemoOp, nowMs: number): PersonalEnvironmentOperation['state'] {
  if (op.canceledAtMs) return 'CANCELED';
  const elapsed = nowMs - op.createdAtMs;
  if (elapsed < 1500) return 'QUEUED';
  if (elapsed < 6000) return 'RUNNING';
  return 'READY';
}

function opProgress(op: DemoOp, nowMs: number): number | null {
  if (op.canceledAtMs) return null;
  const elapsed = nowMs - op.createdAtMs;
  if (elapsed < 1500) return 0;
  if (elapsed < 6000) return Math.min(0.9, 0.25 + (elapsed - 1500) / 4500 * 0.65);
  return 1;
}

function opView(op: DemoOp, nowMs: number): PersonalEnvironmentOperation {
  return {
    operationId: op.operationId,
    requestKey: op.requestKey,
    kind: op.kind,
    state: opState(op, nowMs),
    projectId: op.projectId,
    environmentId: 'env-demo-web-1',
    revision: '1',
    progress: opProgress(op, nowMs),
    createdAt: new Date(op.createdAtMs).toISOString(),
    updatedAt: new Date(nowMs).toISOString(),
  };
}

function opEvents(op: DemoOp, nowMs: number): PersonalOperationEventsPage {
  const state = opState(op, nowMs);
  const events: PersonalOperationEvent[] = [
    { eventId: `${op.operationId}-e1`, occurredAt: new Date(op.createdAtMs).toISOString(), kind: 'ACCEPTED', state: 'QUEUED' as const, message: `已受理（requestKey 幂等登记）` },
  ];
  if (state === 'RUNNING' || state === 'READY' || state === 'CANCELED') {
    events.push({ eventId: `${op.operationId}-e2`, occurredAt: new Date(op.createdAtMs + 1500).toISOString(), kind: 'PROGRESS', state: 'RUNNING' as const, message: '解析基础镜像摘要并校验工具链' });
  }
  if (state === 'READY') {
    events.push({ eventId: `${op.operationId}-e3`, occurredAt: new Date(op.createdAtMs + 6000).toISOString(), kind: 'READY', state: 'READY' as const, message: '环境就绪，可按原 binding 启动任务' });
  }
  if (state === 'CANCELED') {
    events.push({ eventId: `${op.operationId}-e4`, occurredAt: new Date(op.canceledAtMs ?? nowMs).toISOString(), kind: 'CANCELED', state: 'CANCELED' as const, message: '已取消；仅清理本操作登记的资源' });
  }
  return { events, nextCursor: null };
}

function newDemoState(): DemoState {
  const reports = new Map<string, { descriptor: ReportDescriptor; createdAtMs: number }>();
  reports.set('r-demo-1', {
    descriptor: {
      reportId: 'r-demo-1', requestKey: 'demo-report-key-1', sourceRef: 'spring-petclinic@main',
      sourceVersion: '2026-10-15', reportProfileRef: 'local-source-summary', providerRef: 'local',
      outputFormat: 'markdown', state: 'DONE', resultDigest: 'sha256:' + 'd'.repeat(64),
      createdAt: '2026-10-17T09:00:00Z', updatedAt: '2026-10-17T09:00:20Z',
    },
    createdAtMs: Date.parse('2026-10-17T09:00:00Z'),
  });
  return {
    projects: DEMO_PROJECTS.map(p => ({ ...p })),
    ops: [{
      operationId: 'op-demo-lost', requestKey: 'demo-lost-key', kind: 'PREPARE', projectId: 'p-demo-web',
      createdAtMs: Date.parse('2026-10-17T13:10:00Z'),
    }],
    opSeq: 1,
    reports,
    reportSeq: 1,
    savedActions: new Map(),
    idempotent: new Map(),
  };
}

/**
 * 示例 transport：实现全部 19 条冻结操作的确定性演示行为。
 * - PREPARE 操作按时间推进 QUEUED→RUNNING→READY；取消写 CANCELED；
 * - 相同 requestKey 幂等回放同一 operationId；
 * - op-demo-lost 固定 UNKNOWN（演示效果待核对的恢复路径）；
 * - 报告创建在 ~4s 后转 DONE；试跑回执证据结论 PASS（示例，非真实验证）。
 */
export function createDemoTransport(state: DemoState = newDemoState()): PersonalTransport {
  return async (operation) => {
    switch (operation.action) {
      case 'OVERVIEW': {
        const data: PersonalOverview = {
          projects: state.projects, workers: DEMO_WORKERS, attention: DEMO_ATTENTION,
        };
        return envelope(data) as PersonalEnvelope<unknown>;
      }
      case 'PROJECTS':
        return envelope(state.projects) as PersonalEnvelope<unknown>;
      case 'REGISTER_PROJECT': {
        const seen = state.idempotent.get(operation.key);
        if (seen) return seen;
        const body = operation.body;
        const view: PersonalProjectView = {
          projectId: `p-demo-${state.projects.length + 1}`, projectRef: body.projectRef,
          displayName: body.displayName ?? body.projectRef, registeredAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(), revision: '1',
        };
        state.projects.push(view);
        const env = envelope(view) as PersonalEnvelope<unknown>;
        state.idempotent.set(operation.key, env);
        return env;
      }
      case 'PROJECT': {
        const view = state.projects.find(p => p.projectId === operation.projectId);
        if (!view) throw new PersonalClientError('NOT_FOUND', '项目未登记');
        return envelope(view) as PersonalEnvelope<unknown>;
      }
      case 'PROJECT_ENVIRONMENT':
        return envelope(demoEnvironment(operation.projectId, state.ops)) as PersonalEnvelope<unknown>;
      case 'ENVIRONMENT_PLAN': {
        const preview: PersonalEnvironmentPlanPreview = {
          planId: `plan-demo-${Date.now() % 100000}`,
          planDigest: 'sha256:' + 'e'.repeat(64),
          steps: [
            { stepId: 's1', kind: 'IMAGE', ref: 'registry.example/base:java21', summary: '按声明模板解析基础镜像（示例）' },
            { stepId: 's2', kind: 'TOOLCHAIN', ref: 'jdk@21', summary: '安装 JDK 21（示例）' },
            { stepId: 's3', kind: 'DEPENDENCY', ref: 'mvnw -q -DskipTests dependency:go-offline', summary: '预热项目依赖（示例）' },
          ],
          estimatedDownloadBytes: null,
          estimatedDiskBytes: null,
          missing: demoEnvironment(operation.projectId, state.ops).missing,
          warnings: ['下载与磁盘占用未知——以实际准备结果为准'],
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        };
        return envelope(preview) as PersonalEnvelope<unknown>;
      }
      case 'ENVIRONMENT_OPERATION': {
        const body = operation.body as { requestKey: string; kind: string };
        const existing = state.ops.find(o => o.requestKey === body.requestKey);
        if (existing) {
          const accepted: PersonalOperationAccepted = { operationId: existing.operationId, state: opState(existing, Date.now()) };
          return envelope(accepted) as PersonalEnvelope<unknown>;
        }
        const op: DemoOp = {
          operationId: `op-demo-${++state.opSeq}`, requestKey: body.requestKey, kind: body.kind,
          projectId: operation.projectId, createdAtMs: Date.now(),
        };
        state.ops.push(op);
        return envelope({ operationId: op.operationId, state: 'QUEUED' } satisfies PersonalOperationAccepted) as PersonalEnvelope<unknown>;
      }
      case 'OPERATION': {
        const op = state.ops.find(o => o.operationId === operation.operationId);
        if (!op) throw new PersonalClientError('NOT_FOUND', '未找到该操作（按原 key 查询不重建）');
        // 演示「效果未知」：op-demo-lost 固定 UNKNOWN，事件只到最后可核对点。
        if (op.operationId === 'op-demo-lost') {
          return envelope({ ...opView(op, Date.now()), state: 'UNKNOWN' as const, reasonCode: 'EFFECT_UNKNOWN' as const }) as PersonalEnvelope<unknown>;
        }
        return envelope(opView(op, Date.now())) as PersonalEnvelope<unknown>;
      }
      case 'OPERATION_EVENTS': {
        const op = state.ops.find(o => o.operationId === operation.operationId);
        if (!op) throw new PersonalClientError('NOT_FOUND', '未找到该操作');
        if (op.operationId === 'op-demo-lost') {
          return envelope({
            events: [{ eventId: 'op-demo-lost-e1', occurredAt: '2026-10-17T13:10:00Z', kind: 'ACCEPTED', state: 'QUEUED' as const, message: '已受理；之后连接中断' }],
            nextCursor: null,
          } satisfies PersonalOperationEventsPage) as PersonalEnvelope<unknown>;
        }
        return envelope(opEvents(op, Date.now())) as PersonalEnvelope<unknown>;
      }
      case 'OPERATION_CANCEL': {
        const op = state.ops.find(o => o.operationId === operation.operationId);
        if (!op) throw new PersonalClientError('NOT_FOUND', '未找到该操作');
        if (op.operationId === 'op-demo-lost') throw new PersonalClientError('STATE_CONFLICT', '原操作效果未知，无法在本端取消；请按原 key 核对');
        op.canceledAtMs = Date.now();
        return envelope(opView(op, Date.now())) as PersonalEnvelope<unknown>;
      }
      case 'WORKERS':
        return envelope(DEMO_WORKERS) as PersonalEnvelope<unknown>;
      case 'WORKER': {
        const worker = DEMO_WORKERS.find(w => w.workerId === operation.workerId);
        if (!worker) throw new PersonalClientError('NOT_FOUND', '未找到该 Worker');
        return envelope(worker) as PersonalEnvelope<unknown>;
      }
      case 'TASK_ACTIONS':
        return envelope(DEMO_ACTIONS.map(a => state.savedActions.get(a.actionId) ?? a)) as PersonalEnvelope<unknown>;
      case 'ACTION_RUN': {
        const action = DEMO_ACTIONS.find(a => a.actionId === operation.actionId);
        if (!action) throw new PersonalClientError('NOT_FOUND', '未找到该动作');
        const receipt: ActionTrialReceiptView = {
          trialId: `trial-demo-${Date.now() % 100000}`,
          actionId: operation.actionId,
          planDigest: 'sha256:' + 'f'.repeat(64),
          bindingDigest: 'sha256:' + '0'.repeat(64),
          exitStatus: 0,
          evidenceVerdict: 'PASS',
          outputRefs: ['out-demo-1'],
          reportRefs: [],
          startedAt: new Date(Date.now() - 3000).toISOString(),
          endedAt: new Date().toISOString(),
        };
        return envelope(receipt) as PersonalEnvelope<unknown>;
      }
      case 'ACTION_SAVE': {
        const action = DEMO_ACTIONS.find(a => a.actionId === operation.actionId);
        if (!action) throw new PersonalClientError('NOT_FOUND', '未找到该动作');
        const body = operation.body as { name?: string; scope?: string };
        const saved: AdaptiveActionDescriptor = {
          ...action, name: body.name ?? action.name, scope: body.scope ?? 'PROJECT',
          saved: true, provenance: 'SAVED_PROJECT',
          revision: String(Number(action.revision ?? '1') + 1),
        };
        state.savedActions.set(action.actionId, saved);
        return envelope(saved) as PersonalEnvelope<unknown>;
      }
      case 'REPORTS':
        return envelope([...state.reports.values()].map(r => reportView(r))) as PersonalEnvelope<unknown>;
      case 'REPORT_CREATE': {
        const seen = state.idempotent.get(operation.key);
        if (seen) return seen;
        const body = operation.body;
        const reportId = `r-demo-${++state.reportSeq}`;
        const descriptor: ReportDescriptor = {
          reportId, requestKey: operation.body.requestKey,
          sourceRef: body.sourceRef, sourceVersion: body.sourceVersion ?? null,
          sourceDigest: body.sourceDigest ?? null, reportProfileRef: body.reportProfileRef ?? null,
          providerRef: body.providerRef ?? 'local', outputFormat: body.outputFormat ?? 'markdown',
          state: 'QUEUED', dataScope: body.dataScope, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        state.reports.set(reportId, { descriptor, createdAtMs: Date.now() });
        const env = envelope(descriptor) as PersonalEnvelope<unknown>;
        state.idempotent.set(operation.key, env);
        return env;
      }
      case 'REPORT': {
        const r = state.reports.get(operation.reportId);
        if (!r) throw new PersonalClientError('NOT_FOUND', '未找到该报告');
        return envelope(reportView(r)) as PersonalEnvelope<unknown>;
      }
      case 'REPORT_FILES': {
        const files: PersonalReportFile[] = [
          { fileId: 'f-demo-md', name: 'report.md', mediaType: 'text/markdown', sizeBytes: 4820, digest: 'sha256:' + '1'.repeat(64) },
          { fileId: 'f-demo-json', name: 'report.json', mediaType: 'application/json', sizeBytes: 12240, digest: 'sha256:' + '2'.repeat(64) },
        ];
        return envelope(files) as PersonalEnvelope<unknown>;
      }
      default:
        throw new PersonalClientError('INVALID_OPERATION', '示例 transport 未覆盖该操作');
    }
  };
}

function reportView(r: { descriptor: ReportDescriptor; createdAtMs: number }): ReportDescriptor {
  const elapsed = Date.now() - r.createdAtMs;
  const state = r.descriptor.state === 'DONE' ? 'DONE' : elapsed > 4000 ? 'DONE' : r.descriptor.state;
  return { ...r.descriptor, state, updatedAt: new Date(Math.max(r.createdAtMs + Math.min(elapsed, 4000), r.createdAtMs)).toISOString() };
}
