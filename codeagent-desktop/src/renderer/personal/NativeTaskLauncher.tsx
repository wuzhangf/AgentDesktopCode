import {useEffect, useState} from 'react';
import type {AvailableProject, PersonalTaskCreate, PersonalTaskOptions} from '../../../packages/protocol/src/personal-task';
import {supportedNativeProfile, type NativePreflight} from '../../../packages/protocol/src/native-task';
import {validPersonalEnvelope} from '../../../packages/protocol/src/personal';
import {personalCall, readStored, writeStored} from './personalGateway';

const ENGINE_LABELS: Record<string, string> = {pi: 'Pi', codex: 'Codex', macos: 'Mac', codep: 'Codep'};

/** Native task launcher: pick an already-registered project, run the bounded
 * preflight, then create the task through the same requestKey-persisted
 * contract as the diagnostics surface. Also offers source discovery so a
 * task started on another device can be adopted without re-dispatching it. */
export function NativeTaskLauncher({onCreated}: {onCreated: (taskId: string) => void}) {
  const [projects, setProjects] = useState<AvailableProject[]>([]);
  const [sourceId, setSourceId] = useState('');
  const [project, setProject] = useState('');
  const [options, setOptions] = useState<PersonalTaskOptions>();
  const [creationAllowed, setCreationAllowed] = useState(false);
  const [engine, setEngine] = useState<NativePreflight>();
  const [model, setModel] = useState('');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PersonalTaskCreate | undefined>(() => readStored<PersonalTaskCreate>('desktop.personal.create'));
  const [sourceTasks, setSourceTasks] = useState<{localTaskId: string; title: string; state: string}[]>([]);

  const engines = (options?.native?.engines ?? []).filter((value) => supportedNativeProfile(value.engineId, value));
  const canCreate = creationAllowed && !!engine && !(options?.issues.some((value) => value.blocking));

  async function work(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  useEffect(() => {
    void personalCall<AvailableProject[]>({action: 'PROJECTS_AVAILABLE'}).then(setProjects).catch((e) => setError((e as Error).message));
  }, []);

  async function choose(id: string) {
    setSourceTasks([]);
    setSourceId(id); setProject(''); setOptions(undefined); setCreationAllowed(false); setEngine(undefined); setModel('');
    if (!id) return;
    await work(async () => {
      const source = projects.find((value) => value.projectId === id)!;
      const key = 'desktop-register-' + crypto.randomUUID();
      const registered = await personalCall<{projectId: string}>({action: 'REGISTER_PROJECT', key, body: {requestKey: key, projectRef: source.sourceProjectRef ?? id, ...(source.connectionId ? {connectionId: source.connectionId} : {}), ...(source.displayName ? {displayName: source.displayName} : {})}});
      setProject(registered.projectId);
      const response = await window.codeAgentDesktop.personalOperation?.({action: 'TASK_OPTIONS', projectId: registered.projectId});
      if (!validPersonalEnvelope(response)) throw new Error('任务预检响应无效');
      const taskOptions = response.data as PersonalTaskOptions;
      setOptions(taskOptions);
      setCreationAllowed(Array.isArray(response.meta.supportedActions) && response.meta.supportedActions.includes('TASK_CREATE'));
      const first = (taskOptions.native?.engines ?? []).find((value) => supportedNativeProfile(value.engineId, value) && value.engineId !== 'macos')
        ?? (taskOptions.native?.engines ?? []).find((value) => supportedNativeProfile(value.engineId, value));
      setEngine(first);
    });
  }

  async function submit(body: PersonalTaskCreate) {
    await work(async () => {
      const accepted = await personalCall<{taskId: string}>({action: 'TASK_CREATE', key: body.requestKey, body});
      removeStoredCreate();
      onCreated(accepted.taskId);
    });
  }

  async function create() {
    if (!engine || pending) return;
    const body: PersonalTaskCreate = {requestKey: 'desktop-launch-' + crypto.randomUUID(), projectId: project, engineId: engine.engineId, optionsRevision: engine.optionsRevision, instruction, ...(model ? {executionOptions: {model, accessMode: 'WORKSPACE' as const}} : {})};
    writeStored('desktop.personal.create', body); setPending(body);
    await submit(body);
  }

  function removeStoredCreate() {
    localStorage.removeItem('desktop.personal.create');
    setPending(undefined);
  }

  async function discoverOriginals() {
    await work(async () => {
      const result = await personalCall<{items: {localTaskId: string; title: string; state: string}[]}>({action: 'NATIVE_SOURCE_TASKS', projectId: project});
      setSourceTasks(result.items);
    });
  }

  async function adoptOriginal(localTaskId: string) {
    await work(async () => {
      const storageKey = `desktop.personal.adopt.${project}.${localTaskId}`;
      const request = readStored<{requestKey: string; localTaskId: string}>(storageKey) ?? {requestKey: 'desktop-adopt-' + crypto.randomUUID(), localTaskId};
      writeStored(storageKey, request);
      const result = await personalCall<{taskId: string}>({action: 'NATIVE_TASK_ADOPT', projectId: project, key: request.requestKey, body: request});
      onCreated(result.taskId);
    });
  }

  return (
    <div className="native-launcher" data-testid="native-launcher">
      {pending ? (
        <div className="native-pending" role="status" data-testid="native-launch-pending">
          <p title={pending.requestKey}>上次创建请求未确认受理。重试会用同一请求键提交，已受理时返回同一任务。</p>
          <span className="native-pending-actions">
            <button type="button" disabled={busy} onClick={() => void submit(pending)}>重试提交</button>
            <button type="button" disabled={busy} title="仅清除本地记录；若服务端已受理，任务仍显示在『原生任务』列表。" onClick={() => removeStoredCreate()}>清除本地记录</button>
          </span>
        </div>
      ) : null}
      <label>项目
        <select aria-label="原生项目" value={sourceId} disabled={busy || !!pending} onChange={(e) => void choose(e.target.value)}>
          <option value="">选择已登记项目</option>
          {projects.map((value) => <option key={value.projectId} value={value.projectId}>{value.displayName ?? value.workspaceAlias ?? value.projectId}</option>)}
        </select>
      </label>
      {engines.length > 0
        ? <label>来源引擎
            <select aria-label="原生引擎" data-testid="native-engine" value={engine?.engineId ?? ''} disabled={busy || !!pending} onChange={(e) => setEngine(engines.find((value) => value.engineId === e.target.value))}>
              {engines.map((value) => <option key={value.engineId} value={value.engineId}>{ENGINE_LABELS[value.engineId] ?? value.engineId} · {value.engineVersion}</option>)}
            </select>
          </label>
        : null}
      {options?.issues.map((value) => <p key={value.code} role={value.blocking ? 'alert' : 'status'}>{value.code}：{value.message}</p>)}
      {options?.native?.localModels
        ? <label>模型
            <select aria-label="原生模型" value={model} disabled={busy || !!pending} onChange={(e) => setModel(e.target.value)}>
              <option value="">运行时默认模型</option>
              {options.native.localModels.map((item) => <option key={item.id} value={item.id}>{item.displayName}{item.provider ? ' · ' + item.provider : ''}</option>)}
            </select>
          </label>
        : null}
      <label>任务要求
        <textarea aria-label="原生任务要求" data-testid="native-instruction" value={instruction} maxLength={16384} rows={4} disabled={busy || !!pending} onChange={(e) => setInstruction(e.target.value)} />
      </label>
      <button type="button" data-testid="native-create" disabled={busy || !canCreate || !instruction.trim() || !!pending} onClick={() => void create()}>开始原生任务</button>
      {project
        ? <section aria-label="接续其他端任务">
            <button type="button" disabled={busy} onClick={() => void discoverOriginals()}>查找手机和其他端任务</button>
            {sourceTasks.map((t) => (
              <div key={t.localTaskId}><span>{t.title} · {t.state}</span><button type="button" disabled={busy} onClick={() => void adoptOriginal(t.localTaskId)}>接续此任务 {t.localTaskId.slice(-8)}</button></div>
            ))}
          </section>
        : null}
      {error ? <p role="alert" data-testid="native-launch-error">{error}</p> : null}
    </div>
  );
}
