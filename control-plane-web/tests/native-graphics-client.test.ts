import {it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {validNativeGraphicsInput,registeredGraphicsPreflight,validNativePreflight,type NativePreflight} from '../../codeagent-desktop/packages/protocol/src/native-task';
import {verifiedGraphicsPNG} from '../src/personal/components/NativeGraphicsSection';
it('strict graph bodies keep original scope and reject arbitrary process/path/script fields',()=>{
 const guard={generation:'g',nativeSessionId:'session',segmentId:'segment',ownerEpoch:'1'},base={requestKey:'key',guard};
 expect(validNativeGraphicsInput('observe',base)).toBe(true);expect(validNativeGraphicsInput('capture',{...base,observationRevision:'revision'})).toBe(true);
 const action={...base,observationRevision:'revision',action:'setValue',elementIdentifier:'field',value:'bounded'};
 expect(validNativeGraphicsInput('actions',action)).toBe(true);
 for(const extra of [{pid:1},{path:'/tmp/x'},{url:'https://invalid'},{script:'exit()'},{guard:{...guard,ownerEpoch:undefined}},{observationRevision:undefined}])expect(validNativeGraphicsInput('actions',{...action,...extra})).toBe(false);
 expect(validNativeGraphicsInput('actions',{...action,value:'x'.repeat(4097)})).toBe(false);
});
it('only the explicitly registered recipe accepts non-Git preflight',()=>{
 const pref={projectId:'fixture',engineVersion:'1',optionsRevision:'options',engineId:'macos',profileId:'MAC_MANAGED',profileHome:null,loadsUserExtensions:false,headRevision:null,treeRevision:null,hasUncommittedChanges:false,workingCopyPolicy:'REGISTERED_TARGET_ONLY',registryDigest:'a'.repeat(64),macProfile:{recipeID:'mac.app-workflow/1',graphicsProfile:{bundleID:'fixture.app'}}} as NativePreflight;
 expect(registeredGraphicsPreflight(pref)).toBe(true);expect(validNativePreflight(pref)).toBe(true);expect(validNativePreflight({...pref,macProfile:{recipeID:'apple.verify-and-repair/1'}})).toBe(false);expect(registeredGraphicsPreflight({...pref,headRevision:'fake'})).toBe(false);
});
it('snapshot is returned to rendering only after size and original manifest hash match',async()=>{
 const bytes=Buffer.from('immutable PNG bytes'),sha256=createHash('sha256').update(bytes).digest('hex');
 const a={artifactId:'file-'+sha256,path:'snapshot.png',status:'AVAILABLE',mediaType:'image/png',size:bytes.length,sha256},wire={path:a.path,bytes:bytes.toString('base64'),sha256};
 expect(await verifiedGraphicsPNG(a,wire)).toMatch(/^data:image\/png;base64,/);
 await expect(verifiedGraphicsPNG({...a,size:bytes.length+1},wire)).rejects.toThrow('GRAPHICS_ARTIFACT_MISMATCH');
 await expect(verifiedGraphicsPNG(a,{...wire,bytes:Buffer.from('bad').toString('base64')})).rejects.toThrow('GRAPHICS_ARTIFACT_MISMATCH');
});

it('rejects unknown named Mac recipes while retaining strict unnamed Apple compatibility',()=>{
 const apple={projectId:'fixture',engineVersion:'1',optionsRevision:'options',engineId:'macos',profileId:'MAC_MANAGED',profileHome:null,loadsUserExtensions:false,headRevision:'committed-head',hasUncommittedChanges:false,workingCopyPolicy:'COMMITTED_BASE_ONLY'} as NativePreflight;
 expect(validNativePreflight(apple)).toBe(true);expect(validNativePreflight({...apple,macProfile:{recipeID:'apple.verify-and-repair/1'}})).toBe(true);
 for(const recipeID of ['future.mac/1','',null,17,['apple.verify-and-repair/1'],{}])expect(validNativePreflight({...apple,macProfile:{recipeID}})).toBe(false);
 expect(validNativePreflight({...apple,headRevision:null})).toBe(false);
});
