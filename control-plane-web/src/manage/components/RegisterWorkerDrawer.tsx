// 接入 Worker drawer: MANAGED (install from releaseRoot, console owns the
// process) or EXTERNAL (health-observe only). Submits POST /workers/register,
// then the caller navigates to the new worker's detail page.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Drawer } from '../../components/ui/Drawer';
import { Banner } from '../../components/ui/primitives';
import { managePost, useManage, workerKeyOf, ManageApiError } from '../api';
import type { ConsoleSettings, RegisterWorkerRequest } from '../../../shared/management/api';

const PROVIDERS: { id: string; note: string }[] = [
  { id: 'fixture', note: '本机测试提供者，无真实模型' },
  { id: 'agentcode', note: 'AgentCode 引擎' },
  { id: 'codex', note: 'Codex 引擎' },
  { id: 'pi', note: 'Pi 引擎' },
];

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-secondary)' };

export function RegisterWorkerDrawer({ open, onClose, onRegistered }: {
  open: boolean;
  onClose: () => void;
  onRegistered: (workerKey: string | null) => void;
}) {
  const settingsQ = useManage<ConsoleSettings>(['settings'], open ? '/settings' : null);
  const settings = settingsQ.data;
  const [kind, setKind] = useState<'MANAGED' | 'EXTERNAL'>('MANAGED');
  const [name, setName] = useState('');
  const [workerId, setWorkerId] = useState('');
  const [provider, setProvider] = useState('');   // '' = 待默认/未选择
  const providerTouched = useRef(false);
  const [healthUrl, setHealthUrl] = useState('http://127.0.0.1:8081');
  const [stateDir, setStateDir] = useState('');
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // Seed the editable workerId once per open edge — a late-arriving settings
  // response must NOT overwrite what the user already typed.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    setWorkerId(`worker-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`);
    providerTouched.current = false;      // re-seed provider from settings on reopen
    setProvider('');
  }, [open]);
  // defaultProvider applies only while the user hasn't picked an engine.
  useEffect(() => {
    if (open && !providerTouched.current && settings?.defaultProvider) setProvider(settings.defaultProvider);
  }, [open, settings?.defaultProvider]);

  const valid = name.trim().length > 0 && (kind === 'MANAGED'
    ? workerId.trim().length > 0 && provider.length > 0
    : /^https?:\/\//.test(healthUrl.trim()));

  async function submit() {
    setErr(null);
    if (!name.trim()) return setErr({ message: '请填写 Worker 名称' });
    if (kind === 'MANAGED' && !workerId.trim()) return setErr({ message: '请填写 workerId（daemon 使用的稳定部署名）' });
    if (kind === 'EXTERNAL' && !/^https?:\/\//.test(healthUrl.trim())) {
      return setErr({ message: 'healthUrl 需为 http(s) loopback 地址，如 http://127.0.0.1:8081' });
    }
    const body: RegisterWorkerRequest = kind === 'MANAGED'
      ? { kind: 'MANAGED', name: name.trim(), workerId: workerId.trim(), provider }
      : { kind: 'EXTERNAL', name: name.trim(), healthUrl: healthUrl.trim(), ...(stateDir.trim() ? { stateDir: stateDir.trim() } : {}) };
    setBusy(true);
    try {
      const r = await managePost<unknown>('/workers/register', body);
      onRegistered(workerKeyOf(r));
    } catch (e) {
      setErr(e instanceof ManageApiError ? { message: e.message, code: e.code } : { message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="接入 Worker">
      <div className="col" style={{ gap: 14 }}>
        <div className="row" style={{ gap: 14, fontSize: 12, color: 'var(--text-secondary)' }}>
          <label className="row" style={{ gap: 5 }}>
            <input type="radio" checked={kind === 'MANAGED'} onChange={() => setKind('MANAGED')} /> 安装并由我管理
          </label>
          <label className="row" style={{ gap: 5 }}>
            <input type="radio" checked={kind === 'EXTERNAL'} onChange={() => setKind('EXTERNAL')} /> 连接已有 Worker
          </label>
        </div>

        <label style={field}>名称
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：本机开发 Worker" />
        </label>

        {kind === 'MANAGED' ? (
          <>
            <label style={field}>workerId（daemon 稳定部署名）
              <input className="mono" value={workerId} onChange={(e) => setWorkerId(e.target.value)} />
            </label>
            <label style={field}>执行引擎 provider
              <select value={provider} onChange={(e) => { providerTouched.current = true; setProvider(e.target.value); }}>
                {provider === '' && <option value="">读取默认中…</option>}
                {PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
              </select>
              <span className="muted">{PROVIDERS.find((p) => p.id === provider)?.note}</span>
            </label>
            <div style={{ fontSize: 12 }}>
              安装目录 releaseRoot：{settings?.releaseRoot
                ? <span className="mono">{settings.releaseRoot}</span>
                : settingsQ.isPending ? '读取中…' : <span className="muted">未配置</span>}
            </div>
            {settings && !settings.releaseRoot && (
              <Banner kind="info">尚未配置 releaseRoot，无法在本机安装 Worker。请先到<Link to="/manage/settings" onClick={onClose}>设置</Link>填写发行目录。</Banner>
            )}
          </>
        ) : (
          <>
            <label style={field}>healthUrl（daemon 健康服务地址）
              <input className="mono" value={healthUrl} onChange={(e) => setHealthUrl(e.target.value)} placeholder="http://127.0.0.1:8081" />
            </label>
            <label style={field}>stateDir（可选，本地 journal 目录）
              <input className="mono" value={stateDir} onChange={(e) => setStateDir(e.target.value)} placeholder="留空则无 journal 读取" />
            </label>
            <div className="muted" style={{ fontSize: 11.5 }}>
              外部连接仅提供健康观测与只读 journal — 不包含进程启动/停止与 install-gate 控制权。
            </div>
          </>
        )}

        {err && <Banner kind="error">{err.message}{err.code ? `（${err.code}）` : ''}</Banner>}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={!valid || busy} onClick={submit}>
            {busy ? '登记中…' : '登记并检查连接'}
          </button>
        </div>
      </div>
    </Drawer>
  );
}
