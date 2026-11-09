// Batch 2 supplement: workspace-session chrome + settings dirty guard.
// Attaches via CDP :9333; appends to the same output + manifest.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium}=webRequire('@playwright/test');
const OUT='E:/E2E-Test/electron/2026-11-04-01';
const report=JSON.parse(await readFile(`${OUT}/manifest.json`,'utf8').catch(()=>'{"shots":[],"skipped":[],"finds":[],"errors":[]}'));
const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
page.on('pageerror',e=>report.errors.push('pageerror: '+e.message));
const shot=async(group,name,desc)=>{
  await mkdir(`${OUT}/${group}`,{recursive:true});
  const file=`${group}/${name}.png`;
  await page.bringToFront().catch(()=>{});
  await page.screenshot({path:`${OUT}/${file}`,timeout:20000});
  report.shots.push({file,scenario:name,desc});
  console.log('shot:',file);
};
const find=n=>{report.finds.push(n);console.log('find:',n);};
const skip=(n,why)=>{report.skipped.push({id:n,reason:why});console.log('skip:',n,why);};
const visible=async(sel)=>(await page.locator(sel).first().isVisible().catch(()=>false));
const closePanes=async()=>{
  for(let i=0;i<4;i++){
    const done=await page.evaluate(()=>{
      let acted=false;
      const bd=document.querySelector('.pane-menu-backdrop');
      if(bd){bd.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));acted=true;}
      const el=[...document.querySelectorAll('[aria-label]')].find(e=>/^关闭(面板|目录面板|状态面板|导出面板|终端面板|任务详情|文件查看)$/.test(e.getAttribute('aria-label')||'')&&e.offsetParent!==null);
      if(el){el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));acted=true;}
      return !acted;
    });
    if(done)break;
    await page.waitForTimeout(300);
  }
};

// ---- workspace session: pick first session under a project group (petclinic) ----
await page.waitForTimeout(2500);
const projGroup=page.locator('.project-group.is-expanded').first();
const projSession=projGroup.locator('.session-row').first();
if(await projSession.count()){
  await projSession.click();
  await page.waitForTimeout(2500);
  await shot('C-conv','20-workspace-session','C1 工作区会话：项目上下文 + run 历史');
}else{
  // expand first project group
  const toggle=page.locator('.project-row-toggle').first();
  if(await toggle.count()){await toggle.click();await page.waitForTimeout(800);
    const row=page.locator('.project-group .session-row').first();
    if(await row.count()){await row.click();await page.waitForTimeout(2500);
      await shot('C-conv','20-workspace-session','C1 工作区会话');}
    else skip('workspace-session','项目组无会话');
  }else skip('workspace-session','无项目组');
}

// 2026-11-06: 低频面板按钮收进「面板」菜单，菜单关闭时 testid 不挂载
const openPaneItem=async(tid)=>{
  let btn=page.getByTestId(tid);
  if(!(await btn.count())){
    await page.getByTestId('conversation-header-panes').click().catch(()=>{});
    await page.waitForTimeout(300);
    btn=page.getByTestId(tid);
  }
  return btn;
};
// header buttons enabled state in workspace session
for(const [tid,file,desc] of [
  ['conversation-header-evidence','21-evidence-pane','C 证据 pane（工作区 run）'],
  ['conversation-header-terminal','22-terminal-pane','F1 终端面板（工作区会话）'],
  ['conversation-header-status','23-status-panel-ws','C 状态摘要（工作区 run）'],
]){
  await closePanes();
  const btn=await openPaneItem(tid);
  if(!(await btn.count())){skip(tid+'-ws','按钮缺失');continue;}
  if(await btn.isDisabled()){skip(tid+'-ws','disabled（'+(await btn.getAttribute('title')??'')+'）');continue;}
  await btn.click();await page.waitForTimeout(1600);
  await shot('C-conv',file,desc);
}
await closePanes();

// export drawer on a session that has messages
const expBtn=page.getByTestId('conversation-export-button');
if(await expBtn.count()&&!(await expBtn.isDisabled())){
  await page.evaluate(()=>{document.querySelector('[data-testid="conversation-export-button"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
  await page.waitForTimeout(1000);
  await shot('C-conv','24-export-drawer','N7 导出抽屉');
  await closePanes();
}else skip('export-drawer-ws','工作区会话导出仍不可用');

// diff strip in workspace session
if(await visible('[data-testid="composer-diff-strip"]'))
  await shot('C-conv','25-diff-strip','E8 composer 变更条');
else skip('diff-strip-ws','无终态 diff');

// terminal pane via header when enabled
const termBtn=await openPaneItem('conversation-header-terminal');
if(await termBtn.count()&&!(await termBtn.isDisabled())){
  await termBtn.click();await page.waitForTimeout(1800);
  await shot('C-conv','22-terminal-pane','F1 终端面板');
  const createBtn=page.locator('.terminal-pane button, [data-testid*="terminal"] button').filter({hasText:/启动|新建|PowerShell|创建/}).first();
  if(await createBtn.count()){await createBtn.click();await page.waitForTimeout(2500);
    await shot('C-conv','26-terminal-shell','F1 终端 shell 已启动');}
  await closePanes();
}

// attention tray open state
const tray=page.locator('details.activity-tray').first();
if(await tray.count()){
  if(!(await tray.evaluate(el=>el.open).catch(()=>false))){await tray.locator('summary').click().catch(()=>{});await page.waitForTimeout(600);}
  await shot('A-shell','11-activity-tray','A 活动托盘展开（48 最近 run 列表）');
}

// ---- settings dirty guard via real preference toggle ----
await page.locator('button[title="设置"]').first().click().catch(()=>{});
await page.waitForTimeout(1300);
const generalCat=page.locator('.settings-category').filter({hasText:'通用'}).first();
if(await generalCat.count()){
  await generalCat.click();await page.waitForTimeout(900);
  const t=page.getByTestId('preferences-notifications-toggle');
  if(await t.count()){
    await t.click();await page.waitForTimeout(400);
    const other=page.locator('.settings-category').filter({hasText:'外观'}).first();
    await other.click().catch(()=>{});
    await page.waitForTimeout(600);
    if(await visible('[data-testid="settings-nav-guard"], [data-testid="settings-exit-guard"]'))
      await shot('J-settings','21-dirty-guard','A8 未保存修改导航守卫');
    else{skip('dirty-guard','切换偏好后未出现守卫（可能已自动保存）');
      // restore value anyway
    }
    // stay, then cancel/discard to restore original value
    const stay=page.getByRole('button',{name:/留在本页|留在设置/}).first();
    if(await stay.count())await stay.click().catch(()=>{});
    await page.waitForTimeout(300);
    const cancel=page.getByRole('button',{name:/取消|放弃/}).first();
    if(await cancel.count())await cancel.click().catch(()=>{});
    else{const t2=page.getByTestId('preferences-notifications-toggle');if(await t2.count())await t2.click().catch(()=>{});}
    await page.waitForTimeout(300);
  }else skip('dirty-guard','notifications toggle 缺失');
}
// leave settings
const done=page.getByTestId('settings-done');
if(await done.count())await done.click().catch(()=>{});
await page.waitForTimeout(800);
await shot('N-misc','03-end','收尾态');

report.finishedAt=new Date().toISOString();
await writeFile(`${OUT}/manifest.json`,JSON.stringify(report,null,2));
console.log('DONE '+JSON.stringify({shots:report.shots.length,skipped:report.skipped.length,errors:report.errors.length}));
await b.close();
