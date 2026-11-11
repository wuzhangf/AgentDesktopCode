// A loopback Responses protocol fixture, never a replacement for live-model qualification.
const http=require('node:http'),crypto=require('node:crypto');
async function startModelFixture({fault='none'}={}){
 if(!['none','disconnect-once','disconnect-always','stream-disconnect'].includes(fault))throw Error('INVALID_MODEL_FIXTURE_FAULT');
 const evidence={kind:'LOCAL_RESPONSES_FIXTURE',fault,requests:0,disconnects:0,tools:[]};
 const server=http.createServer(async(req,res)=>{try{
  const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks));evidence.requests++;
  if(fault==='disconnect-always'||fault==='disconnect-once'&&evidence.disconnects===0){evidence.disconnects++;evidence.disconnectPhase='BEFORE_HEADERS';req.socket.destroy();return;}
  if(fault==='stream-disconnect'){evidence.disconnects++;evidence.disconnectPhase='SSE_BEFORE_COMPLETION';res.writeHead(200,{'content-type':'text/event-stream'});res.end('event: response.created\ndata: '+JSON.stringify({type:'response.created',sequence_number:0,response:{id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'in_progress',output:[]}})+'\n\n');return;}
  const input=body.input??[];
  const text=input.filter(x=>x.role==='user').flatMap(x=>typeof x.content==='string'?[x.content]:(x.content??[]).map(c=>c.text??'')).join('\n');
  const script=text.match(/PowerShell script: (.*?) \. Once/s)?.[1]??text.match(/Script: (.*)$/s)?.[1];
  if(!script)throw Error('FIXTURE_EXACT_SCRIPT_NOT_FOUND');
  const complete=input.some(x=>x.type==='function_call_output');
  const tool=(body.tools??[]).find(x=>['shell_command','exec_command','shell'].includes(x.name));
  if(!complete&&!tool)throw Error('FIXTURE_SHELL_TOOL_NOT_FOUND:'+(body.tools??[]).map(x=>x.name).join(','));
  let item;
  if(complete)item={id:'msg_'+crypto.randomUUID(),type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'Fixture operation completed or declined.',annotations:[]}]};
  else{
   evidence.tools.push({name:tool.name,required:tool.parameters?.required});
   const args=tool.name==='shell'?{command:['powershell.exe','-NoProfile','-Command',script]}:tool.name==='exec_command'?{cmd:script}:{command:script};
   args.sandbox_permissions='require_escalated';args.justification='Run the exact owned verification script after explicit approval.';
   item={id:'fc_'+crypto.randomUUID(),type:'function_call',call_id:'call_'+crypto.randomUUID(),name:tool.name,arguments:JSON.stringify(args),status:'completed'};
  }
  res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});let seq=0;
  const response={id:'resp_'+crypto.randomUUID(),object:'response',created_at:Math.floor(Date.now()/1000),model:body.model,status:'in_progress',output:[]};
  const emit=(type,data)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:seq++,...data})+'\n\n');
  emit('response.created',{response});emit('response.output_item.added',{output_index:0,item:{...item,...(item.type==='function_call'?{arguments:''}:{content:[]})}});
  if(item.type==='function_call'){emit('response.function_call_arguments.delta',{item_id:item.id,output_index:0,delta:item.arguments});emit('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});}
  else {emit('response.content_part.added',{item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});emit('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});emit('response.output_text.done',{item_id:item.id,output_index:0,content_index:0,text:item.content[0].text});emit('response.content_part.done',{item_id:item.id,output_index:0,content_index:0,part:item.content[0]});}
  emit('response.output_item.done',{output_index:0,item});emit('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
 }catch(e){evidence.error=e.message;res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:e.message,type:'fixture_error'}}));}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port+'/v1',evidence,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));}};
}
module.exports={startModelFixture};
