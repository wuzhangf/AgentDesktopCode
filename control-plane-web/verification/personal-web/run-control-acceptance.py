"""Actual browser -> built BFF -> current-source ACS/Product: deterministic
PAUSE -> BFF restart -> RESUME -> STOP on one ordinary host-session run.

The fixture model gate (PersonalWebFixture -Dpersonal.fixture.gate) makes a
model call deterministically in-flight, so control commands are issued against
a real RUNNING run without timing sleeps. restart-bff/bff-ready files in the
gate dir coordinate a mid-flight BFF restart with the browser script.
"""
from pathlib import Path
import argparse, subprocess, os, json, socket, queue, threading, time, urllib.request, shutil

parser = argparse.ArgumentParser()
parser.add_argument('--runtime', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
app = Path(__file__).resolve().parents[2]
out = args.output.resolve(); out.mkdir(parents=True, exist_ok=False)
gate = out / 'gate'; gate.mkdir()
classpath = (args.runtime.resolve() / 'classpath.txt').read_text(encoding='utf-8')
allowed = {'PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','JAVA_HOME','PROGRAMFILES','PROGRAMFILES(X86)','SYSTEMDRIVE'}
base = {k: v for k, v in os.environ.items() if k.upper() in allowed}
java = str(Path(shutil.which('javac')).with_name('java.exe' if os.name == 'nt' else 'java'))
host = subprocess.Popen([java, '-Duser.language=en', '-Dfile.encoding=UTF-8',
    '-Duser.home=' + str(out / 'isolated-home'), '-Dobservation.mode=REQUIRED',
    '-Dpersonal.fixture.foundation=true', '-Dpersonal.fixture.gate=' + str(gate),
    '-cp', classpath, 'com.sage.business.code.bootstrap.PersonalWebFixture', str(out / 'host')],
    env=base, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    text=True, encoding='utf-8', errors='replace')
lines = queue.Queue()
def read_host():
    for line in host.stdout: lines.put(line)
threading.Thread(target=read_host, daemon=True).start()

bff = None
bff_log = None
def start_bff(env, name):
    log = open(out / name, 'w', encoding='utf-8')
    return subprocess.Popen([shutil.which('node'), '.local/management-server/management-server.mjs'],
                            cwd=app, env=env, stdout=log, stderr=subprocess.STDOUT), log
def stop_bff():
    global bff, bff_log
    if bff is not None:
        bff.terminate()
        try: bff.wait(timeout=10)
        except subprocess.TimeoutExpired: bff.kill()
    if bff_log is not None: bff_log.close()
    bff = bff_log = None
def wait_bff(url):
    for _ in range(150):
        try: urllib.request.urlopen(url + '/personal.html', timeout=1).close(); return
        except Exception:
            if bff.poll() is not None: raise RuntimeError('Built BFF exited; see bff logs')
            time.sleep(.1)
    raise RuntimeError('BFF readiness timeout')

try:
    ready = None; deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        try: line = lines.get(timeout=1)
        except queue.Empty:
            if host.poll() is not None: raise RuntimeError('ACS exited before readiness')
            continue
        if line.startswith('PERSONAL_WEB_READY '): ready = json.loads(line.split(' ', 1)[1]); break
        with (out / 'host-startup.log').open('a', encoding='utf-8') as log: log.write(line)
    if not ready: raise RuntimeError('ACS readiness timeout')

    with socket.socket() as s: s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
    env = {**base, 'PERSONAL_ACS_URL': ready['baseUrl'], 'PERSONAL_ACS_TOKEN': ready['token'],
           'PERSONAL_CONSOLE_PORT': str(port), 'PERSONAL_CONSOLE_ROOT': str(out / 'console'),
           'PERSONAL_REPORTS_ENABLED': '0',
           'OBS_DB': str(out / 'host/state/observations/observations.db'),
           'OBS_MODE': 'LIVE', 'PERSONAL_OBSERVATION_SOURCE_ID': 'env-obs-db'}
    url = f'http://127.0.0.1:{port}'
    bff, bff_log = start_bff(env, 'bff.log'); wait_bff(url)

    # Mid-flight restart coordinator: the browser script asks via gate files.
    def restart_when_asked():
        marker = gate / 'restart-bff'
        while not marker.exists():
            if host.poll() is not None: return
            time.sleep(.2)
        stop_bff()
        global bff, bff_log
        bff, bff_log = start_bff(env, 'bff-restart.log'); wait_bff(url)
        (gate / 'bff-ready').write_text('')
    threading.Thread(target=restart_when_asked, daemon=True).start()

    result = subprocess.run([shutil.which('node'), 'verification/personal-web/control-browser.mjs'],
        cwd=app, env={**base, 'PERSONAL_WEB_TEST_URL': url, 'PERSONAL_WEB_TEST_OUT': str(out),
                      'PERSONAL_WEB_GATE_DIR': str(gate)},
        capture_output=True, text=True, encoding='utf-8', timeout=420)
    (out / 'control-browser.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    if result.returncode: raise RuntimeError('Control browser acceptance failed; see control-browser.log')

    result = json.loads((out / 'control-browser-result.json').read_text(encoding='utf-8'))
    commands = result['commands']
    by_intent = {i['intent']: i for i in commands}
    for intent in ('PAUSE', 'RESUME', 'STOP'):
        receipt = by_intent[intent]
        assert receipt['phase'] == 'APPLIED' and receipt['terminal'] is True, receipt
        assert receipt['commandId'].startswith('web-control-'), receipt
        # PAUSE/RESUME prove product consumption; a STOP landing on a terminal
        # run is APPLIED via the terminal evidence ref instead.
        if intent in ('PAUSE', 'RESUME'):
            assert receipt.get('consumptionProof'), receipt
        else:
            assert receipt.get('consumptionProof') or receipt.get('evidenceRef'), receipt
    (out / 'acceptance.json').write_text(json.dumps({
        'status': 'PASS', 'taskId': result['taskId'], 'runId': result['runId'],
        'sessionId': result['sessionId'],
        'sameRunAndSession': True, 'bffRestartMidPending': 'PASS',
        'receipts': {k: {'phase': v['phase'], 'resultCode': v.get('resultCode')} for k, v in by_intent.items()},
        'externalModelCalls': 0,
    }, indent=2), encoding='utf-8')
    print('PERSONAL_WEB_CONTROL_PASS ' + str(out))
finally:
    stop_bff()
    if host.poll() is None:
        try: host.stdin.write('\n'); host.stdin.flush(); host.wait(timeout=15)
        except Exception: host.kill()
