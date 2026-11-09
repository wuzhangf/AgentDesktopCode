import {test,expect} from '@playwright/test';
import {createServer} from 'node:http';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';

test('PC-N real Web → BFF → Worker → installed Pi → owned file and same-session continuation',async({page},info)=>{
  const java=process.env.PCN_JAVA,script=process.env.PCN_PI_SCRIPT,classpath=process.env.PCN_CLASSPATH_FILE;
  test.skip(!java||!script||!classpath,'Set explicit isolated native runtime paths');
  const root=resolve('.local/pcn/browser-'+randomUUID().slice(0,8));mkdirSync(root,{recursive:true});
  const repo=join(root,'canonical');mkdirSync(repo);const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'});
  git('init');writeFileSync(join(repo,'README.md'),'committed baseline\n');git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','Native fixture');writeFileSync(join(repo,'dirty.txt'),'not imported');
  let calls=0;const model=createServer(async(req,res)=>{
    const parts:Buffer[]=[];for await(const part of req)parts.push(part);const b=JSON.parse(Buffer.concat(parts).toString());calls++;
    const hasTool=b.messages.some((m:{role:string})=>m.role==='tool');res.writeHead(200,{'content-type':'text/event-stream'});
    const delta=hasTool?{content:'Native browser fixture finished.'}:{tool_calls:[{index:0,id:'native-file',type:'function',function:{name:'write',arguments:JSON.stringify({path:'native-result.txt',content:'written by installed Pi\n'})}}]};
    for(const [d,finish]of [[delta,null],[{},hasTool?'stop':'tool_calls']])res.write('data: '+JSON.stringify({id:'native-fixture',object:'chat.completion.chunk',created:1,model:'fixture-model',choices:[{index:0,delta:d,finish_reason:finish}]})+'\n\n');res.end('data: [DONE]\n\n');
  });await new Promise<void>(done=>model.listen(0,'127.0.0.1',done));const modelPort=(model.address() as {port:number}).port;
  const profile=join(root,'profile');mkdirSync(profile);writeFileSync(join(profile,'models.json'),JSON.stringify({providers:{fixture:{baseUrl:`http://127.0.0.1:${modelPort}/v1`,api:'openai-completions',apiKey:'fixture-no-auth',models:[{id:'fixture-model',contextWindow:64000,maxTokens:1024}]}}}));writeFileSync(join(profile,'settings.json'),JSON.stringify({defaultProvider:'fixture',defaultModel:'fixture-model',packages:[]}));
  const cp=readFileSync(classpath!,'utf8').trim(),main=['-cp',cp,'com.sage.agentworker.launcher.WorkerLocalTaskMain'],state=join(root,'worker');
  execFileSync(java!,[...main,'init','--state',state,'--engine','pi','--executable',process.execPath,'--script',script!,'--profile-home',profile,'--project-id','fixture-project','--project',repo,'--confirm-user-profile','true'],{stdio:'pipe'});
  const token=randomUUID()+randomUUID();const env:NodeJS.ProcessEnv={};for(const [key,value]of Object.entries(process.env))if(['PATH','PATHEXT','SYSTEMROOT','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA'].includes(key.toUpperCase()))env[key]=value;
  let native:ChildProcess|undefined,bff:ChildProcess|undefined;let nativeLog='',bffLog='';
  async function stop(child?:ChildProcess){if(!child||child.exitCode!==null)return;const done=new Promise<void>(resolve=>child!.once('exit',()=>resolve()));child.kill();await Promise.race([done,new Promise<void>(resolve=>setTimeout(resolve,10000))]);if(child.exitCode===null)child.kill('SIGKILL');}
  try{
    native=spawn(java!,[...main,'serve','--state',state],{env:{...env,WORKER_LOCAL_TOKEN:token},stdio:['ignore','pipe','pipe']});native.stdout!.on('data',b=>nativeLog+=b);native.stderr!.on('data',b=>nativeLog+=b);
    await expect.poll(()=>nativeLog.match(/LOCAL_TASK_READY (http:\/\/127.0.0.1:\d+)/)?.[1],{timeout:20000}).toBeTruthy();const nativeUrl=nativeLog.match(/LOCAL_TASK_READY (http:\/\/127.0.0.1:\d+)/)![1]!;
    const sourceProjects=await fetch(nativeUrl+'/local/v1/projects',{headers:{authorization:'Bearer '+token}});expect(await sourceProjects.json()).toHaveProperty('items');expect(sourceProjects.status).toBe(200);
    const probe=createServer();await new Promise<void>(done=>probe.listen(0,'127.0.0.1',done));const port=(probe.address() as {port:number}).port;await new Promise<void>(done=>probe.close(()=>done()));
    const url=`http://127.0.0.1:${port}`;
    bff=spawn(process.execPath,[resolve('.local/management-server/management-server.mjs')],{cwd:process.cwd(),env:{...env,PERSONAL_WORKER_LOCAL_URL:nativeUrl,WORKER_LOCAL_TOKEN:token,PERSONAL_CONSOLE_PORT:String(port),PERSONAL_CONSOLE_ROOT:join(root,'console'),PERSONAL_DATA_DIR:join(root,'bff'),PERSONAL_REPORTS_ENABLED:'0',NODE_NO_WARNINGS:'1'},stdio:['ignore','pipe','pipe']});bff.stdout!.on('data',b=>bffLog+=b);bff.stderr!.on('data',b=>bffLog+=b);
    await expect.poll(async()=>{try{return(await fetch(url+'/personal.html')).status;}catch{return 0;}},{timeout:20000}).toBe(200);
    await page.goto(url+'/personal.html#/tasks');await expect(page.getByLabel('项目',{exact:true}).locator('option',{hasText:'fixture-project'})).toBeAttached();
    const selected=await page.getByLabel('项目',{exact:true}).locator('option',{hasText:'fixture-project'}).getAttribute('value');await page.getByLabel('项目',{exact:true}).selectOption(selected!);
    await expect(page.getByLabel('原生程序')).toHaveValue('pi');await page.getByLabel('任务要求',{exact:true}).fill('Create native-result.txt with the write tool and report completion.');await expect(page.getByRole('button',{name:'开始任务',exact:true})).toBeEnabled();await page.getByRole('button',{name:'开始任务',exact:true}).click();await page.waitForURL(/#\/tasks\/task-/);
    await expect(page.getByText('状态：已完成',{exact:true})).toBeVisible({timeout:30000});await expect(page.getByText('Native browser fixture finished.',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'暂停',exact:true})).toHaveCount(0);expect(calls).toBe(2);
    await page.getByLabel('原生任务补充').fill('Confirm completion again in the same session.');await page.getByRole('button',{name:'下一轮继续',exact:true}).click();await expect(page.getByRole('button',{name:'确认回执，继续操作'})).toBeVisible();
    await page.reload();await expect(page.getByRole('button',{name:'只读核对原请求'})).toBeVisible();await page.getByRole('button',{name:'只读核对原请求'}).click();await page.getByRole('button',{name:'确认回执，继续操作'}).click();await expect(page.getByText('状态：已完成',{exact:true})).toBeVisible();expect(calls).toBe(3);
    await page.getByRole('button',{name:'停止原生任务',exact:true}).click();await expect(page.getByRole('button',{name:'只读核对停止请求'})).toBeVisible();await expect(page.getByText(/native-result.txt · AVAILABLE/)).toBeVisible({timeout:15000});
    const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载文件',exact:true}).click();const file=await download;expect(readFileSync((await file.path())!,'utf8')).toBe('written by installed Pi\n');
    expect(readFileSync(join(repo,'README.md'),'utf8')).toBe('committed baseline\n');expect(readFileSync(join(repo,'dirty.txt'),'utf8')).toBe('not imported');
    await page.screenshot({path:info.outputPath('native-task-bottom.png'),fullPage:true});await page.getByText('PI 原生任务',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath('native-task.png'),fullPage:true});writeFileSync(info.outputPath('native-evidence.json'),JSON.stringify({result:'PASS',chain:'Browser/BFF/Worker/installed Pi/local model/native write',modelRequests:calls,originalRequestReload:true,artifactBytesVerified:true},null,2));
  }finally{await stop(bff);await stop(native);await new Promise<void>(done=>model.close(()=>done()));writeFileSync(info.outputPath('native-host.log'),nativeLog);writeFileSync(info.outputPath('native-bff.log'),bffLog);}
});
