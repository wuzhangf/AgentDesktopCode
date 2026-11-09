import type {NativeInput, NativeInputRequest, NativeTaskDetail} from '../../../codeagent-desktop/packages/protocol/src/native-task';

const path=(v:string)=>{const p=v.replaceAll('\\','/').replace(/^\/\/\?\//,'').replace(/\/+$/,'');return process.platform==='win32'||/^[a-z]:\//i.test(p)?p.toLowerCase():p;};
/** Test-only approval: one known shell script, original question guards, exact owned cwd. */
export function fixtureApproval(q:NativeInputRequest,n:NativeTaskDetail,scripts:readonly string[]):NativeInput|undefined {
  if(q.state!=='PENDING'||q.method!=='item/commandExecution/requestApproval'||!q.options?.includes('accept')
    ||!n.workspace||!q.scope?.cwd||path(q.scope.cwd)!==path(n.workspace)
    ||!q.nativeSessionId||q.generation!==n.generation||q.nativeSessionId!==n.nativeSessionId
    ||q.targetCommandId!==n.currentCommandId||(q.nativeTurnId??null)!==(n.nativeTurnId??null))return;
  let args:unknown;try{args=JSON.parse(q.scope.proposedExecpolicyAmendment??'');}catch{return;}
  if(!Array.isArray(args)||![3,4].includes(args.length)||!args.every(v=>typeof v==='string'))return;
  const [executable,...tail]=args as string[];
  if(tail.length===3&&tail.shift()?.toLowerCase()!=='-noprofile')return;
  const [command,script]=tail;
  if(!['pwsh','pwsh.exe','powershell','powershell.exe','c:/program files/powershell/7/pwsh.exe','c:/windows/system32/windowspowershell/v1.0/powershell.exe'].includes(path(executable))
    ||command.toLowerCase()!=='-command'||!scripts.includes(script.trim()))return;
  return {kind:'INPUT_RESPONSE',requestKey:'fixture-approval-'+q.inputRequestId,generation:q.generation,nativeSessionId:q.nativeSessionId,
    ...(q.nativeTurnId?{nativeTurnId:q.nativeTurnId}:{}),targetCommandId:q.targetCommandId,inputRequestId:q.inputRequestId,response:{decision:'accept'}};
}
