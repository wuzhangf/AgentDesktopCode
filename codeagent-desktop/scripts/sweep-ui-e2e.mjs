// Full native-lane UI sweep: drive the running Electron (:9333) through the
// whole feature flow, screenshotting each state faithfully.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium,expect}=webRequire('@playwright/test');
const OUT='D:/E2E-Test/electron/2026-11-04-01';
await mkdir(OUT,{recursive:true});
const report={steps:[],shots:[],errors:[]};
const step=(n)=>{report.steps.push(n);console.log('step:',n);};
const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
page.on('pageerror',e=>report.errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')report.errors.push('console: '+m.text().slice(0,300));});
const shot=async(name)=>{await page.screenshot({path:`${OUT}/${name}.png`,fullPage:false});report.shots.push(name);};
const closeDialog=async()=>{
  const c=page.getByLabel('关闭任务详情');
  if(await c.count()){await c.first().click().catch(()=>{});await page.waitForTimeout(400);}
};
const createTask=async(projectLabel,instruction)=>{
  await page.getByLabel('原生任务诊断').click();
  await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible({timeout:30000});
  const idEl=page.getByTestId('task-id');
  const prevId=(await idEl.count()?await idEl.textContent():'')??'';
  await page.getByLabel('原生项目').selectOption({label:projectLabel});
  await page.waitForTimeout(1500);
  await page.getByLabel('原生任务要求').fill(instruction);
  await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
  for(let i=0;i<40;i++){
    const t=((await idEl.textContent())??'').trim();
    if(t.length>0&&t!==prevId.trim())break;
    await page.waitForTimeout(500);
  }
  const taskId=(await idEl.textContent()).trim();
  const row=page.getByTestId('native-task-row-'+taskId);
  await expect(row).toBeVisible({timeout:30000});
  await row.click();
  await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
  return taskId;
};

// 01 home
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(3000);
await shot('01-home');step('home');

// 02-05 create codep task with a file write (triggers tool activity)
await page.getByLabel('原生任务诊断').click();
await expect(page.getByRole('heading',{name:'原生任务',exact:true})).toBeVisible({timeout:30000});
await shot('02-native-diagnostics');
await page.getByLabel('原生项目').selectOption({label:'e2e-project'});
await page.waitForTimeout(2000);
await shot('03-project-engine');
await page.getByLabel('原生任务要求').fill('在 e2e-project 工作区创建文件 sweep-e2e.txt，内容写 "sweep test"，然后用一段中文说明你做了什么');
await shot('04-instruction');
const idEl=page.getByTestId('task-id');
const prevId=(await idEl.count()?await idEl.textContent():'')??'';
await page.getByRole('button',{name:'开始原生任务',exact:true}).click();
for(let i=0;i<40;i++){
  const t=((await idEl.textContent())??'').trim();
  if(t.length>0&&t!==prevId.trim())break;
  await page.waitForTimeout(500);
}
const taskId=(await idEl.textContent()).trim();
report.taskId=taskId;step('task-created '+taskId);
await shot('05-task-created');

// 10 running conversation
const row=page.getByTestId('native-task-row-'+taskId);
await expect(row).toBeVisible({timeout:30000});
await row.click();
await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:15000});
await page.waitForTimeout(5000);
await shot('10-running');step('running-shot');

// 12 status dialog (contains 执行过程 fold, expanded by default)
await page.getByRole('button',{name:'状态',exact:true}).first().click();
await page.waitForTimeout(1200);
await shot('12-status-dialog');step('status-dialog');
await closeDialog();

// 13 diagnostics dialog
await page.getByRole('button',{name:'诊断',exact:true}).first().click();
await page.waitForTimeout(1200);
await shot('13-diagnostics-dialog');step('diagnostics-dialog');
await closeDialog();

// 14 follow-up input while running
const taskState1=(await page.getByTestId('native-task-state').textContent()||'').trim();
report.stateAfterDialogs=taskState1;
if(!/中断|完成|失败/.test(taskState1)){
  const composer=page.locator('textarea').last();
  await composer.fill('请再补一句中文总结').catch(e=>report.errors.push('composer-fill: '+e.message));
  await shot('14-followup-draft');
  await page.locator('button[type="submit"]').last().click().catch(async()=>{
    await page.locator('button:has(svg)').last().click().catch(e=>report.errors.push('send: '+e.message));
  });
  await page.waitForTimeout(2500);
  await shot('15-followup-sent');step('followup-sent');
}else{step('task-ended-before-followup: '+taskState1);}

// wait for settle (up to 4 min), mid-stream shot along the way
let state='';
for(let i=0;i<96;i++){
  state=(await page.getByTestId('native-task-state').textContent()||'').trim();
  if(/已完成|失败|已中断/.test(state))break;
  if(i===25)await shot('16-mid-stream');
  await page.waitForTimeout(2500);
}
report.finalState=state;step('settled: '+state);
await page.waitForTimeout(1500);
await shot('20-settled');

// 21 provenance fold on first message
const prov=page.locator('details.native-message-diagnostics summary').first();
if(await prov.count()){await prov.click();await page.waitForTimeout(600);}
await shot('21-provenance');step('provenance');

// 22 artifacts section via 成果 action
await page.getByRole('button',{name:'成果',exact:true}).first().click().catch(e=>report.errors.push('artifacts-open: '+e.message));
await page.waitForTimeout(1000);
await shot('22-artifacts');step('artifacts-dialog');
await closeDialog();

// 30 stop-button flow on a second task
const taskId2=await createTask('e2e-project','Write a very long story about a lighthouse keeper. Prose only, no tools. At least 900 words.');
report.taskId2=taskId2;
await page.waitForTimeout(3500);
await shot('30-stop-visible');step('stop-visible');
if(await page.locator('[data-testid="native-stop"]').count()){
  await page.locator('[data-testid="native-stop"]').click();
  await page.waitForTimeout(6000);
  report.stopResult=(await page.getByTestId('native-task-state').textContent()||'').trim();
  await shot('31-stopped');step('stopped: '+report.stopResult);
}else{report.stopResult='no-button';step('no-stop-button');}

// 40 reopen first task — settled, must show no stream note
await row.click().catch(()=>{});
await page.waitForTimeout(3000);
report.streamNoteOnSettled=await page.locator('[data-testid="native-stream-note"]').count();
await shot('40-reopen-settled');step('reopen-settled note='+report.streamNoteOnSettled);

// 50 sidebar + activity rail
await shot('50-sidebar');
const act=page.locator('text=活动').first();
if(await act.count())await act.click().catch(()=>{});
await page.waitForTimeout(800);
await shot('51-activity-panel');step('done');

await writeFile(`${OUT}/result.json`,JSON.stringify(report,null,2));
console.log('DONE',JSON.stringify({steps:report.steps.length,errors:report.errors.length,finalState:report.finalState,stopResult:report.stopResult,streamNoteOnSettled:report.streamNoteOnSettled}));
await b.close();
