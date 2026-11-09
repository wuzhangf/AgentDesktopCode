"""Build an explicit Worker patch and run the real daemon pause/resume/handoff regression."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile
import sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')

p = argparse.ArgumentParser()
p.add_argument('--release-root', type=Path, required=True)
p.add_argument('--worker-root', type=Path, required=True)
p.add_argument('--acs-root', type=Path, required=True)
p.add_argument('--out', type=Path, required=True)
p.add_argument('--without-patch', action='store_true')
p.add_argument('--runtime-patch-source', type=Path)
p.add_argument('--product-patch-source', type=Path)
a = p.parse_args()
release, out = a.release_root.resolve(), a.out.resolve()
out.mkdir(parents=True, exist_ok=True)
manifest = json.loads((release / 'artifact-manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
acs_dist = release / 'distribution/acs' / ('agent-code-local-' + version)
worker_dist = release / 'distribution/worker' / ('agent-worker-local-' + version)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
for dist in (acs_dist, worker_dist):
    for relative, digest in json.loads((dist / 'manifest.json').read_text(encoding='utf-8'))['files'].items():
        if sha(dist / relative) != digest: raise RuntimeError('Sealed distribution changed')
acp = os.pathsep.join(map(str, [*sorted((acs_dist / 'lib').glob('*.jar')),
    release / 'acs/agent-code-runtime/target/test-classes', release / 'm2/junit/junit/4.13.2/junit-4.13.2.jar',
    release / 'm2/org/hamcrest/hamcrest-core/1.3/hamcrest-core-1.3.jar']))
wcp = os.pathsep.join(map(str, [*sorted((worker_dist / 'lib').glob('*.jar')),
    release / 'worker/worker-testkit/target' / ('worker-testkit-' + version + '.jar')]))
patch = out / 'worker-baseline-patch.jar'
if not a.without_patch:
    classes = a.worker_root.resolve() / 'agent-worker-core/target/classes'
    files = list(classes.glob('com/sage/agentworker/core/exec/GitEvidence*.class'))
    if not files: raise RuntimeError('Run Worker GitEvidenceBaselineTest to compile the correction first')
    with zipfile.ZipFile(patch, 'w', zipfile.ZIP_DEFLATED) as jar:
        for file in files: jar.write(file, file.relative_to(classes).as_posix())
    wcp = str(patch) + os.pathsep + wcp
sources = [a.acs_root.resolve() / 'verification' / name for name in
    ('WorkerWebFixture.java', 'WorkerResumeRegression.java')]
java = Path(shutil.which('java')).parent
def argfile(name, values):
    file = out / name
    file.write_text('\n'.join('"' + str(value).replace('\\', '/') + '"' for value in values), encoding='utf-8')
    return '@' + str(file)
runtime_patch = None
product_patch = None
if a.product_patch_source:
    product = a.product_patch_source.resolve()
    classes = out / 'product-patch-classes'
    classes.mkdir(exist_ok=True)
    product_sources = [product / 'ProductAgentCode/src/main/java/com/agent/product/code/runtime' / name
        for name in ('CodeAdoptionState.java', 'CodeAgentRunSession.java')]
    subprocess.run([str(java / 'javac.exe'), argfile('compile-product.args', ['-encoding', 'UTF-8', '-cp', acp, '-d', classes, *product_sources])], check=True)
    product_patch = out / 'product-adoption-patch.jar'
    with zipfile.ZipFile(product_patch, 'w', zipfile.ZIP_DEFLATED) as jar:
        for file in classes.rglob('*.class'): jar.write(file, file.relative_to(classes).as_posix())
    acp = str(product_patch) + os.pathsep + acp
    test = product / 'ProductAgentCode/src/test/java/com/agent/product/code/runtime/WritableCollaborationRuntimeTest.java'
    subprocess.run([str(java / 'javac.exe'), argfile('compile-product-test.args', ['-encoding', 'UTF-8', '-cp', acp, '-d', out, test])], check=True)
    with (out / 'product-tests.log').open('w', encoding='utf-8') as log:
        checked = subprocess.run([str(java / 'java.exe'), argfile('product-tests.args', ['-cp', str(out) + os.pathsep + acp,
            'org.junit.runner.JUnitCore', 'com.agent.product.code.runtime.WritableCollaborationRuntimeTest'])], stdout=log, stderr=subprocess.STDOUT, timeout=180)
    if checked.returncode:
        print((out / 'product-tests.log').read_text(encoding='utf-8', errors='replace')[-3000:])
        raise SystemExit(checked.returncode)
if a.runtime_patch_source:
    classes = out / 'acs-patch-classes'
    classes.mkdir(exist_ok=True)
    source = a.runtime_patch_source.resolve() / 'agent-code-runtime/src/main/java/com/sage/business/code/application/TaskApplicationService.java'
    subprocess.run([str(java / 'javac.exe'), argfile('compile-acs.args', ['-encoding', 'UTF-8', '-cp', acp, '-d', classes, source])], check=True)
    runtime_patch = out / 'acs-resume-patch.jar'
    with zipfile.ZipFile(runtime_patch, 'w', zipfile.ZIP_DEFLATED) as jar:
        for file in classes.rglob('*.class'): jar.write(file, file.relative_to(classes).as_posix())
    acp = str(runtime_patch) + os.pathsep + acp
subprocess.run([str(java / 'javac.exe'), argfile('compile.args', ['-encoding', 'UTF-8', '-cp', acp, '-d', out, *sources])], check=True)
inputs = {'releaseVersion': version, 'releaseManifestSha256': sha(release / 'artifact-manifest.json'),
    'workerSourceCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=a.worker_root, text=True).strip(),
    'workerSourceSha256': sha(a.worker_root / 'agent-worker-core/src/main/java/com/sage/agentworker/core/exec/GitEvidence.java'),
    'sources': {file.name: sha(file) for file in sources}, 'patched': not a.without_patch}
if not a.without_patch: inputs['workerOverlaySha256'] = sha(patch)
if runtime_patch:
    inputs['runtimeOverlaySha256'] = sha(runtime_patch)
    inputs['runtimeSourceSha256'] = sha(source)
if product_patch:
    inputs['productOverlaySha256'] = sha(product_patch)
    inputs['productSources'] = {str(file.relative_to(product)): sha(file) for file in [*product_sources, test]}
(out / 'inputs.json').write_text(json.dumps(inputs, indent=2), encoding='utf-8')
with (out / 'regression.log').open('w', encoding='utf-8') as log:
    result = subprocess.run([str(java / 'java.exe'), argfile('regression.args', ['-Dfile.encoding=UTF-8', '-cp', str(out) + os.pathsep + acp,
        'com.sage.business.code.bootstrap.WorkerResumeRegression'])], env={**os.environ, 'WORKER_WEB_CLASSPATH': wcp},
        stdout=log, stderr=subprocess.STDOUT, timeout=240)
(out / 'result.json').write_text(json.dumps({'result': 'PASS' if result.returncode == 0 else 'FAIL', **inputs}, indent=2), encoding='utf-8')
print((out / 'regression.log').read_text(encoding='utf-8', errors='replace')[-5000:])
raise SystemExit(result.returncode)
