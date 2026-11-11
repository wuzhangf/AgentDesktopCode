import {describe,it,expect} from 'vitest';
import {fixtureApproval} from '../verification/native-worker/approval';
import type {NativeInputRequest,NativeTaskDetail} from '../../codeagent-desktop/packages/protocol/src/native-task';

const script="[System.IO.File]::ReadAllText((Join-Path (Get-Location) 'native-smoke.txt'))";
const native:NativeTaskDetail={taskId:'native-fixture',engineId:'codex',engineVersion:'pinned',state:'RUNNING',generation:'generation',nativeSessionId:'thread',nativeTurnId:'turn',currentCommandId:'launch',workspace:'D:\\owned\\native-fixture'};
const question:NativeInputRequest={inputRequestId:'question',method:'item/commandExecution/requestApproval',state:'PENDING',generation:'generation',nativeSessionId:'thread',nativeTurnId:'turn',targetCommandId:'launch',options:['accept','decline','cancel'],scope:{cwd:'\\\\?\\D:\\owned\\native-fixture',proposedExecpolicyAmendment:JSON.stringify(['pwsh.exe','-NoProfile','-Command',script])}};
describe('fixture approval stays on the exact native source and known file command',()=>{
  it('replies using original question guards and a stable request key',()=>{expect(fixtureApproval(question,native,[script])).toEqual({kind:'INPUT_RESPONSE',requestKey:'fixture-approval-question',generation:'generation',nativeSessionId:'thread',nativeTurnId:'turn',targetCommandId:'launch',inputRequestId:'question',response:{decision:'accept'}});});
  it('accepts the pinned native shell form without a profile flag',()=>{expect(fixtureApproval({...question,scope:{...question.scope,proposedExecpolicyAmendment:JSON.stringify(['C:\\Program Files\\PowerShell\\7\\pwsh.exe','-Command',script])}},native,[script])?.kind).toBe('INPUT_RESPONSE');});
  it.each<Record<string,string>>([{cwd:'D:\\unrelated'}, {proposedExecpolicyAmendment:JSON.stringify(['pwsh.exe','-NoProfile','-Command',script+'; Remove-Item *'])}, {proposedExecpolicyAmendment:JSON.stringify(['D:\\evil\\pwsh.exe','-NoProfile','-Command',script])}, {proposedExecpolicyAmendment:'[]'}])('rejects unowned cwd, altered scripts and executables: %j',scope=>{expect(fixtureApproval({...question,scope:{...question.scope,...scope}},native,[script])).toBeUndefined();});
  it.each([{nativeTurnId:'other'},{generation:'other'},{nativeSessionId:'other'},{targetCommandId:'other'},{method:'item/fileChange/requestApproval'},{state:'ANSWERED'}])('rejects stale or unsupported native requests: %j',change=>{expect(fixtureApproval({...question,...change},native,[script])).toBeUndefined();});
});
