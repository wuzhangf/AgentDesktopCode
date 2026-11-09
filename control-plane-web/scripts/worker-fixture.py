"""Start an isolated, human-paced Web fixture over the sealed phase-3 release.
Only generated loopback credentials cross private process pipes/environment.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import threading
import uuid

app = Path(__file__).resolve().parents[1]
workspace = app.parents[2]
parser = argparse.ArgumentParser()
parser.add_argument('--release-root', type=Path, default=workspace / '.worktrees/worker-phase3-acs/.local/r7')
parser.add_argument('--acs-root', type=Path, default=workspace / 'AgentCodeService')
parser.add_argument('--port', type=int, default=8791)
parser.add_argument('--skip-build', action='store_true')
parser.add_argument('--live-project', type=Path, help='Use the real central MODEL_* provider and an isolated clone of this Git project')
parser.add_argument('--run-root', type=Path, help='New isolated output directory for a real-model run')
parser.add_argument('--worker-overlay', type=Path, help='Explicit locally built Worker correction JAR; never mutates sealed releases')
parser.add_argument('--runtime-overlay', type=Path, help='Explicit locally built ACS correction JAR')
parser.add_argument('--product-overlay', type=Path, help='Explicit locally built Product adoption evidence correction JAR')
parser.add_argument('--patch-bundle', type=Path, help='Verified PASS bundle from worker-regression.py')
args = parser.parse_args()
if args.patch_bundle:
    bundle = args.patch_bundle.resolve()
    proof = json.loads((bundle / 'result.json').read_text(encoding='utf-8'))
    if proof.get('result') != 'PASS': raise RuntimeError('Patch bundle has no passing daemon regression')
    for name, field in [('worker-baseline-patch.jar', 'workerOverlaySha256'), ('acs-resume-patch.jar', 'runtimeOverlaySha256')]:
        if hashlib.sha256((bundle / name).read_bytes()).hexdigest() != proof.get(field):
            raise RuntimeError('Patch bundle hash mismatch: ' + name)
    args.worker_overlay = bundle / 'worker-baseline-patch.jar'
    args.runtime_overlay = bundle / 'acs-resume-patch.jar'
    if proof.get('productOverlaySha256'):
        args.product_overlay = bundle / 'product-adoption-patch.jar'
        if hashlib.sha256(args.product_overlay.read_bytes()).hexdigest() != proof['productOverlaySha256']:
            raise RuntimeError('Product patch bundle hash mismatch')
release = args.release_root.resolve()
run = app / ('.local/worker-fixture-' + str(args.port))
run.mkdir(parents=True, exist_ok=True)
manifest = json.loads((release / 'artifact-manifest.json').read_text(encoding='utf-8'))
if args.patch_bundle and hashlib.sha256((release / 'artifact-manifest.json').read_bytes()).hexdigest() != proof['releaseManifestSha256']:
    raise RuntimeError('Patch bundle was verified against a different sealed release')
version = manifest['version']
distribution = release / 'distribution/acs' / ('agent-code-local-' + version)
pins = json.loads((distribution / 'manifest.json').read_text(encoding='utf-8'))
sha = lambda file: hashlib.sha256(file.read_bytes()).hexdigest()
for relative, digest in pins['files'].items():
    if sha(distribution / relative) != digest:
        raise RuntimeError('Sealed release changed: ' + relative)
fixture_classes = release / 'acs/agent-code-runtime/target/test-classes'
worker_distribution = release / 'distribution/worker' / ('agent-worker-local-' + version)
worker_pins = json.loads((worker_distribution / 'manifest.json').read_text(encoding='utf-8'))
for relative, digest in worker_pins['files'].items():
    if sha(worker_distribution / relative) != digest:
        raise RuntimeError('Sealed Worker release changed: ' + relative)
worker_classpath = os.pathsep.join(map(str, [*sorted((worker_distribution / 'lib').glob('*.jar')),
    release / 'worker/worker-testkit/target' / ('worker-testkit-' + version + '.jar')]))
if args.worker_overlay:
    worker_classpath = str(args.worker_overlay.resolve()) + os.pathsep + worker_classpath
classpath = os.pathsep.join(map(str, [*sorted((distribution / 'lib').glob('*.jar')), fixture_classes,
    release / 'm2/junit/junit/4.13.2/junit-4.13.2.jar', release / 'm2/org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar']))
if args.runtime_overlay:
    classpath = str(args.runtime_overlay.resolve()) + os.pathsep + classpath
if args.product_overlay:
    classpath = str(args.product_overlay.resolve()) + os.pathsep + classpath
source = args.acs_root.resolve() / 'verification/WorkerWebFixture.java'
sources = [source]
if args.live_project:
    for key in ('MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_NAME'):
        if not os.environ.get(key):
            raise RuntimeError('Load the central environment first: missing ' + key)
    live_root = (args.run_root or app / '.local/worker-live-e2e' / ('run-' + str(uuid.uuid4())[:8])).resolve()
    if live_root.exists():
        raise RuntimeError('Real-model run directory must be new: ' + str(live_root))
    live_root.mkdir(parents=True)
    os.environ.update(WORKER_LIVE_ROOT=str(live_root), WORKER_LIVE_SOURCE=str(args.live_project.resolve()))
    sources.append(source.with_name('WorkerLiveFixture.java'))
compile_args = ['-encoding', 'UTF-8', '-cp', classpath, '-d', str(run), *map(str, sources)]
def argfile(name, values):
    file = run / name
    file.write_text('\n'.join('"' + str(value).replace('\\', '/').replace('"', '\\"') + '"' for value in values), encoding='utf-8')
    return '@' + str(file)
java = Path(shutil.which('java')).parent
subprocess.run([str(java / 'javac.exe' if os.name == 'nt' else java / 'javac'), argfile('compile.args', compile_args)], check=True, cwd=app)
if not args.skip_build:
    subprocess.run(['node', 'scripts/worker-build.mjs'], check=True, cwd=app)
inputs = {'releaseVersion': version, 'manifestSha256': sha(release / 'artifact-manifest.json'),
    'fixtureSourceSha256': {file.name: sha(file) for file in sources}, 'runtime': 'sealed distribution JARs; existing protocol fixture test classes',
    'modelMode': 'REAL_MODEL_REAL_PROJECT' if args.live_project else 'DETERMINISTIC_PROTOCOL_MODEL'}
if args.worker_overlay:
    inputs['workerOverlay'] = {'path': str(args.worker_overlay.resolve()), 'sha256': sha(args.worker_overlay.resolve())}
if args.runtime_overlay:
    inputs['runtimeOverlay'] = {'path': str(args.runtime_overlay.resolve()), 'sha256': sha(args.runtime_overlay.resolve())}
if args.product_overlay:
    inputs['productOverlay'] = {'path': str(args.product_overlay.resolve()), 'sha256': sha(args.product_overlay.resolve())}
if args.live_project:
    inputs['model'] = {'name': os.environ['MODEL_NAME'], 'baseUrl': os.environ['MODEL_BASE_URL']}
(run / 'inputs.json').write_text(json.dumps(inputs, indent=2), encoding='utf-8')
if args.live_project:
    (live_root / 'inputs.json').write_text(json.dumps(inputs, indent=2), encoding='utf-8')
host = None
web = None
try:
    host = subprocess.Popen([str(java / 'java.exe' if os.name == 'nt' else java / 'java'),
        argfile('runtime.args', ['-cp', str(run) + os.pathsep + classpath, 'com.sage.business.code.bootstrap.' + ('WorkerLiveFixture' if args.live_project else 'WorkerWebFixture')])],
        cwd=app, env={**os.environ, 'WORKER_WEB_CLASSPATH': worker_classpath}, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding='utf-8', errors='replace')
    ready = None
    for line in host.stdout:
        if line.startswith('WORKER_WEB_READY '):
            ready = json.loads(line[len('WORKER_WEB_READY '):])
            break
    if ready is None:
        raise RuntimeError('Fixture Host did not become ready')
    # Continue draining diagnostics without persisting requests or credentials.
    threading.Thread(target=lambda: [None for _ in host.stdout], daemon=True).start()
    env = os.environ.copy()
    env.update(WORKER_CONTROL_API_URL=ready['baseUrl'], WORKER_CONTROL_API_TOKEN=ready['token'],
        WORKER_FIXTURE_URL=ready['fixtureUrl'], WORKER_FIXTURE_TOKEN=ready['fixtureToken'], WORKER_CONTROL_PORT=str(args.port))
    print('Isolated fixture workspace: ' + ready['workspace'], flush=True)
    web = subprocess.Popen(['node', '.local/worker-server/worker-server.mjs'], cwd=app, env=env)
    if web.wait() != 0:
        raise RuntimeError('Worker Web server exited unsuccessfully')
except KeyboardInterrupt:
    pass
finally:
    if web and web.poll() is None:
        web.terminate()
        try: web.wait(timeout=10)
        except subprocess.TimeoutExpired: web.kill()
    if host and host.poll() is None:
        try:
            host.stdin.write('stop\n')
            host.stdin.flush()
            host.wait(timeout=20)
        except (OSError, subprocess.TimeoutExpired):
            host.terminate()
            try: host.wait(timeout=5)
            except subprocess.TimeoutExpired: host.kill()
