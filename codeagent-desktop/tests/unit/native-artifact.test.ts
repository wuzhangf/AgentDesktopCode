import {createHash} from 'node:crypto';
import {describe,it,expect} from 'vitest';
import {decodeNativeArtifact,validNativeArtifactSave} from '../../electron/main/service/nativeArtifact';
import {validPersonalOperation} from '../../packages/protocol/src/personal';
const bytes=Buffer.from('实际成果\n');const sha256=createHash('sha256').update(bytes).digest('hex');
const request={taskId:'task-1',sourceStoreId:'store-1',artifactId:'file-'+'a'.repeat(64),path:'src/test.txt',sha256};
describe('native artifact save boundary',()=>{
 it('verifies exact bytes and rejects substituted paths/digests',()=>{expect(validNativeArtifactSave(request)).toBe(true);const file={encoding:'base64',path:request.path,sha256,bytes:bytes.toString('base64')};expect(decodeNativeArtifact(file,request)).toEqual(bytes);expect(()=>decodeNativeArtifact({...file,path:'other.txt'},request)).toThrow();expect(()=>decodeNativeArtifact({...file,bytes:Buffer.from('other').toString('base64')},request)).toThrow();});
 it('rejects arbitrary paths/URLs crossing the save request boundary',()=>{expect(validNativeArtifactSave({...request,url:'http://other'})).toBe(false);expect(validNativeArtifactSave({...request,artifactId:'../secret'})).toBe(false);});
});
describe('native input fixed routes',()=>{
 const guard={requestKey:'input-1',generation:'generation-1',nativeSessionId:'session-1',targetCommandId:'command-1'};
 it.each(['PAUSE','RESUME'])('accepts guarded %s but rejects early null session and arbitrary command fields',kind=>{const op={action:'TASK_COMMAND_CREATE',taskId:'task-1',key:guard.requestKey,body:{...guard,kind}};expect(validPersonalOperation(op)).toBe(true);expect(validPersonalOperation({...op,body:{...op.body,nativeSessionId:null}})).toBe(false);expect(validPersonalOperation({...op,body:{...op.body,command:'unsafe'}})).toBe(false);});
 it('accepts messages only through the native contract',()=>{const op={action:'NATIVE_MESSAGE_CREATE',taskId:'task-1',key:guard.requestKey,body:{...guard,kind:'NATIVE_FOLLOW_UP',content:'继续修订'}};expect(validPersonalOperation(op)).toBe(true);expect(validPersonalOperation({...op,key:'different'})).toBe(false);expect(validPersonalOperation({...op,body:{...op.body,url:'http://other'}})).toBe(false);});
 it('binds an answer to the exact route input request',()=>{const op={action:'NATIVE_INPUT_RESPONSE',taskId:'task-1',entityId:'question-1',key:guard.requestKey,body:{...guard,kind:'INPUT_RESPONSE',inputRequestId:'question-1',response:{value:'回答'}}};expect(validPersonalOperation(op)).toBe(true);expect(validPersonalOperation({...op,entityId:'question-2'})).toBe(false);});
});
