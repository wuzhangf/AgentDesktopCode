import { Icon } from '../Icon';

/**
 * One status badge for every surface (ui-polish-plan-2026-10 §5.3): icon +
 * short label + tone colour. `busy` spins via the shared icon-loader rule and
 * honours the workbench `data-reduce-motion` switch. Callers keep their
 * existing `data-testid` by passing `testId`.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'off' | 'busy' | 'info';

/** Bridge from the legacy sessionStatus tone names to badge tones. */
export function badgeTone(tone: string): Tone {
  switch (tone) {
    case 'success': return 'ok';
    case 'warning': return 'warn';
    case 'danger': return 'bad';
    case 'info': return 'info';
    default: return 'off';
  }
}

export function StatusBadge(props: {
  tone: Tone;
  label: string;
  title?: string;
  testId?: string;
}): React.JSX.Element {
  return (
    <span
      className={`status-badge tone-${props.tone}`}
      data-testid={props.testId}
      data-tone={props.tone}
      title={props.title}
    >
      {props.tone === 'off' ? <span className="status-badge-ring" aria-hidden="true" />
        : props.tone === 'info' ? <span className="status-badge-dot" aria-hidden="true" />
          : <Icon
              name={props.tone === 'ok' ? 'check' : props.tone === 'warn' ? 'alert' : props.tone === 'bad' ? 'x' : 'loader'}
              size={12}
              className={props.tone === 'busy' ? 'icon-loader' : undefined}
            />}
      <span className="status-badge-label">{props.label}</span>
    </span>
  );
}
