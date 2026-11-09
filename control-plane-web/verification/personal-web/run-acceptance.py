"""Actual browser -> built BFF -> current-source ACS/Product -> file effect.
Uses random in-memory loopback protocol credentials; never logs the private ready pipe.
"""
from pathlib import Path
import argparse, subprocess, os, json, socket, queue, threading, time, urllib.request, shutil

parser=argparse.ArgumentParser()
parser.add_argument('--runtime',type=Path,required=True)
parser.add_argument('--output',type=Path,required=True)
parser.add_argument('--without-observation',action='store_true')
args=parser.parse_args()
app=Path(__file__).resolve().parents[2]
out=args.output.resolve();out.mkdir(parents=True,exist_ok=False)
classpath=(args.runtime.resolve()/'classpath.txt').read_text(encoding='utf-8')
allowed={'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','JAVA_HOME','PROGRAMFILES','PROGRAMFILES(X86)','SYSTEMDRIVE'}
base={k:v for k,v in os.environ.items() if k.upper() in allowed}
mode='DISABLED' if args.without_observation else 'REQUIRED'
java=str(Path(shutil.which('javac')).with_name('java.exe' if os.name=='nt' else 'java'))
host=subprocess.Popen([java,'-Duser.language=en','-Dfile.encoding=UTF-8','-Duser.home='+str(out/'isolated-home'),'-Dobservation.mode='+mode,'-cp',classpath,'com.sage.business.code.bootstrap.PersonalWebFixture',str(out/'host')],env=base,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf-8',errors='replace')
lines=queue.Queue()
def read_host():
    for line in host.stdout: lines.put(line)
threading.Thread(target=read_host,daemon=True).start()
bff=None
try:
    ready=None;deadline=time.monotonic()+90
    while time.monotonic()<deadline:
        try:line=lines.get(timeout=1)
        except queue.Empty:
            if host.poll() is not None: raise RuntimeError('ACS exited before readiness')
            continue
        if line.startswith('PERSONAL_WEB_READY '):ready=json.loads(line.split(' ',1)[1]);break
        # Startup output has no protocol credentials before readiness.
        with (out/'host-startup.log').open('a',encoding='utf-8') as log:log.write(line)
    if not ready:raise RuntimeError('ACS readiness timeout')
    # Non-secret source contract evidence for diagnosing real adapter differences.
    source={}
    for path in ['/api/v2/capabilities','/api/v2/projects/sample/session-preflight','/api/v2/model-catalog']:
        request=urllib.request.Request(ready['baseUrl']+path,headers={'Authorization':'Bearer '+ready['token']})
        with urllib.request.urlopen(request,timeout=20) as response:source[path]=json.load(response)
    (out/'source-contracts.json').write_text(json.dumps(source,indent=2),encoding='utf-8')
    with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
    env={**base,'PERSONAL_ACS_URL':ready['baseUrl'],'PERSONAL_ACS_TOKEN':ready['token'],'PERSONAL_CONSOLE_PORT':str(port),'PERSONAL_CONSOLE_ROOT':str(out/'console'),'PERSONAL_REPORTS_ENABLED':'0'}
    if not args.without_observation:
        env.update(OBS_DB=str(out/'host/state/observations/observations.db'),OBS_MODE='LIVE',PERSONAL_OBSERVATION_SOURCE_ID='env-obs-db')
    with (out/'bff.log').open('w',encoding='utf-8') as log:
        bff=subprocess.Popen([shutil.which('node'),'.local/management-server/management-server.mjs'],cwd=app,env=env,stdout=log,stderr=subprocess.STDOUT)
        url=f'http://127.0.0.1:{port}'
        for _ in range(100):
            try:
                urllib.request.urlopen(url+'/personal.html',timeout=1).close();break
            except Exception:
                if bff.poll() is not None:raise RuntimeError('Built BFF exited; see bff.log')
                time.sleep(.1)
        result=subprocess.run([shutil.which('node'),'verification/personal-web/browser.mjs'],cwd=app,env={**base,'PERSONAL_WEB_TEST_URL':url,'PERSONAL_WEB_TEST_OUT':str(out)},capture_output=True,text=True,encoding='utf-8',timeout=240)
        (out/'browser.log').write_text(result.stdout+result.stderr,encoding='utf-8')
        if result.returncode:raise RuntimeError('Browser acceptance failed; see browser.log')
    # Kill only this harness-owned BFF, reopen the same registry and follow old navigation.
    bff.terminate();bff.wait(timeout=10)
    with (out/'bff-restart.log').open('w',encoding='utf-8') as log:
        bff=subprocess.Popen([shutil.which('node'),'.local/management-server/management-server.mjs'],cwd=app,env=env,stdout=log,stderr=subprocess.STDOUT)
        for _ in range(100):
            try:urllib.request.urlopen(url+'/personal.html',timeout=1).close();break
            except Exception:
                if bff.poll() is not None:raise RuntimeError('Restarted BFF exited')
                time.sleep(.1)
        restarted=subprocess.run([shutil.which('node'),'verification/personal-web/restart.mjs'],cwd=app,env={**base,'PERSONAL_WEB_TEST_URL':url,'PERSONAL_WEB_TEST_OUT':str(out)},capture_output=True,text=True,encoding='utf-8',timeout=45)
        (out/'restart.log').write_text(restarted.stdout+restarted.stderr,encoding='utf-8')
        if restarted.returncode:raise RuntimeError('BFF restart acceptance failed; see restart.log')
    result=json.loads((out/'browser-result.json').read_text(encoding='utf-8'))
    detail=result['detail']['data'];binding=detail['session']['workspaceBinding'];run=detail['run']
    assert run['state']=='COMPLETED',run
    original=out/'host/workspace/x.txt'
    assert original.read_text(encoding='utf-8')=='v1','Original checkout was modified'
    modified=[p for p in out.rglob('x.txt') if p!=original and p.read_text(encoding='utf-8')=='v2']
    assert modified,'No actual isolated file effect found'
    metrics=result['metrics']['data']['metrics']
    if args.without_observation:assert all(m['value'] is None for m in metrics)
    else:assert any(m['metricId']=='model.usage.total.reported' and m['value'] is not None for m in metrics),result['metrics']
    (out/'acceptance.json').write_text(json.dumps({'status':'PASS','observation':mode,'taskId':detail['taskId'],'sessionId':detail['sessionId'],'runId':detail['runId'],'workspaceMode':binding['mode'],'originalUnchanged':True,'bffRestartAndLegacyNavigation':'PASS','isolatedChangedFiles':[str(p) for p in modified],'externalModelCalls':0},indent=2),encoding='utf-8')
    print('PERSONAL_WEB_REAL_EXECUTION_PASS '+str(out))
finally:
    if bff is not None:
        bff.terminate()
        try:bff.wait(timeout=10)
        except subprocess.TimeoutExpired:bff.kill()
    if host.poll() is None:
        try:host.stdin.write('\n');host.stdin.flush();host.wait(timeout=15)
        except Exception:host.kill()
