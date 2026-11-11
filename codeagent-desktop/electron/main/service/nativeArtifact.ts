import {createHash} from 'node:crypto';

export interface NativeArtifactSaveRequest {taskId:string;artifactId:string;sourceStoreId:string;sha256:string;path:string}
export function validNativeArtifactSave(v:unknown):v is NativeArtifactSaveRequest {
  if(!v||typeof v!=='object'||Array.isArray(v))return false;
  const r=v as NativeArtifactSaveRequest;
  return Object.keys(r).sort().join(',')==='artifactId,path,sha256,sourceStoreId,taskId'
    &&[r.taskId,r.sourceStoreId].every(x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x))
    &&/^file-[a-f0-9]{64}$/.test(r.artifactId)&&/^[a-f0-9]{64}$/.test(r.sha256)
    &&typeof r.path==='string'&&r.path.length>0&&r.path.length<=4096;
}
export function decodeNativeArtifact(value:unknown,expected:NativeArtifactSaveRequest):Buffer {
  const v=value as {encoding?:string;path?:string;sha256?:string;bytes?:string};
  if(!v||v.encoding!=='base64'||v.path!==expected.path||v.sha256!==expected.sha256||typeof v.bytes!=='string'||v.bytes.length>24*1024*1024||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v.bytes))throw new Error('ARTIFACT_MISMATCH');
  const bytes=Buffer.from(v.bytes,'base64');
  if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw new Error('ARTIFACT_DIGEST_MISMATCH');
  return bytes;
}
