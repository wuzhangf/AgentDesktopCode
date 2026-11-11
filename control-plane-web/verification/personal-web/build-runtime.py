"""Compile current ACS/Product/Framework sources into this task's isolated output.
Reuses the existing ACS runtime dependency directory; publishes no Maven artifacts.
"""
from pathlib import Path
import hashlib, json, os, subprocess, argparse, shutil

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', type=Path, required=True)
parser.add_argument('--framework', type=Path, help='Explicit AgentFramework repository when outside workspace')
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
workspace, out = args.workspace.resolve(), args.output.resolve()
out.mkdir(parents=True, exist_ok=False)
acs = workspace / 'AgentCodeService'
modules = [acs / n for n in ['agent-code-contract', 'agent-code-product-host', 'agent-code-runtime', 'agent-code-storage-local']]
modules += [workspace / 'AgentProducts' / n for n in ['ProductAgentCode', 'ProductAgentPlan', 'ProductAgentRelease', 'ProductAgentDesign']]
framework = (args.framework.resolve() if args.framework else workspace / 'AgentFramework') / 'AgentFramework'
modules += [m for m in framework.iterdir() if (m / 'src/main/java').is_dir() and m.name != 'agent-product-workspace-demo']
sources = [s for m in modules for s in (m / 'src/main/java').rglob('*.java')]
jars = list((acs / 'agent-code-runtime/target/dependency').glob('*.jar'))
if not jars:
    raise SystemExit('ACS target/dependency absent; prepare its declared runtime dependencies first')
# Optional personal-access dependency already present on this developer machine.
jars += sorted((Path.home() / '.m2/repository/com/nimbusds/nimbus-jose-jwt').glob('*/nimbus-jose-jwt-*.jar'))[-1:]
classes = out / 'classes'
classes.mkdir()
fixture = Path(__file__).with_name('PersonalWebFixture.java')
sources.append(fixture)
options = ['--release', '17', '-encoding', 'UTF-8', '-Xmaxerrs', '25', '-cp', os.pathsep.join(map(str, jars)), '-d', str(classes)] + list(map(str, sources))
argfile = out / 'javac.args'
argfile.write_text('\n'.join('"' + v.replace('\\', '/') + '"' for v in options), encoding='utf-8')
with (out / 'compile.log').open('w', encoding='utf-8') as log:
    result = subprocess.run(['javac', '-J-Duser.language=en', '-J-Dfile.encoding=UTF-8', '@' + str(argfile)], stdout=log, stderr=subprocess.STDOUT)
if result.returncode:
    print((out / 'compile.log').read_text(encoding='utf-8', errors='replace')[-12000:])
    raise SystemExit(result.returncode)
for module in modules:
    resources = module / 'src/main/resources'
    if resources.exists():
        shutil.copytree(resources, classes, dirs_exist_ok=True)
(out / 'classpath.txt').write_text(str(classes) + os.pathsep + os.pathsep.join(map(str, jars)), encoding='utf-8')
(out / 'inputs.json').write_text(json.dumps({'sources': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in sources}, 'jars': {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in jars}}, indent=2), encoding='utf-8')
print(f'Compiled {len(sources)} current sources into isolated runtime')
