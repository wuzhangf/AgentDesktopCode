/**
 * Knowledge page (settings design §6.8).
 *
 * Governance view, not a preference list: PENDING suggestions are always
 * labelled "待确认，不是事实"; confirm is an explicit human action gated by
 * the knowledge.manage capability. There is no Reject button because no
 * Service contract provides one yet — fake affordances are forbidden.
 * Content comes from possibly untrusted sourceRefs and renders as plain text.
 */

import { useMemo, useState } from 'react';
import { EmptyState, SectionError, SettingSection, SkeletonRows, UnavailableState } from '../components';
import { friendlySaveError } from '../settingsPresentation';
import { useConfirmSettingsKnowledge, useSettingsKnowledge, useSuggestKnowledge } from '../useSettingsQueries';
import { operationGateAllows, type SettingsPageContext } from '../settingsContext';

interface KnowledgeItemLike {
  knowledgeId: string;
  status: string;
  content: string;
  sourceRef?: string | null;
}

export function KnowledgePage(props: { context: SettingsPageContext }): React.JSX.Element {
  const knowledge = useSettingsKnowledge();
  const confirm = useConfirmSettingsKnowledge();
  const suggest = useSuggestKnowledge();
  const [filter, setFilter] = useState('');
  const [failedId, setFailedId] = useState<string | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestContent, setSuggestContent] = useState('');
  const [suggestSource, setSuggestSource] = useState('');
  const [suggestError, setSuggestError] = useState<string | null>(null);

  const normalizedFilter = filter.trim().toLowerCase();
  const matches = (item: KnowledgeItemLike): boolean =>
    !normalizedFilter || item.content.toLowerCase().includes(normalizedFilter);

  const pending = useMemo(() => (knowledge.data?.items ?? []).filter((item) => item.status === 'PENDING'), [knowledge.data]);
  const confirmed = useMemo(() => (knowledge.data?.items ?? []).filter((item) => item.status === 'CONFIRMED'), [knowledge.data]);

  if (!operationGateAllows(props.context.capabilities, 'knowledge.manage')) {
    return <UnavailableState title="知识不可用" message="当前 Service 未声明 knowledge.manage 能力；按安全规则不提供确认入口。" reasonCode="UNAVAILABLE" />;
  }
  if (knowledge.isPending) {
    return <SettingSection title="知识" description="建议在确认前不是事实。" hideHeader><SkeletonRows /></SettingSection>;
  }
  if (knowledge.isError || !knowledge.data) {
    const message = knowledge.error instanceof Error ? knowledge.error.message : String(knowledge.error);
    const offline = message.includes('SERVICE_NOT_CONNECTED');
    return offline
      ? <UnavailableState title="知识不可用" message="Service 未连接。知识保存在 Service 中，离线时不显示旧缓存。" reasonCode="SERVICE_NOT_CONNECTED" />
      : <SectionError message={`无法读取知识：${message}`} onRetry={() => void knowledge.refetch()} />;
  }

  return (
    <SettingSection
      title="知识"
      description="待确认建议不会被当作事实；只有你明确确认后才进入事实列表。"
      hideHeader
      testId="knowledge-section"
      actions={(
        <input
          className="settings-filter-input"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="在已加载内容中筛选…"
          aria-label="在已加载内容中筛选"
        />
      )}
    >
      <div className="knowledge-suggest" data-testid="knowledge-suggest">
        <button type="button" className="secondary-button" data-testid="knowledge-suggest-toggle" onClick={() => setSuggestOpen((open) => !open)}>提交建议</button>
        {suggestOpen ? (
          <div className="knowledge-suggest-form">
            <textarea
              value={suggestContent}
              onChange={(event) => setSuggestContent(event.target.value)}
              placeholder="建议内容（提交后进入待确认，需人工确认才成为事实）"
              aria-label="建议内容"
              maxLength={2000}
              rows={3}
              data-testid="knowledge-suggest-content"
            />
            <input
              value={suggestSource}
              onChange={(event) => setSuggestSource(event.target.value)}
              placeholder="来源引用（可选）"
              aria-label="来源引用"
              maxLength={512}
              data-testid="knowledge-suggest-source"
            />
            <button
              type="button"
              className="secondary-button"
              data-testid="knowledge-suggest-submit"
              disabled={suggestContent.trim().length === 0 || suggest.isPending}
              onClick={() => {
                setSuggestError(null);
                suggest.mutate(
                  { content: suggestContent.trim(), sourceRef: suggestSource.trim() || null },
                  {
                    onSuccess: () => { setSuggestContent(''); setSuggestSource(''); setSuggestOpen(false); },
                    onError: (err) => setSuggestError(err instanceof Error ? err.message : String(err))
                  }
                );
              }}
            >{suggest.isPending ? '提交中…' : '提交为待确认'}</button>
            {suggestError ? <SectionError message={friendlySaveError(suggestError)} /> : null}
          </div>
        ) : null}
      </div>
      <div className="knowledge-columns">
        <section className="knowledge-column" aria-label={`待确认建议（${pending.length}）`}>
          <h3>待确认建议（{pending.length}）</h3>
          <ul className="knowledge-list" data-testid="knowledge-list">
            {pending.filter(matches).map((item) => (
              <li key={item.knowledgeId} data-testid={`knowledge-item-PENDING`}>
                <span className="settings-badge knowledge-pending" data-testid={`knowledge-status-${item.knowledgeId}`}>待确认 · 不是事实</span>
                <p className="knowledge-content">{item.content}</p>
                {item.sourceRef ? <span className="run-meta">来源：{item.sourceRef}</span> : null}
                <button
                  type="button"
                  data-testid={`knowledge-confirm-${item.knowledgeId}`}
                  disabled={confirm.isPending}
                  onClick={() => {
                    setFailedId(null);
                    setFailureMessage(null);
                    confirm.mutate(item.knowledgeId, {
                      onError: (err) => {
                        setFailedId(item.knowledgeId);
                        setFailureMessage(err instanceof Error ? err.message : String(err));
                      }
                    });
                  }}
                >
                  {confirm.isPending ? '确认中…' : '确认'}
                </button>
                {failedId === item.knowledgeId && failureMessage ? (
                  <SectionError message={friendlySaveError(failureMessage)} />
                ) : null}
              </li>
            ))}
            {pending.length === 0 ? <li className="settings-empty">没有待确认的建议。</li> : null}
            {pending.length > 0 && pending.filter(matches).length === 0 ? <EmptyState message="没有匹配当前筛选的建议。" /> : null}
          </ul>
        </section>
        <section className="knowledge-column" aria-label={`已确认事实（${confirmed.length}）`}>
          <h3>已确认事实（{confirmed.length}）</h3>
          <ul className="knowledge-list knowledge-facts" data-testid="knowledge-facts-list">
            {confirmed.filter(matches).map((item) => (
              <li key={item.knowledgeId} data-testid={`knowledge-item-CONFIRMED`}>
                <span className="settings-badge knowledge-confirmed">已确认事实</span>
                <p className="knowledge-content">{item.content}</p>
                {item.sourceRef ? <span className="run-meta">来源：{item.sourceRef}</span> : null}
              </li>
            ))}
            {confirmed.length === 0 ? <li className="settings-empty">还没有已确认的事实。</li> : null}
          </ul>
          <span className="run-meta" data-testid="knowledge-facts-count">事实（已确认）：{confirmed.length} 条</span>
        </section>
      </div>
    </SettingSection>
  );
}
