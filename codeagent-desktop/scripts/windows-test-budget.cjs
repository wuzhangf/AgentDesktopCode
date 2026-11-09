// Local test limits only; never starts/stops services and never deletes data.
const fs=require('fs'),path=require('path');
const POLICY=Object.freeze({fixtureBytes:512*1024**2,liveBytes:2*1024**3,minFreeBytes:20*1024**3,maxWorkspaces:3,maxTasks:3,maxFiles:10000,maxRuns:3,intervalMs:10000});
function acquire(root,mode,fixture){
 if(process.env.PC_TEST_EXECUTE!=='1')throw Error('TESTS_DISABLED_EXPLICIT_EXECUTION_REQUIRED');
 if(!['control','faults','transport-fault'].includes(mode))throw Error('LEGACY_SOAK_DISABLED');
 const scope=path.resolve(root,'.local/windows-pc-checks');fs.mkdirSync(scope,{recursive:true});
 if(fs.realpathSync(scope).toLowerCase()!==scope.toLowerCase())throw Error('TEST_SCOPE_REDIRECTED');
 const lock=path.join(scope,'active.lock');let fd;
 try{fd=fs.openSync(lock,'wx');}catch{throw Error('ONE_TEST_AT_A_TIME_OR_STALE_LOCK_REVIEW_REQUIRED');}
 fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
 let released=false,tasks=0;const started=performance.now(),limit=fixture?POLICY.fixtureBytes:POLICY.liveBytes;
 function release(){if(released)return;released=true;fs.closeSync(fd);fs.unlinkSync(lock);}
 function check(){
  const disk=fs.statfsSync(scope);if(disk.bavail*disk.bsize<POLICY.minFreeBytes)throw Error('TEST_FREE_DISK_RESERVE');
  if(performance.now()-started>(fixture?10:20)*60000)throw Error('TEST_WALL_TIME_LIMIT');
  let bytes=0,files=0,workspaces=0,runs=0;
  function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true})){
   const p=path.join(dir,d.name);if(d.isSymbolicLink())throw Error('TEST_REPARSE_POINT_REFUSED');
   if(d.isDirectory()){
    if(dir===scope&&++runs>POLICY.maxRuns)throw Error('TEST_RETAINED_RUN_LIMIT');
    if(path.basename(dir)==='workspaces'&&++workspaces>POLICY.maxWorkspaces)throw Error('TEST_WORKSPACE_LIMIT');
    walk(p);
   }else{if(++files>POLICY.maxFiles)throw Error('TEST_FILE_COUNT_LIMIT');bytes+=fs.statSync(p).size;if(bytes>limit)throw Error('TEST_DISK_BUDGET_EXCEEDED');}
  }}walk(scope);return {bytes,files,workspaces,runs,limit};
 }
 try{check();}catch(e){release();throw e;}
 return {scope,policy:POLICY,check,release,beforeTask(){const current=check();if(current.workspaces>=POLICY.maxWorkspaces)throw Error('TEST_WORKSPACE_LIMIT');if(++tasks>POLICY.maxTasks)throw Error('TEST_TASK_LIMIT');}};
}
module.exports={POLICY,acquire};
