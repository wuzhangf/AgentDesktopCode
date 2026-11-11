const fs = require('fs'), path = require('path'), http = require('http'), net = require('net'), crypto = require('crypto');
const budgetRoot=path.resolve(__dirname,'../../..');
const budget=require('./windows-test-budget.cjs').acquire(budgetRoot,process.env.PC_E2E_MODE??'control',process.env.PC_MODEL_FIXTURE==='1');
process.once('exit',()=>budget.release());
const {captureEvidence}=require('./windows-ui-evidence.cjs');
const {B,bounded,observeRead,atomicJson,fileDigest,fingerprint,identity,stopOwned,terminateIdentity,ownedDescendants,serialSampler,qualify,checkClockGap}=require('./windows-verification-runtime.cjs');
const {startModelFixture}=require('./windows-model-fixture.cjs');
const { spawn, execFileSync } = require('child_process'), { createRequire } = require('module');
const root = path.resolve(__dirname, '../../..'), appRoot = path.join(root, 'apps/codeagent-desktop'), web = path.join(root, 'apps/control-plane-web');
const req = createRequire(path.join(appRoot, 'package.json')), { _electron, expect } = createRequire(path.join(web, 'package.json'))('@playwright/test');
const hostExe = process.env.PC_CODEX_HOST, pinned = process.env.PC_CODEX_PIN;
if (!hostExe || !pinned)
    throw Error('EXPLICIT_PINNED_BINARIES_REQUIRED');
const out = path.resolve(process.env.PC_E2E_OUTPUT ?? path.join(budget.scope, 'case-' + Date.now()));
if(!out.startsWith(budget.scope+path.sep))throw Error('TEST_OUTPUT_OUTSIDE_BOUNDED_SCOPE');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.mkdirSync(out);
budget.check();
if (!['control', 'faults', 'soak','transport-fault'].includes(process.env.PC_E2E_MODE ?? 'control'))
    throw Error('INVALID_MODE');
const report = { result: 'RUNNING', out, model: process.env.MODEL_DEFAULT_MODEL, steps: [], approvals: [], saveDialog: 'instrumented-path-only', sourceBuild: process.env.PC_CODEX_BUILD };
const state = path.join(out, 'state'), project = path.join(out, 'source'), token = crypto.randomBytes(32).toString('hex');
let host, gateway, app, proxy, hostUrl, gatePort, page, proxyPort, drop = false;
let hostIdentity,gatewayIdentity,appIdentity,appLauncherIdentity,modelFixture,sampler,sampleError;
let restarting=false;
let previousClock;
const fixtureMode=process.env.PC_MODEL_FIXTURE==='1';
const runtime=fingerprint(root,hostExe,pinned);report.runtimeDigest=runtime.digest;report.timeouts=B;report.modelKind=fixtureMode?'LOCAL_RESPONSES_FIXTURE':'LIVE_MODEL';
const seen = [];
const writes = []; let requestCount = 0;
report.node = process.version;
report.resourcePolicy=budget.policy;
report.resourceScope=budget.scope;
report.hostSha256 = fileDigest(hostExe);
report.pinSha256 = fileDigest(pinned);
report.businessBaseline = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8',timeout:B.command }).trim();
report.businessDiffSha256 = crypto.createHash('sha256').update(execFileSync('git', ['-C', root, 'diff', '--binary'],{timeout:B.command})).digest('hex');
const record = () => atomicJson(path.join(out, 'result.json'), { ...report, requests: seen, writes, requestCount, readTraceBound: process.env.PC_E2E_MODE==='soak'?2048:null });
const phase=name=>{report.phase={name,at:new Date().toISOString()};record();};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function startHost(bind = 0) { budget.check(); if(sampleError)throw sampleError; return new Promise((resolve, reject) => { host = spawn(hostExe, ['serve', '--state', state, '--port', String(bind)], { env: { ...process.env, WORKER_LOCAL_TOKEN: token }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); let text = ''; const timeout = setTimeout(() => reject(Error('HOST_READY_TIMEOUT')), 30000); host.stdout.on('data', b => { text += b; const match = /LOCAL_TASK_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(text); if (match) {
    clearTimeout(timeout);
    hostUrl = match[1];
    hostIdentity=identity(host);
    (report.ownedProcesses??=[]).push({role:'host',identity:hostIdentity});
    resolve();
} }); host.stderr.pipe(fs.createWriteStream(path.join(out, 'host.log'), { flags: 'a' })); host.on('exit', code => { clearTimeout(timeout); reject(Error('HOST_EXIT_' + code)); }); }); }
async function startGateway() { const log = fs.openSync(path.join(out, 'gateway.log'), 'a'); gateway = spawn(process.execPath, [path.join(web, '.local/management-server/management-server.mjs')], { cwd: web, env: { ...process.env, PERSONAL_CONSOLE_PORT: String(gatePort), PERSONAL_CONSOLE_ROOT: path.join(out, 'console'), PERSONAL_DATA_DIR: path.join(out, 'management'), PERSONAL_WORKER_LOCAL_URL: hostUrl, WORKER_LOCAL_TOKEN: token, PERSONAL_ACS_URL: '', PERSONAL_ENV_URL: '' }, windowsHide: true, stdio: ['ignore', log, log] });fs.closeSync(log);gatewayIdentity=identity(gateway);const until=Date.now()+B.start;while(Date.now()<until) {
    try {
        await bounded('GATEWAY_PROBE',2000,async()=>{const r=await fetch('http://127.0.0.1:'+gatePort,{signal:AbortSignal.timeout(2000)});await r.arrayBuffer();});
        gatewayIdentity=identity(gateway);(report.ownedProcesses??=[]).push({role:'gateway',identity:gatewayIdentity});
        return;
    }
    catch {
        await delay(200);
    }
} throw Error('GATEWAY_READY_TIMEOUT'); }
async function open() { const env = { ...process.env, CODEAGENT_PERSONAL_ENDPOINT: 'http://127.0.0.1:' + proxyPort, CODEAGENT_DESKTOP_PROFILE: 'codex-control', CODEAGENT_DESKTOP_PROFILE_ROOT: path.join(out, 'profiles') }; delete env.ELECTRON_RUN_AS_NODE; delete env.MODEL_API_KEY; for (const k of Object.keys(env))
    if (k.startsWith('LLM_HEADER_'))
        delete env[k]; appIdentity=undefined;appLauncherIdentity=undefined;app = await _electron.launch({ executablePath: req('electron'), args: [appRoot], cwd: appRoot, env,timeout:B.start });appIdentity=identity({pid:await bounded('ELECTRON_PID',B.action,()=>app.evaluate(()=>process.pid))});(report.ownedProcesses??=[]).push({role:'electron',identity:appIdentity});record();appLauncherIdentity=identity(app.process());(report.ownedProcesses??=[]).push({role:'electron-launcher',identity:appLauncherIdentity}); page = await bounded('FIRST_WINDOW',B.start,()=>app.firstWindow());page.setDefaultTimeout(B.action);page.setDefaultNavigationTimeout(B.start);await expect(page.getByRole('heading', { name: '原生任务', exact: true })).toBeVisible({timeout:B.start});if(report.samplingStarted)startSampling(); }
async function pauseSampling(reason){if(sampler){await sampler.stop();sampler=undefined;(report.samplePauses??=[]).push({reason,at:new Date().toISOString()});}}
function startSampling(){if(!sampler)sampler=serialSampler(sampleResources,{onError:e=>{sampleError=e;report.samplingError=e.message;record();}});}
async function closeApp(){
 if(!app)return;await pauseSampling('owned-electron-close');
 if(!appIdentity){await bounded('UNIDENTIFIED_APP_CLOSE',B.close,()=>app.close());app=null;return;}
 const descendants=await ownedDescendants(appIdentity);for(const p of descendants)(report.ownedProcesses??=[]).push({role:'electron-descendant',identity:p});record();
 const application=app,started=Date.now(),closing=application.close(),inject=process.env.PC_FORCE_CLOSE_TIMEOUT==='1'&&!report.injectedCloseTimeout;
 if(inject){report.injectedCloseTimeout=true;record();}
 try{await bounded('ELECTRON_CLOSE',B.close,()=>inject?Promise.all([closing,new Promise(()=>{})]):closing);(report.appCloses??=[]).push({mode:'graceful',elapsedMs:Date.now()-started});}
 catch(error){
  // Cold recovery and cleanup require proven process death, not an indefinitely
  // open inspector channel. Preserve the graceful failure and verify ownership
  // again before terminating this run's native process and Windows launcher.
  (report.appCloses??=[]).push({mode:'owned-forced-cleanup',gracefulError:error.message,elapsedMs:Date.now()-started});report.gracefulShutdownQualified=false;record();
  report.appCloses.at(-1).forcingRole='descendants';record();for(const p of descendants)await terminateIdentity(p);
  report.appCloses.at(-1).forcingRole='electron';record();await terminateIdentity(appIdentity);
  report.appCloses.at(-1).forcingRole='launcher';record();if(appLauncherIdentity?.pid!==appIdentity.pid)await terminateIdentity(appLauncherIdentity);
  report.appCloses.at(-1).forcingRole='detach';record();
  await bounded('ELECTRON_DETACH',B.close,()=>closing.catch(()=>{}));
 }
 app=null;
}
async function read(tail,timeoutMs=B.observe) {if(sampleError)throw sampleError;const trace={tail,startedAt:new Date().toISOString()};(report.sourceReads??=[]).push(trace);if(report.sourceReads.length>128)report.sourceReads.shift();try{const value=await observeRead(hostUrl+'/local/v1'+tail,{authorization:'Bearer '+token},{timeoutMs,onRetry:e=>{(report.readRecoveries??=[]).push({tail,at:new Date().toISOString(),error:e.message,method:'GET'});record();}});trace.finishedAt=new Date().toISOString();return value;}catch(e){trace.error=e.message;trace.finishedAt=new Date().toISOString();record();throw e;}}
const facts = async () => JSON.parse(await page.getByTestId('task-facts').textContent());
function script(file, marker) { if (marker === 'CRASH_WRITER')
    return `for ($i=0; $i -lt 240; $i++) { [System.IO.File]::AppendAllText((Join-Path (Get-Location) '${file}'), 'x'); Start-Sleep -Milliseconds 500 }`; return `[System.IO.File]::WriteAllText((Join-Path (Get-Location) '${file}'), "${marker}\u0060n", [System.Text.UTF8Encoding]::new($false))`; }
function permitted(q, d, file, body) { const s = q.scope ?? {}, p = q.params ?? {}; const cwd = s.cwd ?? p.cwd; if (typeof cwd !== 'string' || path.resolve(cwd).toLowerCase() !== path.resolve(d.workspace).toLowerCase())
    return false; if ((q.nativeMethod ?? q.method) === 'item/commandExecution/requestApproval') {
    let a = p.commandActions, v = p.proposedExecpolicyAmendment;
    try {
        a ??= JSON.parse(s.commandActions);
        v ??= JSON.parse(s.proposedExecpolicyAmendment);
    }
    catch {
        return false;
    }
    return Array.isArray(a) && a.length === 1 && a[0].command?.trim() === body && Array.isArray(v) && v.at(-1) === body;
} if ((q.nativeMethod ?? q.method) === 'item/fileChange/requestApproval') {
    let paths = p.paths;
    try {
        paths ??= JSON.parse(s.paths);
    }
    catch {
        return false;
    }
    return Array.isArray(paths) && paths.length === 1 && path.resolve(d.workspace, paths[0]).toLowerCase() === path.resolve(d.workspace, file).toLowerCase();
} return false; }
async function create(file, marker, deny = false, lost = false) {
    budget.beforeTask();
    phase('preflight:'+file);
    const previous = await page.getByTestId('task-id').textContent().catch(() => null);
    const preflightStarted=Date.now();
    await page.getByLabel('原生项目').selectOption({ index: 1 });
    await expect(page.getByTestId('mac-preflight')).toContainText('codex',{timeout:B.observe});
    (report.preflights??=[]).push({elapsedMs:Date.now()-preflightStarted});
    const body = script(file, marker);
    report.promptRevision='external-byte-oracle-no-self-verification-v2';
    await page.getByLabel('原生任务要求').fill(marker === 'CRASH_WRITER' ? 'Run the following exact PowerShell script. It intentionally appends x to ' + file + ' every 500ms for 120 seconds. This is an owned local crash-recovery test; wait for approval before running it. Do not use other tools, write other files or verify with shell. Script: ' + body : `This is a one-command execution test, not an open-ended coding task. An independent external verifier will read the downloaded artifact and verify every byte; you must not perform verification yourself. Create ${file} containing exactly ${marker} followed by one newline. Your only permitted tool call is the shell tool running exactly this PowerShell script: ${body} . Once that tool call returns successfully, end your turn immediately and reply with ${marker}. Do not call ReadAllBytes, Get-Content, any read tool, a second shell command, or any other tool. Do not modify other files or run git commit. If permission is declined, explain and stop without retry. The external verifier, not you, is responsible for verifying the result.`);
    const bindingStarted=Date.now();
    phase('binding:'+file);
    await page.getByRole('button', { name: '开始原生任务', exact: true }).click();
    let id;
    // main's production transport allows 120s. A 30s test deadline can abort a
    // still-valid read; keep the exact task/binding requirement and record latency.
    await expect.poll(async () => { if(!await page.getByTestId('task-facts').count())return false;const f = await facts(); id = f.executionBinding?.localTaskId; return !!id && f.taskId !== previous; }, { timeout: 125000 }).toBe(true);
    (report.bindings??=[]).push({taskId:id,elapsedMs:Date.now()-bindingStarted});record();
    const answered = new Set(), until = Date.now() + B.task;
    phase('task:'+file);
    if(process.env.PC_E2E_MODE==='transport-fault'){
        if(!fixtureMode)throw Error('TRANSPORT_FAULT_REQUIRES_LOCAL_FIXTURE');
        let deadline=performance.now()+B.stop;
        await expect.poll(async()=>{const e=await read('/tasks/'+id+'/events?limit=100',Math.max(1,deadline-performance.now()));const errors=e.items.filter(x=>x.type==='engine.error');if(errors.length)report.injectedFailure={taskId:id,errors:errors.map(x=>({at:x.occurredAt,code:x.payload?.code,willRetry:x.payload?.willRetry}))};return errors.length>0;},{timeout:B.stop}).toBe(true);
        const d=await read('/tasks/'+id);
        if(process.env.PC_STALE_STOP==='1'){
            const taskId=(await facts()).taskId,stale={requestKey:'desktop-stale-stop-'+crypto.randomUUID(),kind:'STOP',generation:d.generation,nativeSessionId:d.nativeSessionId,nativeTurnId:'deliberately-stale-turn',targetCommandId:d.currentCommandId};
            const rejected=await page.evaluate(async({taskId,stale})=>{localStorage.setItem('desktop.personal.stop.'+taskId,JSON.stringify(stale));return window.codeAgentDesktop.personalOperation({action:'TASK_COMMAND_CREATE',taskId,key:stale.requestKey,body:stale});},{taskId,stale});
            if(rejected.data?.state!=='REJECTED'||rejected.data?.sourceError!=='NATIVE_TARGET_CHANGED')throw Error('STALE_STOP_NOT_REJECTED');
            report.staleStop={requestKey:stale.requestKey,state:rejected.data.state,sourceError:rejected.data.sourceError};
            await page.reload();await page.getByRole('button',{name:'只读核对停止请求',exact:true}).click();
            const prepare=page.getByRole('button',{name:'保留拒绝回执并准备新停止',exact:true});await expect(prepare).toBeVisible({timeout:B.observe});
            const before=writes.length;await prepare.click();await expect(page.getByRole('button',{name:'停止原生任务',exact:true})).toBeVisible();
            if(writes.length!==before)throw Error('STOP_PREPARATION_WROTE_NETWORK');
            const history=await page.evaluate(taskId=>JSON.parse(localStorage.getItem('desktop.personal.stop-history.'+taskId)),taskId);
            if(!history.some(x=>x.requestKey===stale.requestKey))throw Error('REJECTED_STOP_RECEIPT_LOST');
            report.steps.push('stale-stop-rejected-preserved-new-explicit-stop');
        }
        await expect.poll(async()=>{const f=await facts(),n=f.native;return f.executionBinding?.localTaskId===id&&n?.generation===d.generation&&n?.nativeSessionId===d.nativeSessionId&&n?.nativeTurnId===d.nativeTurnId&&n?.currentCommandId===d.currentCommandId;},{timeout:B.observe}).toBe(true);
        await page.getByRole('button',{name:'停止原生任务',exact:true}).click();
        deadline=performance.now()+B.stop;
        await expect.poll(async()=>!!(await read('/tasks/'+id,Math.max(1,deadline-performance.now()))).quiescent,{timeout:B.stop}).toBe(true);
        if(fs.existsSync(path.join(d.workspace,file))||(await read('/tasks/'+id+'/artifacts')).items.length)throw Error('TRANSPORT_FAULT_EFFECT_PUBLISHED');
        if(writes.filter(x=>x.url==='/api/personal/v1/tasks').length!==1)throw Error('TRANSPORT_FAULT_REPOSTED');
        report.steps.push('model-disconnect-observed-stop-no-effect-no-repost');return;
    }
    let didDrop = false;
    while (Date.now() < until) {
        if(sampleError)throw sampleError;
        const d = await read('/tasks/' + id,Math.max(1,until-Date.now())), questions = await read('/tasks/' + id + '/input-requests',Math.max(1,until-Date.now()));
        for (const q of questions.items ?? []) {
            if (q.state !== 'PENDING' || answered.has(q.inputRequestId))
                continue;
            if (!permitted(q, d, file, body)) {
                (report.outOfScope??=[]).push({taskId:id,inputRequestId:q.inputRequestId,method:q.nativeMethod??q.method,reason:'not-the-exact-authorized-operation'});record();
                throw Error('OUT_OF_SCOPE_APPROVAL_' + q.inputRequestId);
            }
            const card = page.getByTestId('native-question-' + q.inputRequestId);
            await expect(card).toBeVisible({ timeout: B.observe });
            drop = lost && !didDrop;
            await card.getByRole('button', { name: deny ? 'decline' : 'accept', exact: true }).click();
            answered.add(q.inputRequestId);
            report.approvals.push({ task: id, inputRequestId: q.inputRequestId, decision: deny ? 'decline' : 'accept' });
            record();
            if (lost && !didDrop) {
                didDrop = true;
                await expect.poll(() => seen.some(x => x.dropped),{timeout:B.observe}).toBe(true);
                const pending = await page.evaluate(id => JSON.parse(localStorage.getItem('desktop.personal.input.' + id)), (await facts()).taskId);
                report.lostRequestKey = pending.requestKey;
                const posts = seen.filter(x => x.method === 'POST' && x.url.endsWith('/responses')).length;
                await closeApp();
                app = null;
                await open();
                await page.getByRole('button', { name: '只读核对原输入', exact: true }).click();
                await expect(page.getByRole('button', { name: '保留回执并继续', exact: true })).toBeVisible({timeout:B.observe});
                await page.getByRole('button', { name: '保留回执并继续', exact: true }).click();
                if (seen.filter(x => x.method === 'POST' && x.url.endsWith('/responses')).length !== posts)
                    throw Error('DECISION_REPOSTED');
                report.steps.push('lost-decision-reply-cold-recovery-get-only');
            }
            else {
                await expect(page.getByRole('button', { name: '保留回执并继续', exact: true })).toBeVisible({timeout:B.observe});
                await page.getByRole('button', { name: '保留回执并继续', exact: true }).click();
            }
        }
        if (marker === 'CRASH_WRITER' && answered.size && fs.existsSync(path.join(d.workspace, file)) && fs.statSync(path.join(d.workspace, file)).size >= 3) {
            await pauseSampling('intentional-host-crash');
            restarting=true;
            const oldPort = Number(new URL(hostUrl).port);
            await stopOwned(host,hostIdentity);
            await delay(1500);
            const first = fs.statSync(path.join(d.workspace, file)).size;
            await delay(2000);
            if (fs.statSync(path.join(d.workspace, file)).size !== first)
                throw Error('WRITER_SURVIVED_HOST_CRASH');
            const before = seen.filter(x => x.method === 'POST').length;
            await startHost(oldPort);
            restarting=false;
            startSampling();
            const recovered = await read('/tasks/' + id);
            if (recovered.state !== 'UNKNOWN')
                throw Error('CRASH_RESULT_NOT_UNKNOWN_' + recovered.state);
            await expect.poll(async () => { const f = await facts(); return f.native?.state; }, { timeout: 20000 }).toBe('UNKNOWN');
            await delay(2000);
            if (seen.filter(x => x.method === 'POST').length !== before)
                throw Error('CRASH_REPLAYED_WRITE');
            const events = await read('/tasks/' + id + '/events?limit=100');
            if (events.items.filter(x => x.type === 'turn.bound').length !== 1)
                throw Error('CRASH_REDISPATCHED_TURN');
            if ((await read('/tasks/' + id + '/artifacts')).items.length)
                throw Error('UNKNOWN_ARTIFACT_PUBLISHED');
            report.steps.push('live-host-crash-writers-stopped', 'host-restart-unknown-original-task-no-replay');
            report.crash = { taskId: id, state: recovered.state, stableBytes: first };
            record();
            return { id, d: recovered, file, marker };
        }
        if (['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'].includes(d.state)) {
            if (!answered.size)
                throw Error('REAL_APPROVAL_NOT_EXERCISED');
            if (!deny && d.state !== 'SUCCEEDED')
                throw Error('TASK_' + d.state + '_' + d.reasonCode);
            report.steps.push(deny ? 'decline-no-effect' : 'accepted-source-succeeded');
            await expect.poll(async()=>{const current=await facts();return current.native?.state;},{timeout:B.observe}).toBe(d.state);
            await page.getByRole('heading',{name:'任务事实',exact:true}).scrollIntoViewIfNeeded();
            const destination=path.join(out,(deny?'denied':'approved')+'-'+id+'.png');
            const capture=await captureEvidence(page,destination,fixtureMode&&process.env.PC_FORCE_CAPTURE_FALLBACK==='1'?async()=>{throw Error('INJECTED_PRIMARY_CAPTURE_FAILURE');}:undefined);(report.captures??=[]).push(capture);
            return { id, d, file, marker, answered: answered.size };
        }
        await delay(1000);
    }
    const errors=(await read('/tasks/'+id+'/events?limit=100')).items.filter(x=>x.type==='engine.error');
    report.taskFailure={taskId:id,engineErrors:errors.map(x=>({at:x.occurredAt,code:x.payload?.code,willRetry:x.payload?.willRetry}))};record();
    throw Error('TASK_TIMEOUT');
}
async function stopAndSave(task) { const d = await read('/tasks/' + task.id); if (!d.quiescent) {
    await page.getByRole('button', { name: '停止原生任务', exact: true }).click();
    try{await expect.poll(async () => { const f = await facts(); return f.native?.quiescent; }, { timeout: 60000 }).toBe(true);}catch(error){
      report.result='FAIL';report.error=error.message;report.stopFailure={taskId:task.id,at:new Date().toISOString()};record();
      try{report.stopFailure.ui=await bounded('STOP_FAILURE_UI',B.action,facts);}catch(e){report.stopFailure.uiError=e.message;}
      try{const source=await read('/tasks/'+task.id,B.read);report.stopFailure.source={state:source.state,quiescent:source.quiescent,stopProof:source.stopProof};}catch(e){report.stopFailure.sourceError=e.message;}
      record();throw error;
    }
} const stopped = await read('/tasks/' + task.id); if (stopped.state !== task.d.state)
    throw Error('COMPLETED_OUTCOME_CHANGED'); report.steps.push('live-ui-stop-owned-writers-and-preserve-outcome'); const downloads = path.join(out, 'downloads'); fs.mkdirSync(downloads, { recursive: true }); await app.evaluate(({ dialog }, dir) => { dialog.showSaveDialog = async (o) => ({ canceled: false, filePath: dir + '/' + o.defaultPath.split(/[\\/]/).at(-1) }); }, downloads); const button = page.getByRole('button', { name: '保存成果 ' + task.file, exact: true }); await expect(button).toBeEnabled({ timeout: 30000 }); const saveStarted=Date.now(); await button.click(); await expect(page.getByTestId('verified-artifact')).toContainText('已保存',{timeout:125000}); (report.saves??=[]).push({taskId:task.id,file:task.file,elapsedMs:Date.now()-saveStarted}); if (fs.readFileSync(path.join(downloads, task.file), 'utf8') !== task.marker + '\n')
    throw Error('DELIVERED_BYTES_WRONG'); report.steps.push('main-verified-save-external-byte-oracle'); report.approvedTask = task.id; }
async function soak() {
    const prerequisiteFiles = (process.env.PC_E2E_PREREQUISITES ?? '').split(';').filter(Boolean);
    const prereqs = prerequisiteFiles.map(p => JSON.parse(fs.readFileSync(p, 'utf8')));
    qualify(prereqs,runtime.digest,['PASS_TEST_FOUNDATION','PASS_CONTROL_SUBSET','PASS_LIVE_FAULT_SUBSET'],process.env.PC_CODEX_BUILD);
    if (!prereqs.some(r => r.result === 'PASS_CONTROL_SUBSET') || !prereqs.some(r => r.result === 'PASS_LIVE_FAULT_SUBSET'))
        throw Error('CONTROL_AND_LIVE_FAULT_PASS_REQUIRED');
    if (prereqs.some(r => r.sourceBuild !== process.env.PC_CODEX_BUILD))
        throw Error('PREREQUISITE_BUILD_MISMATCH');
    const seconds = Number(process.env.PC_SOAK_SECONDS ?? 7200), maxTasks = Number(process.env.PC_SOAK_MAX_TASKS ?? 60), interval = Number(process.env.PC_SOAK_INTERVAL_SECONDS ?? 60);
    if (!Number.isInteger(seconds) || seconds < 120 || seconds > 86400 || !Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 1000 || !Number.isInteger(interval) || interval < 10)
        throw Error('INVALID_SOAK_BOUNDS');
    const started = Date.now(),monoStarted=performance.now(), until = started + seconds * 1000;
    let next = started;
    let last;
    report.soak = { startedAt: new Date(started).toISOString(), plannedSeconds: seconds, maxTasks, intervalSeconds: interval, completedTasks: 0, samples: [], prerequisiteFiles };
    record();
    while (Date.now() < until) {
        if (Date.now() >= next && report.soak.completedTasks < maxTasks) {
            const disk=fs.statfsSync(out); if(disk.bavail*disk.bsize<20*1024*1024*1024)throw Error('SOAK_DISK_RESERVE_BELOW_20_GIB');
            const n = report.soak.completedTasks + 1;
            last = await create('codex-soak-' + n + '.txt', 'SOAK_BYTES_' + n, false, false);
            await stopAndSave(last);
            report.soak.completedTasks = n;
            next = Date.now() + interval * 1000;
            report.soak.lastCompletion = new Date().toISOString();
        }
        if(sampleError)throw sampleError;
        if (last) {
            const d = await read('/tasks/' + last.id);
            if (d.state !== 'SUCCEEDED' || d.quiescent !== true)
                throw Error('SOAK_COMPLETED_RESULT_DRIFT');
        }
        report.soak.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
        record();
        await delay(Math.min(30000, Math.max(1, until - Date.now())));
    }
    checkClockGap(previousClock,{wall:Date.now(),mono:performance.now()});
    report.soak.monotonicElapsedSeconds=(performance.now()-monoStarted)/1000;
    report.soak.elapsedSeconds = Math.floor((Date.now() - started) / 1000);
    report.soak.finishedAt = new Date().toISOString();
    report.result = 'PASS_BOUNDED_SOAK';
}
async function sampleResources(){
 report.diskBudget=budget.check();
 if(restarting||!app)return;
 const clock={wall:Date.now(),mono:performance.now()};checkClockGap(previousClock,clock);previousClock=clock;
 if(host.exitCode!==null||gateway.exitCode!==null)throw Error('OWNED_SERVICE_EXITED');
 const hostSample=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command','Get-Process -Id '+host.pid+' | Select-Object Id,WorkingSet64,HandleCount,CPU | ConvertTo-Json -Compress'],{encoding:'utf8',windowsHide:true,timeout:B.sample}));
 const electron=await bounded('ELECTRON_METRICS',B.sample,()=>app.evaluate(({app})=>app.getAppMetrics().map(x=>({type:x.type,workingSetSize:x.memory.workingSetSize,cpuPercent:x.cpu.percentCPUUsage}))));
 const sample={at:new Date().toISOString(),host:hostSample,electron,controller:process.memoryUsage().rss};
 (report.resources??=[]).push(sample);if(report.soak)report.soak.samples.push(sample);
 if(hostSample.WorkingSet64>1024*1024*1024||hostSample.HandleCount>10000)throw Error('RESOURCE_GUARD_EXCEEDED');record();
}
(async () => {
    let budgetStop;
    const budgetTimer=setInterval(()=>{try{budget.check();}catch(e){sampleError??=e;budgetStop??=(hostIdentity?stopOwned(host,hostIdentity):Promise.resolve()).catch(error=>{report.budgetStopError=error.message;});}},budget.policy.intervalMs);
    try {
        phase('source-clone-and-host-init');
        if(fixtureMode){process.env.NO_PROXY='127.0.0.1,localhost,::1';modelFixture=await startModelFixture({fault:process.env.PC_MODEL_FAULT??'none'});for(const k of Object.keys(process.env))if(k.startsWith('LLM_HEADER_'))delete process.env[k];process.env.MODEL_BASE_URL=modelFixture.url;process.env.MODEL_API_KEY=crypto.randomBytes(24).toString('hex');process.env.MODEL_DEFAULT_MODEL='local-verification-fixture';report.model='local-verification-fixture';report.fixture=modelFixture.evidence;}
        report.projectFixture=require('./windows-verification-project.cjs').prepareProject(project,process.env.PC_SOURCE_PROJECT);
        execFileSync(hostExe, ['init', '--state', state, '--executable', pinned, '--project', project, '--project-id', 'rmt-codex'], { env: process.env, stdio: 'pipe',timeout:B.command });
        await startHost();
        phase('gateway-start');
        gatePort = await port();
        await startGateway();
        let delayedTask,delayUntil;
        const bindingDelayMs=Number(process.env.PC_BINDING_DELAY_MS??0);
        const saveDelayMs=Number(process.env.PC_SAVE_DELAY_MS??0);let saveDelayed=false;
        if(!Number.isInteger(saveDelayMs)||saveDelayMs<0||saveDelayMs>60000)throw Error('INVALID_SAVE_DELAY');
        if(!Number.isInteger(bindingDelayMs)||bindingDelayMs<0||bindingDelayMs>60000)throw Error('INVALID_BINDING_DELAY');
        proxy = http.createServer(async (incoming, res) => {try{ const chunks = []; for await (const b of incoming)
            chunks.push(b); const data = Buffer.concat(chunks); const entry = { method: incoming.method, url: incoming.url }; if (data.length) {
            try {
                entry.requestKey = JSON.parse(data).requestKey;
            }
            catch { }
        } entry.startedAt=new Date().toISOString();seen.push(entry); requestCount++; if(entry.method==='POST')writes.push(entry); if(process.env.PC_E2E_MODE==='soak'&&seen.length>2048)seen.shift();
        if(bindingDelayMs&&incoming.method==='GET'&&/^\/api\/personal\/v1\/tasks\/task-[^/]+$/.test(incoming.url)){
            if(!delayedTask){delayedTask=incoming.url;delayUntil=Date.now()+bindingDelayMs;report.bindingDelay={task:delayedTask,delayMs:bindingDelayMs};}
            if(incoming.url===delayedTask&&Date.now()<delayUntil){entry.injectedDelayMs=delayUntil-Date.now();await delay(entry.injectedDelayMs);}
        }
        if(saveDelayMs&&!saveDelayed&&incoming.method==='GET'&&/\/artifacts\/file-[a-f0-9]+$/.test(incoming.url)){saveDelayed=true;entry.saveDelayMs=saveDelayMs;await delay(saveDelayMs);}
        if(res.destroyed)return;
        const headers = { ...incoming.headers, host: '127.0.0.1:' + gatePort, origin: 'http://127.0.0.1:' + gatePort }; const up = http.request({ host: '127.0.0.1', port: gatePort, path: incoming.url, method: incoming.method, headers }, reply => { entry.headersAt=new Date().toISOString();reply.on('end',()=>{entry.finishedAt=new Date().toISOString();});const discard = drop && incoming.method === 'POST' && incoming.url.endsWith('/responses'); if (discard) {
            drop = false;
            entry.dropped = true;
            reply.resume();
            reply.on('end', () => res.destroy());
            return;
        } entry.status = reply.statusCode; res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });up.setTimeout(B.transport,()=>up.destroy(Error('PROXY_UPSTREAM_TIMEOUT'))); up.on('error', () => { if (!res.headersSent)
            res.writeHead(502); res.end(); });res.on('close',()=>{if(!res.writableFinished)up.destroy();}); up.end(data); }catch(e){res.destroy();report.proxyReadError=e.code??e.name;record();}});
        await new Promise(r => proxy.listen(0, '127.0.0.1', r));
        proxyPort = proxy.address().port;
        phase('electron-start');await open();
        report.samplingStarted=true;startSampling();
        if (process.env.PC_E2E_MODE==='transport-fault'){
            await create('codex-no-network-effect.txt','NO_NETWORK_EFFECT');report.result='PASS_FIXTURE_TRANSPORT_FAULT';
        } else if (process.env.PC_E2E_MODE === 'soak') {
            if(fixtureMode)throw Error('LIVE_SOAK_REJECTS_FIXTURE');
            await soak();
        }
        else if (process.env.PC_E2E_MODE === 'faults') {
            const allowed = await create('codex-before-restart.txt', 'RESTART_DELIVERY', false, false);
            await stopAndSave(allowed);
            const first = seen.length;
            await pauseSampling('intentional-gateway-restart');restarting=true;
            await stopOwned(gateway,gatewayIdentity);
            await startGateway();
            restarting=false;
            startSampling();
            await expect.poll(() => seen.slice(first).some(x => x.method === 'GET' && x.status === 200 && /\/tasks\/task-[^/]+$/.test(x.url)), { timeout: 20000 }).toBe(true);
            if (seen.slice(first).some(x => x.method === 'POST'))
                throw Error('GATEWAY_RESTART_REPOSTED');
            report.steps.push('live-gateway-restart-ui-recovers-with-get-only');
            record();
            await create('codex-crash-writer.txt', 'CRASH_WRITER', false, false);
            report.result = fixtureMode?'PASS_FIXTURE_FAULT_SUBSET':'PASS_LIVE_FAULT_SUBSET';
        }
        else {
            const allowed = await create('codex-control-approved.txt', 'CODEX_APPROVED_BYTES', false, true);
            if(bindingDelayMs){const creates=writes.filter(x=>x.url==='/api/personal/v1/tasks');if(creates.length!==1||report.bindings[0].elapsedMs<bindingDelayMs)throw Error('DELAYED_BINDING_ORIGINAL_CREATE_NOT_PROVEN');report.steps.push('delayed-binding-original-create-no-repost');}
            await stopAndSave(allowed);
            // Reopen the same profile for a reject case, retaining history.
            await closeApp();
            app = null;
            // The ordinary new-task workflow must permit a second accepted task.
            await open();
            const denied = await create('codex-control-denied.txt', 'MUST_NOT_EXIST', true, false);
            if (fs.existsSync(path.join(denied.d.workspace, denied.file)))
                throw Error('DENIED_EFFECT_OCCURRED');
            report.deniedTask = denied.id;
            report.result = fixtureMode?'PASS_FIXTURE_CONTROL_SUBSET':'PASS_CONTROL_SUBSET';
        }
    }
    catch (e) {
        report.error = e.message;
        report.errorStack = e.stack;
        report.errorDiagnostic=e.diagnostic;
        report.result = 'FAIL';record();
        if (page && !page.isClosed()) {
            try{report.alerts=await bounded('FAILURE_ALERTS',B.action,()=>page.getByRole('alert').allTextContents());await captureEvidence(page,path.join(out,'failed.png'));}catch(error){report.failureEvidenceError=error.message;}
        }
    }
    finally {
        clearInterval(budgetTimer);
        if(budgetStop)await budgetStop;
        phase('cleanup');
        const cleanup=[];async function clean(name,fn){try{await fn();cleanup.push({name,result:'PASS'});}catch(e){cleanup.push({name,result:'FAIL',error:e.message,stack:e.stack,diagnostic:e.diagnostic});}}
        await clean('sampler',async()=>{if(sampler)await sampler.stop();});
        await clean('electron',async()=>{try{await closeApp();}catch(e){if(appIdentity)await terminateIdentity(appIdentity);throw e;}});
        await clean('proxy',async()=>{if(proxy){proxy.closeAllConnections();await bounded('PROXY_CLOSE',B.close,()=>new Promise(r=>proxy.close(r)));}});
        await clean('gateway',()=>stopOwned(gateway,gatewayIdentity));await clean('host',()=>stopOwned(host,hostIdentity));
        await clean('model-fixture',async()=>{if(modelFixture)await bounded('MODEL_FIXTURE_CLOSE',B.close,()=>modelFixture.close());});
        report.cleanup={result:cleanup.every(x=>x.result==='PASS')?'PASS':'FAIL',steps:cleanup};
        if(sampleError||report.cleanup.result==='FAIL'){report.primaryResult=report.result;report.result='FAIL';report.error??=sampleError?.message??'CLEANUP_FAILED';}
        if(report.soak&&!report.soak.finishedAt)report.soak.failedAt=new Date().toISOString();record();
        console.log(JSON.stringify({ result: report.result, error: report.error, out }));
        budget.release();
        process.exitCode = report.result.startsWith('PASS') ? 0 : 1;
    }
})();
