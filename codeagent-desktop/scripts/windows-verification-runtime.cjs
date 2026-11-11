const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,execFile}=require('node:child_process');
const B=Object.freeze({transport:120000,observe:125000,start:30000,action:15000,task:420000,stop:60000,read:20000,close:15000,sample:10000,sampleInterval:30000,command:120000});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(label,ms,fn){let timer;try{return await Promise.race([Promise.resolve().then(fn),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+'_TIMEOUT')),ms);})]);}finally{clearTimeout(timer);}}
async function jsonRead(url,init={},ms=B.read){ms=Math.max(1,Math.floor(ms));return bounded('SOURCE_READ',ms,async()=>{const r=await fetch(url,{...init,signal:AbortSignal.timeout(ms),redirect:'error'});if(!r.ok)throw Error('READ_'+r.status);return r.json();});}
async function observeRead(url,headers,{timeoutMs=B.observe,attemptMs=B.read,onRetry=()=>{}}={}){
 const until=performance.now()+timeoutMs;
 while(performance.now()<until){try{return await jsonRead(url,{method:'GET',headers},Math.max(1,Math.min(attemptMs,until-performance.now())));}catch(e){if(!(/^(SOURCE_READ_TIMEOUT|READ_5\d\d)$/.test(e.message)||['TypeError','TimeoutError','AbortError'].includes(e.name)))throw e;onRetry(e);const left=until-performance.now();if(left<=0)break;await delay(Math.min(250,left));}}
 throw Error('READ_OBSERVATION_TIMEOUT');
}
function atomicJson(file,data){const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data,null,2));fs.renameSync(temp,file);}
function fileDigest(file){const fd=fs.openSync(file,'r'),digest=crypto.createHash('sha256'),buffer=Buffer.alloc(64*1024);try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)digest.update(buffer.subarray(0,n));return digest.digest('hex');}finally{fs.closeSync(fd);}}
function fingerprint(root,host,pin){
 const scripts=path.join(root,'apps/codeagent-desktop/scripts');
 const files=[process.execPath,host,pin,...['windows-codex-control-e2e.cjs','windows-codex-soak-stages.cjs','windows-ui-evidence.cjs','windows-verification-runtime.cjs','windows-model-fixture.cjs','windows-verification-project.cjs','windows-test-budget.cjs','windows-pc-scenario.cjs','windows-verification-tests.cjs','windows-test-foundation.cjs'].map(n=>path.join(scripts,n))];
 for(const sub of ['apps/codeagent-desktop/dist-electron','apps/codeagent-desktop/dist/renderer','apps/control-plane-web/.local/management-server']){const dir=path.join(root,sub);for(const item of fs.readdirSync(dir,{recursive:true,withFileTypes:true}))if(item.isFile())files.push(path.join(item.parentPath,item.name));}
 const manifest=Object.fromEntries(files.sort().map(p=>[path.resolve(p),fileDigest(p)]));
 return {manifest,digest:crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')};
}
function identity(child){
 if(!child?.pid)throw Error('OWNED_PROCESS_PID_REQUIRED');
 const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';$taskProcess=[Diagnostics.Process]::GetProcessById(${Number(child.pid)});try{[pscustomobject]@{pid=$taskProcess.Id;created=$taskProcess.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');exe=$taskProcess.MainModule.FileName}|ConvertTo-Json -Compress}finally{$taskProcess.Dispose()}`;
 let raw;try{raw=execFileSync('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:B.sample});}catch(e){throw Error('OWNED_IDENTITY_QUERY_FAILED:'+child.pid+':'+e.message,{cause:e});}
 if(!raw.trim())throw Error('OWNED_PROCESS_NOT_FOUND');return JSON.parse(raw);
}
function identityMillis(value){if(typeof value!=='string')return NaN;const m=/^\/Date\((\d+)\)\/$/.exec(value);return m?Number(m[1]):Date.parse(value);}
function sameIdentity(a,b){return !!a&&!!b&&Number.isInteger(a.pid)&&a.pid>0&&a.pid===b.pid&&Number.isFinite(identityMillis(a.created))&&identityMillis(a.created)===identityMillis(b.created)&&typeof a.exe==='string'&&typeof b.exe==='string'&&path.resolve(a.exe).toLowerCase()===path.resolve(b.exe).toLowerCase();}
async function stopOwned(child,expected){if(!child)return;if(child.pid!==expected?.pid)throw Error('OWNED_PROCESS_IDENTITY_CHANGED');await terminateIdentity(expected);await delay(0);}
async function terminateIdentity(expected){
 if(!Number.isInteger(expected?.pid)||expected.pid<1||!expected.created||!expected.exe)throw Error('OWNED_PROCESS_IDENTITY_CHANGED');
 const legacyDate=/^\/Date\((\d+)\)\/$/.exec(expected.created),expectedMillis=legacyDate?Number(legacyDate[1]):Date.parse(expected.created);if(!Number.isFinite(expectedMillis))throw Error('OWNED_PROCESS_IDENTITY_CHANGED');
 const quote=s=>"'"+String(s).replaceAll("'","''")+"'";
 // Observe the native process handle, not disappearance from WMI inventory.
 // Debugger/launcher handles can retain an exited process's WMI row. Identity,
 // Kill and WaitForExit all use this same Process object, avoiding PID reuse.
 const script=`$ErrorActionPreference='Stop';try{$taskProcess=[Diagnostics.Process]::GetProcessById(${expected.pid})}catch [ArgumentException]{Write-Output 'ALREADY_EXITED';exit 0};try{if($taskProcess.HasExited){Write-Output 'ALREADY_EXITED';exit 0};$expectedStart=[DateTime]::SpecifyKind([DateTime]'1970-01-01',[DateTimeKind]::Utc).AddMilliseconds(${expectedMillis});if([Math]::Abs(($taskProcess.StartTime.ToUniversalTime()-$expectedStart).TotalMilliseconds)-gt 1 -or $taskProcess.MainModule.FileName -ine ${quote(expected.exe)}){throw 'OWNED_PROCESS_IDENTITY_CHANGED'};$taskProcess.Kill();if(-not $taskProcess.WaitForExit(${B.close})){throw 'OWNED_PROCESS_EXIT_TIMEOUT'};Write-Output 'EXITED'}finally{$taskProcess.Dispose()}`;
 // The parent must keep servicing Playwright's inspector/process pipes while
 // Windows completes Electron termination. A synchronous WaitForExit stalls it.
 try{await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:B.close+5000},(error,stdout,stderr)=>{if(error){error.stderr=stderr;reject(error);}else resolve(stdout);}));}catch(e){if(e.stderr?.toString().includes('OWNED_PROCESS_IDENTITY_CHANGED'))throw Error('OWNED_PROCESS_IDENTITY_CHANGED');const error=Error('OWNED_PROCESS_EXIT_UNCONFIRMED');error.diagnostic=e.stderr?.toString().slice(-3000);throw error;}
}
async function ownedDescendants(root){
 if(!Number.isInteger(root?.pid)||root.pid<1)throw Error('OWNED_PROCESS_PID_REQUIRED');
 // Toolhelp reads the kernel's PID/parent snapshot without the WMI service.
 // Resolve start time and executable only for the verified owned subtree.
 const script=`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';
 Add-Type -TypeDefinition @'
 using System;using System.Collections.Generic;using System.Runtime.InteropServices;
 public static class OwnedProcessSnapshot {
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)]struct Entry {public uint size,usage,pid;public UIntPtr heap;public uint module,threads,parent;public int priority;public uint flags;[MarshalAs(UnmanagedType.ByValTStr,SizeConst=260)]public string exe;}
  public struct Row {public uint pid,parent;}
  [DllImport("kernel32.dll",SetLastError=true)]static extern IntPtr CreateToolhelp32Snapshot(uint flags,uint pid);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32FirstW(IntPtr h,ref Entry e);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool Process32NextW(IntPtr h,ref Entry e);
  [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr h);
  public static Row[] Read(){var h=CreateToolhelp32Snapshot(2,0);if(h==new IntPtr(-1))throw new System.ComponentModel.Win32Exception();try{var e=new Entry();e.size=(uint)Marshal.SizeOf(typeof(Entry));var rows=new List<Row>();if(!Process32FirstW(h,ref e))throw new System.ComponentModel.Win32Exception();do{rows.Add(new Row{pid=e.pid,parent=e.parent});}while(Process32NextW(h,ref e));var error=Marshal.GetLastWin32Error();if(error!=18)throw new System.ComponentModel.Win32Exception(error);return rows.ToArray();}finally{CloseHandle(h);}}
 }
'@
 function Read-OwnedIdentity([int]$ownedPid){try{$p=[Diagnostics.Process]::GetProcessById($ownedPid)}catch [ArgumentException]{return $null};try{if($p.HasExited){return $null};[pscustomobject]@{pid=$p.Id;created=$p.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ');exe=$p.MainModule.FileName}}catch [InvalidOperationException]{if(-not $p.HasExited){throw}}finally{$p.Dispose()}}
 $rootIdentity=Read-OwnedIdentity ${root.pid};if($null -eq $rootIdentity){[pscustomobject]@{root=$null;descendants=@()}|ConvertTo-Json -Compress;exit 0}
 $rows=[OwnedProcessSnapshot]::Read();$owned=New-Object 'Collections.Generic.List[object]';$owned.Add($rootIdentity);$cursor=0;
 while($cursor -lt $owned.Count){$parent=$owned[$cursor];$cursor++;foreach($row in $rows){if($row.parent -ne $parent.pid -or $row.pid -in $owned.pid){continue};$child=Read-OwnedIdentity $row.pid;if($null -ne $child -and [DateTime]$child.created -ge [DateTime]$parent.created){$child|Add-Member NoteProperty parent ([int]$row.parent);$owned.Add($child)}}}
 [pscustomobject]@{root=$rootIdentity;descendants=@($owned|Select-Object -Skip 1)}|ConvertTo-Json -Compress -Depth 5`;
 const value=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:B.sample},(e,stdout,stderr)=>{if(e){const failure=Error('OWNED_TREE_QUERY_FAILED');failure.diagnostic=stderr?.toString().slice(-3000);reject(failure);}else try{resolve(JSON.parse(stdout));}catch(error){reject(error);}}));
 if(!value.root)return[];if(!sameIdentity(root,value.root))throw Error('OWNED_PROCESS_IDENTITY_CHANGED');return value.descendants.reverse();
}
function serialSampler(sample,{intervalMs=B.sampleInterval,timeoutMs=B.sample,onError=()=>{}}={}){
 let active=true,timer,pending=Promise.resolve(),error;
 function tick(){if(!active)return;pending=bounded('RESOURCE_SAMPLE',timeoutMs,sample).catch(e=>{error=e;active=false;onError(e);}).finally(()=>{if(active)timer=setTimeout(tick,intervalMs);});}
 tick();return {get error(){return error;},async stop(){active=false;clearTimeout(timer);await pending;}};
}
function verifyStage(result,exit,hours){const seconds=(Date.parse(result.soak?.finishedAt)-Date.parse(result.soak?.startedAt))/1000;if(exit.code!==0||result.result!=='PASS_BOUNDED_SOAK'||!Number.isFinite(seconds)||seconds<hours*3600||!(result.soak?.monotonicElapsedSeconds>=hours*3600)||!(result.soak?.completedTasks>=1)||result.cleanup?.result!=='PASS')throw Error('STAGE_FAILED:'+hours+'h');return seconds;}
function checkClockGap(previous,current){if(previous&&(current.wall-previous.wall>90000||Math.abs((current.wall-previous.wall)-(current.mono-previous.mono))>5000))throw Error('OBSERVATION_CLOCK_OR_SAMPLE_GAP');}
function qualify(reports,digest,results,sourceBuild){for(const required of results){const r=reports.find(x=>x.result===required);if(!r||r.runtimeDigest!==digest||r.cleanup?.result!=='PASS')throw Error('CURRENT_RUNTIME_QUALIFICATION_REQUIRED:'+required);if(sourceBuild!==undefined&&(!sourceBuild||r.sourceBuild!==sourceBuild))throw Error('PREREQUISITE_BUILD_MISMATCH:'+required);}}
module.exports={B,delay,bounded,jsonRead,observeRead,atomicJson,fileDigest,fingerprint,identity,sameIdentity,stopOwned,terminateIdentity,ownedDescendants,serialSampler,verifyStage,qualify,checkClockGap};
