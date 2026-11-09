import {memo, type ReactNode} from 'react';
import {ContentRenderer} from '../ContentRenderer';

/** Presentation only. Source controllers retain history, receipts and execution. */
export const ConversationMessage = memo(function ConversationMessage(props: {
  role: string;
  text?: string;
  children?: ReactNode;
  status?: ReactNode;
  pending?: boolean;
  testId?: string;
}) {
  const user = props.role === 'user';
  return <article className={`message message-flat ${props.role}${props.pending ? ' pending-message' : ''}`} data-testid={props.testId}>
    <span className="role role-glyph" aria-hidden="true">{user ? '›' : '✦'}</span>
    <span className="sr-only">{user ? '你' : props.role === 'assistant' ? '助手' : '来源'}</span>
    {props.children ?? <div className="content"><ContentRenderer text={props.text ?? ''} /></div>}
    {props.status ? <span className="message-status">{props.status}</span> : null}
  </article>;
});
