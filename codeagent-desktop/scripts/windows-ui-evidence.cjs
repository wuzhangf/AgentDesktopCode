const fs=require('node:fs');
const {bounded}=require('./windows-verification-runtime.cjs');
function validPng(bytes){return bytes.length>=24&&bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a'&&bytes.readUInt32BE(16)>=32&&bytes.readUInt32BE(20)>=32;}
// Keep real pixel evidence mandatory. A compositor-surface timeout can use
// Chromium's view capture instead; if both fail the business attempt fails.
async function captureEvidence(page,destination,primary=()=>page.screenshot({path:destination,timeout:10000})){
 try{await bounded('PRIMARY_CAPTURE',10000,primary);if(!validPng(fs.readFileSync(destination)))throw Error('INVALID_PRIMARY_CAPTURE');return {method:'playwright',path:destination};}
 catch(error){
  let session,timer;
  try{
   session=await bounded('CDP_SESSION',5000,()=>page.context().newCDPSession(page));
   const value=await Promise.race([session.send('Page.captureScreenshot',{format:'png',fromSurface:false,captureBeyondViewport:false}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('VIEW_CAPTURE_TIMEOUT')),15000);})]);
   const bytes=Buffer.from(value.data,'base64');
   if(!validPng(bytes))throw Error('INVALID_VIEW_CAPTURE');
   fs.writeFileSync(destination,bytes);return {method:'cdp-view',path:destination,primaryError:error.message};
  }catch(viewError){throw Error('PIXEL_EVIDENCE_FAILED: primary='+error.message+'; view='+viewError.message);}
  finally{clearTimeout(timer);if(session)await bounded('CDP_DETACH',2000,()=>session.detach()).catch(()=>{});}
 }
}
module.exports={captureEvidence};
