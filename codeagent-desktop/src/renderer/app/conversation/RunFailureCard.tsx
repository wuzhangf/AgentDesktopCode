import { useState } from 'react';
import {
  decideFailurePresentation,
  type FailureDescriptor,
  type FailurePhase
} from '../../../../packages/protocol/src/failureContract';
import type { RunLike } from '../queries';

type RunFailureCardRun = Pick<RunLike, 'runId' | 'state' | 'failure' | 'terminationCode'>;

const TERMINAL_STATES = new Set([
  'COMPLETED', 'SUCCEEDED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED',
  'INTERRUPTED', 'TIMED_OUT', 'ABORTED', 'TERMINAL'
]);

const PHASE_LABELS: Record<FailurePhase | 'UNKNOWN', string> = {
  ADMISSION: '准入',
  PREPARE: '环境准备',
  REQUEST: '模型请求',
  RECEIVE: '接收响应',
  VALIDATE: '校验响应',
  EXECUTE: '执行工具',
  VERIFY: '验证结果',
  PERSIST: '保存结果',
  PROJECT: '投影结果',
  DELIVER: '交付结果',
  UNKNOWN: '未知阶段'
};

const DOMAIN_LABELS: Record<string, string> = {
  MODEL_AUTH: '模型授权',
  MODEL_RATE_LIMIT: '模型限流',
  MODEL_TRANSPORT: '模型传输',
  MODEL_PROTOCOL: '模型协议',
  CONTEXT: '上下文',
  TOOL_INPUT: '工具输入',
  TOOL_EXECUTION: '工具执行',
  WORKSPACE_SCOPE: '工作区范围',
  PERMISSION: '权限策略',
  BUDGET: '预算',
  VERIFICATION: '验证',
  SERVICE_TRANSPORT: '服务传输',
  CLIENT_PROTOCOL: '客户端协议',
  ENVIRONMENT: '执行环境',
  INTERNAL: '内部服务',
  UNKNOWN: '未分类'
};

function phaseLabel(phase: FailurePhase | 'UNKNOWN'): string {
  return PHASE_LABELS[phase] ?? phase.replaceAll('_', ' ').toLowerCase();
}

function effectLabel(effectState: FailureDescriptor['effectState']): string {
  switch (effectState) {
    case 'NOT_APPLIED': return '失败操作未执行';
    case 'APPLIED': return '失败操作已执行，仍需查看结果';
    case 'UNKNOWN': return '效果未知；该操作可能已执行，请先查看结果';
  }
}

function recoveryLabel(failure: FailureDescriptor, runState: string): string {
  if (runState === 'PAUSED') return '已暂停，可继续运行';
  const terminal = TERMINAL_STATES.has(runState);
  if (terminal) {
    if (failure.recovery.automatic || failure.disposition === 'AUTO_RECOVERING') {
      return '运行已终止，恢复已停止';
    }
    if (failure.disposition === 'USER_ACTION_REQUIRED') {
      return '运行已终止，恢复已停止；需要用户处理';
    }
    if (failure.disposition === 'OPERATOR_ACTION_REQUIRED') {
      return '运行已终止，恢复已停止；需要运维处理';
    }
    return '运行已终止，恢复已停止';
  }
  if (failure.disposition === 'AUTO_RECOVERING' && failure.recovery.automatic) {
    const attempts = failure.recovery.maxAttempts > 0
      ? `第 ${failure.recovery.attemptsUsed}/${failure.recovery.maxAttempts} 次尝试`
      : `已尝试 ${failure.recovery.attemptsUsed} 次`;
    return `系统正在自动处理（${attempts}）`;
  }
  switch (failure.disposition) {
    case 'USER_ACTION_REQUIRED': return '需要用户处理，未自动恢复';
    case 'OPERATOR_ACTION_REQUIRED': return '需要运维处理，未自动恢复';
    case 'TERMINAL': return '恢复已终止';
    case 'AUTO_RECOVERING': return '恢复状态待确认';
    default: return '恢复状态未知，未执行自动恢复';
  }
}

function nextStepFor(failure: FailureDescriptor): string {
  if (failure.effectState !== 'NOT_APPLIED') {
    return '请先查看执行结果和变更，再决定后续处理。';
  }
  switch (failure.code) {
    case 'RESOURCE_BUSY':
    case 'RESOURCE_CAPACITY':
    case 'RESOURCE_NAMESPACE_BUSY':
    case 'RESOURCE_LOCK_UNAVAILABLE':
    case 'WORKSPACE_WRITER_EXISTS':
    case 'WORKSPACE_LOCKED':
    case 'WORKSPACE_LEASE_BUSY':
      return '确认工作区资源已释放后，点击“继续运行”。';
    case 'PATH_OUTSIDE_WORKSPACE':
      return '使用工作区内的相对路径，或通过已有会话设置调整范围后再继续。';
    case 'MODEL_TOOL_ARGUMENTS_INVALID':
      return '查看工具输入详情，修正输入后再发起新一轮处理。';
    case 'MODEL_RESPONSE_INCOMPLETE':
    case 'MODEL_STREAM_TERMINATOR_MISSING':
      return '查看响应详情，确认缺失内容后再发起新一轮处理。';
  }
  switch (failure.domain) {
    case 'MODEL_AUTH':
      return '在「设置 › 模型」检查模型服务授权后重新发起。';
    case 'MODEL_RATE_LIMIT':
      return '模型服务限流，稍后重新发起。';
    case 'PERMISSION':
      return '在权限弹层调整模式，或处理待审批项后继续。';
    default:
      return '查看错误详情和执行结果；当前没有可执行的自动恢复动作。';
  }
}

function contextEntries(failure: FailureDescriptor): Array<[string, string]> {
  const context = failure.context;
  if (!context) return [];
  return [
    ['correlationId', context.correlationId],
    ['providerRequestId', context.providerRequestId],
    ['clientRequestId', context.clientRequestId],
    ['activityId', context.activityId],
    ['toolCallId', context.toolCallId],
    ['toolName', context.toolName],
    ['capabilityId', context.capabilityId],
    ['httpStatus', context.httpStatus == null ? undefined : String(context.httpStatus)],
    ['failureStage', context.failureStage],
    ['pathRef', context.pathRef],
    ['traceRef', context.traceRef]
  ].filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);
}

export function diagnosticText(run: RunFailureCardRun): string {
  const failure = run.failure;
  if (!failure) return `runId: ${run.runId}\nstate: ${run.state}`;
  const lines = [
    `runId: ${run.runId}`,
    `state: ${run.state}`,
    `code: ${failure.code}`,
    `domain: ${failure.domain}`,
    `phase: ${failure.phase}`,
    `disposition: ${failure.disposition}`,
    `effectState: ${failure.effectState}`,
    `safeMessage: ${failure.safeMessage}`,
    `recovery: ${failure.recovery.mode} actor=${failure.recovery.actor} automatic=${failure.recovery.automatic}`,
    `attempts: ${failure.recovery.attemptsUsed}/${failure.recovery.maxAttempts}`
  ];
  if (run.terminationCode) lines.push(`terminationCode: ${run.terminationCode}`);
  for (const [key, value] of contextEntries(failure)) lines.push(`${key}: ${value}`);
  for (const cause of failure.causes) lines.push(`cause: ${cause.code}${cause.message ? ` · ${cause.message}` : ''}`);
  return lines.join('\n');
}

export function RunFailureCard(props: { run: RunFailureCardRun }): React.JSX.Element | null {
  const failure = props.run.failure;
  const [copyState, setCopyState] = useState<string | null>(null);
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  if (!failure) return null;

  const decision = decideFailurePresentation(failure);
  const resourceContention = [
    'RESOURCE_BUSY', 'RESOURCE_CAPACITY', 'RESOURCE_NAMESPACE_BUSY',
    'RESOURCE_LOCK_UNAVAILABLE', 'WORKSPACE_WRITER_EXISTS',
    'WORKSPACE_LOCKED', 'WORKSPACE_LEASE_BUSY'
  ].includes(failure.code);
  const headline = decision.catalogKnown ? decision.headline : '此步骤失败，原因尚未完整分类';
  const tool = failure.context?.toolName ?? failure.context?.capabilityId;
  const toolLabel = tool ?? '未报告工具调用';
  const domainLabel = DOMAIN_LABELS[failure.domain] ?? failure.domain;
  const copy = async (): Promise<void> => {
    const fallback = (message: string): void => {
      setCopyState(message);
      setCopyFallback(diagnosticText(props.run));
    };
    if (!navigator.clipboard?.writeText) {
      fallback('当前环境不支持复制；请从下方文本框手动复制');
      return;
    }
    try {
      await navigator.clipboard.writeText(diagnosticText(props.run));
      setCopyState('已复制');
      setCopyFallback(null);
    } catch {
      fallback('复制失败；请从下方文本框手动复制');
    }
  };

  return (
    <section className="run-failure-card" data-testid="run-failure-card" role="alert">
      <div className="run-failure-card-header">
        <div>
          <span className="eyebrow">{resourceContention && props.run.state === 'PAUSED' ? '资源暂时不可用' : '运行失败'}</span>
          <h2>{headline}</h2>
        </div>
        <span className="badge stale">{props.run.state === 'RUNNING' ? '处理中' : props.run.state === 'PAUSED' ? '已暂停' : '已停止'}</span>
      </div>
      <dl className="run-failure-facts">
        <div><dt>阶段</dt><dd>{phaseLabel(failure.phase)}{failure.context?.failureStage ? ` · ${failure.context.failureStage}` : ''}</dd></div>
        <div><dt>工具</dt><dd>{toolLabel}</dd></div>
        <div><dt>失败原因</dt><dd>{failure.safeMessage || '未返回可展示的错误输出'} <span className="run-meta">（{domainLabel}）</span></dd></div>
        <div><dt>效果</dt><dd>{effectLabel(failure.effectState)}</dd></div>
        <div><dt>恢复</dt><dd>{recoveryLabel(failure, props.run.state)}</dd></div>
        <div><dt>下一步</dt><dd>{nextStepFor(failure)}</dd></div>
      </dl>
      <details className="run-failure-details">
        <summary>展开详情</summary>
        <dl className="run-failure-technical">
          <div><dt>错误码</dt><dd><code>{failure.code}</code></dd></div>
          <div><dt>Run</dt><dd><code>{props.run.runId}</code></dd></div>
          {props.run.terminationCode ? <div><dt>终止码</dt><dd><code>{props.run.terminationCode}</code></dd></div> : null}
          <div><dt>恢复指令</dt><dd><code>{failure.recovery.mode}</code> · {failure.recovery.attemptsUsed}/{failure.recovery.maxAttempts}</dd></div>
          {contextEntries(failure).map(([key, value]) => <div key={key}><dt>{key}</dt><dd><code>{value}</code></dd></div>)}
          {failure.causes.map((cause, index) => <div key={`${cause.code}-${index}`}><dt>原因码</dt><dd><code>{cause.code}</code>{cause.message ? ` · ${cause.message}` : ''}</dd></div>)}
        </dl>
      </details>
      <div className="run-failure-actions">
        <button type="button" onClick={() => void copy()}>复制诊断</button>
        {copyState ? <span className="run-meta" role="status">{copyState}</span> : null}
      </div>
      {copyFallback ? (
        <textarea
          className="run-failure-copy-fallback"
          data-testid="run-failure-copy-fallback"
          readOnly
          value={copyFallback}
          rows={8}
          onFocus={(event) => event.target.select()}
          aria-label="诊断信息（手动复制）"
        />
      ) : null}
    </section>
  );
}
