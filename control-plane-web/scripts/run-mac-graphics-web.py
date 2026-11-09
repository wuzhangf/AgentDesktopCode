#!/usr/bin/env python3
"""Prepare the real Web/BFF; run owned browser against inherited signed Host."""
import argparse,json,os,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
 p=argparse.ArgumentParser();p.add_argument('--phase',choices=['prepare','run'],required=True);p.add_argument('--output',type=Path,required=True);p.add_argument('--config',type=Path,required=True);a=p.parse_args();config=json.loads(a.config.read_text());out=a.output.absolute();out.mkdir(parents=True,exist_ok=True)
 if any(any(x in k.lower() for x in ['token','password','secret','bearer']) for k in config):raise RuntimeError('Only nonsecret configuration paths/ports are allowed')
 env={k:v for k,v in os.environ.items() if k in ['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL']}
 env['PLAYWRIGHT_BROWSERS_PATH']=str(Path(config.get('browserCacheDirectory',out/'browsers')).absolute())
 if a.phase=='prepare':
  if not config.get('chromiumExecutable'):
   with (out/'browser-install.log').open('wb') as log:subprocess.run(['node','node_modules/@playwright/test/cli.js','install','chromium','--only-shell'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
  with (out/'web-build.log').open('wb') as log:subprocess.run(['node','scripts/management-build.mjs'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=300)
  (out/'prepared.json').write_text(json.dumps({'schemaVersion':'mac-graphics-web-prepared/1','webRoot':str(ROOT),'consolePort':config.get('consolePort',18891),'projectId':config['projectId']},indent=2));print('PREPARED_WEB_GRAPHICS');return 0
 if not (out/'prepared.json').exists():raise RuntimeError('Run prepare first')
 for key in ['WORKER_LOCAL_TOKEN','GRAPHICS_HOST_ORIGIN','GRAPHICS_STORE_ID','GRAPHICS_EXISTING_TASK_ID','GRAPHICS_FIXTURE_STATUS_PATH']:
  if not os.environ.get(key):raise RuntimeError('Missing inherited '+key)
 return subprocess.run(['node','scripts/mac-graphics-web-e2e.mjs','--output',str(out),'--config',str(a.config.absolute())],cwd=ROOT,env={**dict(os.environ),'PLAYWRIGHT_BROWSERS_PATH':env['PLAYWRIGHT_BROWSERS_PATH']},stdin=subprocess.DEVNULL).returncode
if __name__=='__main__':
 try:sys.exit(main())
 except Exception as e:print(type(e).__name__+': '+str(e));sys.exit(2)
