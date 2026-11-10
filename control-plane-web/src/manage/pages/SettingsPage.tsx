// 设置: releaseRoot / defaultProvider / ACS 连接(仅存环境变量名) /
// 观测 API 地址 — GET/PUT /settings，POST /settings/check-install。
import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import { Badge, Banner, Card, ErrorBanner, KV, Skeleton } from '../../components/ui/primitives';
import { managePost, managePut, useInvalidateManage, useManage, ManageApiError } from '../api';
import type { AcsConnection, ConsoleSettings, InstallCheck } from '../../../shared/management/api';
import { fmtIso, relTime } from '../labels';

const PROVIDERS = ['fixture', 'agentcode', 'codex', 'pi'];
const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' };

interface FormState {
  releaseRoot: string;
  defaultProvider: string;
  acsConnections: AcsConnection[];
  obsApiUrl: string;
}

const toForm = (s: ConsoleSettings): FormState => ({
  releaseRoot: s.releaseRoot ?? '',
  defaultProvider: s.defaultProvider,
  acsConnections: s.acsConnections.map((c) => ({ ...c })),
  obsApiUrl: s.obsApiUrl ?? '',
});

export default function SettingsPage() {
  const q = useManage<ConsoleSettings>(['settings'], '/settings');
  const invalidate = useInvalidateManage();
  const [form, setForm] = useState<FormState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<{ message: string; code?: string } | null>(null);
  const [check, setCheck] = useState<{ data: InstallCheck | null; err: string | null; busy: boolean }>({ data: null, err: null, busy: false });

  // Refill only when a NEW server snapshot arrives — after a successful save
  // the cached q.data is still the pre-save object and must not overwrite form.
  const syncedData = useRef<ConsoleSettings | null>(null);
  useEffect(() => {
    if (!q.data || dirty || q.data === syncedData.current) return;
    syncedData.current = q.data;
    setForm(toForm(q.data));
  }, [q.data, dirty]);

  const patch = (p: Partial<FormState>) => { setForm((f) => (f ? { ...f, ...p } : f)); setDirty(true); };

  async function save() {
    if (!form) return;
    setSaveErr(null);
    const acs = form.acsConnections
      .map((c) => ({ name: c.name.trim(), baseUrl: c.baseUrl.trim(), tokenEnv: c.tokenEnv.trim() }))
      .filter((c) => c.name || c.baseUrl || c.tokenEnv);
    if (acs.some((c) => !c.name || !c.baseUrl || !c.tokenEnv)) {
      setSaveErr({ message: 'ACS 连接行不完整：名称、baseUrl、环境变量名三者都需要（或整行删除）' });
      return;
    }
    const body: ConsoleSettings = {
      releaseRoot: form.releaseRoot.trim() || null,
      defaultProvider: form.defaultProvider,
      acsConnections: acs,
      obsApiUrl: form.obsApiUrl.trim() || null,
    };
    try {
      const saved = await managePut<ConsoleSettings>('/settings', body);
      setForm(toForm(saved));   // server truth wins — never refill from the stale cache
      setDirty(false);
      setSavedAt(new Date().toISOString());
      invalidate();
    } catch (e) {
      setSaveErr(e instanceof ManageApiError ? { message: e.message, code: e.code } : { message: (e as Error).message });
    }
  }

  async function checkInstall() {
    setCheck({ data: null, err: null, busy: true });
    try {
      const data = await managePost<InstallCheck>('/settings/check-install', {
        releaseRoot: (form?.releaseRoot ?? '').trim() || null,
      });
      setCheck({ data, err: null, busy: false });
    } catch (e) {
      setCheck({ data: null, err: (e as Error).message, busy: false });
    }
  }

  if (q.isPending) return <div className="col"><Skeleton h={140} /><Skeleton h={240} /></div>;
  if (q.isError) return <ErrorBanner error={q.error} onRetry={() => q.refetch()} />;
  if (!form) return null;

  const providers = PROVIDERS.includes(form.defaultProvider) ? PROVIDERS : [form.defaultProvider, ...PROVIDERS];

  return (
    <div className="col" style={{ gap: 16, maxWidth: 760 }}>
      <div className="row">
        <h1 className="page-title">设置</h1>
        <span className="muted right" style={{ fontSize: 12 }}>
          {dirty ? '有未保存修改' : savedAt ? `已保存 · ${relTime(savedAt)}` : '与服务器一致'}
        </span>
        <button className="primary" disabled={!dirty} onClick={save}>保存</button>
      </div>
      {saveErr && <Banner kind="error">{saveErr.message}{saveErr.code ? `（${saveErr.code}）` : ''}</Banner>}

      <Card title="Worker 发行目录" sub="受管 Worker 从该 release tree 安装启动">
        <div className="row" style={{ gap: 8 }}>
          <input className="mono grow" value={form.releaseRoot} placeholder="如 D:\agent-release"
            onChange={(e) => patch({ releaseRoot: e.target.value })} />
          <button className="row" style={{ gap: 6 }} disabled={check.busy} onClick={checkInstall}>
            {check.busy ? '检查中…' : '检查安装'}
          </button>
        </div>
        {check.err && <Banner kind="error">检查失败：{check.err}</Banner>}
        {check.data && (
          <div style={{ marginTop: 10 }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <Badge tone={check.data.ok ? 'success' : 'failure'}>{check.data.ok ? '安装检查通过' : '安装检查未通过'}</Badge>
              <span className="muted" style={{ fontSize: 11 }}>{fmtIso(check.data.checkedAt)} · releaseRoot {check.data.releaseRoot ?? '未配置'}</span>
            </div>
            <div className="col" style={{ gap: 4 }}>
              {check.data.findings.map((f, i) => (
                <div key={i} className="row" style={{ gap: 8, fontSize: 12 }}>
                  {f.ok ? <CheckCircle2 size={14} color="var(--success)" /> : <XCircle size={14} color="var(--failure)" />}
                  <b>{f.item}</b>
                  <span className="muted">{f.detail}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="默认引擎" sub="新接入受管 Worker 的默认 provider">
        <select value={form.defaultProvider} onChange={(e) => patch({ defaultProvider: e.target.value })}>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </Card>

      <Card title="ACS 连接" sub="只保存环境变量名 — token 值仅存本机环境变量目录，不落库不传输"
        right={<button className="row" style={{ gap: 4 }} onClick={() => patch({ acsConnections: [...form.acsConnections, { name: '', baseUrl: '', tokenEnv: '' }] })}><Plus size={13} /> 添加</button>}>
        {form.acsConnections.length === 0 && <div className="muted" style={{ fontSize: 12 }}>未配置 ACS 连接。</div>}
        <div className="col" style={{ gap: 8 }}>
          {form.acsConnections.map((c, i) => (
            <div key={i} className="row" style={{ gap: 8 }} data-testid="settings-acs-row">
              <input style={{ width: 140 }} placeholder="名称" value={c.name}
                onChange={(e) => patch({ acsConnections: form.acsConnections.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
              <input className="mono grow" placeholder="baseUrl（loopback）" value={c.baseUrl}
                onChange={(e) => patch({ acsConnections: form.acsConnections.map((x, j) => (j === i ? { ...x, baseUrl: e.target.value } : x)) })} />
              <input className="mono" style={{ width: 200 }} placeholder="环境变量名（值仅存本机环境变量目录）" value={c.tokenEnv}
                onChange={(e) => patch({ acsConnections: form.acsConnections.map((x, j) => (j === i ? { ...x, tokenEnv: e.target.value } : x)) })} />
              <button className="ghost" aria-label="删除" onClick={() => patch({ acsConnections: form.acsConnections.filter((_, j) => j !== i) })}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card title="观测 API" sub="分析页 /api/v2 代理目标；留空使用默认 8788">
        <input className="mono" style={{ width: 320 }} value={form.obsApiUrl} placeholder="http://127.0.0.1:8788"
          onChange={(e) => patch({ obsApiUrl: e.target.value })} />
      </Card>

      {q.data && <KV items={[['当前服务器值', <span className="mono muted" style={{ fontSize: 11 }}>{`releaseRoot=${q.data.releaseRoot ?? 'null'} · provider=${q.data.defaultProvider} · acs=${q.data.acsConnections.length} 条 · obsApi=${q.data.obsApiUrl ?? '默认'}`}</span>]]} />}
    </div>
  );
}
