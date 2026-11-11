// Dedicated small repository for control-chain tests; use PC_SOURCE_PROJECT for
// explicitly selected real-project acceptance. This does not change Host isolation.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process');
function prepareProject(destination,source){
 const git=args=>execFileSync('git',['-c','core.fscache=true',...args],{windowsHide:true,timeout:60000,stdio:['ignore','pipe','pipe']});
 if(source){
  const tree=git(['-C',source,'ls-tree','-rl','HEAD']).toString();let bytes=0,files=0;
  for(const line of tree.trim().split('\n')){const m=line.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t/);if(!m)throw Error('ONLY_SMALL_REGULAR_FILE_FIXTURES_ALLOWED');bytes+=Number(m[1]);files++;}
  const counts=git(['-C',source,'count-objects','-v']).toString();const kb=[...counts.matchAll(/^size(?:-pack)?: (\d+)$/gm)].reduce((a,m)=>a+Number(m[1]),0);
  if(bytes>1024**2||files>100||kb>4096)throw Error('PROJECT_TOO_LARGE_FOR_BOUNDED_VERIFICATION');
  git(['clone','--quiet','--local',source,destination]);return {kind:'EXPLICIT_SMALL_PROJECT',source:path.resolve(source),bytes,files};
 }
 fs.mkdirSync(destination);git(['init','--quiet',destination]);
 fs.writeFileSync(path.join(destination,'README.md'),'# Windows control-chain fixture\n\nSmall isolated repository for approval, STOP and artifact verification.\n');
 fs.writeFileSync(path.join(destination,'sum.cjs'),'module.exports = (a, b) => a + b;\n');
 fs.writeFileSync(path.join(destination,'sum.test.cjs'),"const assert=require('node:assert/strict');assert.equal(require('./sum.cjs')(2,3),5);\n");
 git(['-C',destination,'add','.']);git(['-C',destination,'-c','user.name=Verification Fixture','-c','user.email=fixture@localhost','-c','commit.gpgsign=false','commit','--quiet','-m','Small control-chain fixture']);
 return {kind:'SMALL_CONTROL_FIXTURE',source:null};
}
module.exports={prepareProject};
