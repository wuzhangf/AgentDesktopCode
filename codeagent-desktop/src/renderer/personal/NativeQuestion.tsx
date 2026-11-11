import {useState} from 'react';
import type {NativeInputRequest} from '../../../packages/protocol/src/native-task';
import {Icon} from '../app/Icon';

const OPTION_LABELS: Record<string, string> = {accept: '批准', decline: '拒绝', cancel: '取消', acceptForSession: '批准本会话'};

/** One pending native input request (approval, confirm, option pick or free
 * text). Unsupported methods stay disabled rather than fabricating an answer
 * channel the source does not offer. */
export function NativeQuestion({question: q, disabled, answer}: {
  question: NativeInputRequest;
  disabled: boolean;
  answer: (response: {value?: string; confirmed?: boolean; decision?: string}) => void;
}) {
  const [value, setValue] = useState('');
  const approval = q.method.endsWith('requestApproval');
  const supported = ['confirm', 'select', 'input', 'editor'].includes(q.method) || approval;
  return (
    <fieldset className="approval-card native-question" data-testid={'native-question-' + q.inputRequestId} disabled={disabled || !supported}>
      <legend className="sr-only">{q.title || '来源需要你的处理'}</legend>
      <div className="approval-heading"><span className="approval-icon"><Icon name={approval ? 'shield' : 'chat'} size={14} /></span><div><strong>{q.title || '来源需要你的处理'}</strong><span>{approval ? '授权请求' : '待回答问题'}</span></div></div>
      {q.scope ? <dl className="native-question-scope">{Object.entries(q.scope).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl> : null}
      <div className="approval-actions">
      {q.method === 'confirm'
        ? <><button type="button" onClick={() => answer({confirmed: true})}>确认</button><button type="button" onClick={() => answer({confirmed: false})}>拒绝</button></>
        : q.options?.length
          ? q.options.map((option) => <button type="button" key={option} onClick={() => answer(approval ? {decision: option} : {value: option})}>{approval ? OPTION_LABELS[option] ?? option : option}</button>)
          : !approval && supported
            ? <><input aria-label="原生问题回答" value={value} onChange={(e) => setValue(e.target.value)} /><button type="button" onClick={() => answer({value})}>提交回答</button></>
            : <p>此问题需要来源提供受支持的选项。</p>}
      </div>
    </fieldset>
  );
}
