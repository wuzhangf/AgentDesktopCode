// Scenario-grouped UI screenshot sweep for codeagent-desktop — 2026-11-05 batch 1.
// Attaches to the running Electron via CDP :9333 and captures every reachable
// surface/pane/dialog state, organized under E:/E2E-Test/electron/2026-11-04-01/<group>/
// for downstream UI-audit review. manifest.json maps each shot to its scenario.
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium}=webRequire('@playwright/test');
const OUT='E:/E2E-Test/electron/2026-11-04-01';
const report={startedAt:new Date().toISOString(),shots:[],skipped:[],finds:[],errors:[]};
const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
page.on('pageerror',e=>report.errors.push('pageerror: '+e.message));
page.on('console',m=>{if(m.type()==='error')report.errors.push('console: '+m.text().slice(0,300));});

const shot=async(group,name,desc)=>{
  await mkdir(`${OUT}/${group}`,{recursive:true});
  const file=`${group}/${name}.png`;
  const snap=async()=>{await page.bringToFront().catch(()=>{});await page.screenshot({path:`${OUT}/${file}`,timeout:20000});};
  try{await snap();}
  catch(e){
    report.errors.push('shot-retry '+file+': '+String(e.message).slice(0,120));
    await page.waitForTimeout(1500);
    await snap();
  }
  report.shots.push({file,scenario:name,desc});
  console.log('shot:',file);
};
const find=n=>{report.finds.push(n);console.log('find:',n);};
const skip=(n,why)=>{report.skipped.push({id:n,reason:why});console.log('skip:',n,why);};
const txt=async(sel)=>((await page.locator(sel).first().textContent().catch(()=>''))??'').trim();
const visible=async(sel)=>(await page.locator(sel).first().isVisible().catch(()=>false));
const count=async(sel)=>await page.locator(sel).count();

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
const goWorkspace=async()=>{
  for(const n of ['返回','完成']){
    const btn=page.getByRole('button',{name:n,exact:true}).first();
    if(await btn.count())await btn.click().catch(()=>{});
    await page.waitForTimeout(300);
  }
  await page.locator('button[title="会话"]').first().click().catch(()=>{});
  await page.waitForTimeout(800);
  await closePanes();
};

// ============ A. shell & navigation ============
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(4000);
await shot('A-shell','01-home','A1 首屏：问候语 + 新会话表单 + 侧栏');
const railSections=await page.locator('.rail-section').allTextContents();
find('rail-sections: '+railSections.map(s=>s.slice(0,20)).join(' | '));
await shot('A-shell','02-sidebar','A1 侧栏：项目/普通对话/原生任务分组 + 活动托盘 + 底部导航');

await page.getByLabel('更多会话栏操作').click().catch(()=>{});
await page.waitForTimeout(500);
await shot('A-shell','03-rail-menu','A3 rail-menu：视图切换 + 显示已归档');
const archChk=page.getByRole('menuitemcheckbox').locator('input');
if(await archChk.count()){
  await archChk.check().catch(()=>{});
  await page.waitForTimeout(700);
  await shot('A-shell','04-archived-on','A3 显示已归档勾选后的会话列表');
  await archChk.uncheck().catch(()=>{});
  await page.waitForTimeout(400);
}
await page.evaluate(()=>{document.querySelector('.pane-menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));});
await page.waitForTimeout(400);

// RECENT (按时间) view — menu items observed: 按项目 / 按时间 / 全部折叠项目
const byTime=page.locator('.rail-menu').getByText('按时间').first();
if(await byTime.count()){await byTime.click().catch(()=>{});await page.waitForTimeout(600);}
else{
  await page.getByLabel('更多会话栏操作').click().catch(()=>{});
  await page.waitForTimeout(400);
  const retry=page.locator('.rail-menu').getByText('按时间').first();
  if(await retry.count())await retry.click().catch(()=>{});
  await page.waitForTimeout(600);
}
await shot('A-shell','05-recent-view','B8 按时间视图分组（今天/本周/更早）');
await page.getByLabel('更多会话栏操作').click().catch(()=>{});
await page.waitForTimeout(400);
const byProj=page.locator('.rail-menu').getByText('按项目').first();
if(await byProj.count()){await byProj.click().catch(()=>{});await page.waitForTimeout(500);}
await page.evaluate(()=>{document.querySelector('.pane-menu-backdrop')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));});

// Ctrl+B collapse rail — only if not already collapsed
const railCollapsed=await page.evaluate(()=>document.querySelector('.workbench')?.classList.contains('rail-collapsed')??false);
if(!railCollapsed){
  await page.keyboard.press('Control+b');
  await page.waitForTimeout(600);
}
await shot('A-shell','06-rail-collapsed','A4 Ctrl+B 收起会话栏');
await page.keyboard.press('Control+b');
await page.waitForTimeout(500);

// bottom nav surfaces
for(const [title,file,desc] of [
  ['Git','07-nav-git','A2 Git surface 入口（无选中 run 时总览/空态）'],
  ['个人接入','08-nav-personal-access','A2/L 个人接入 surface'],
  ['原生任务诊断','09-nav-native-diag','A2/M 原生任务诊断 surface'],
]){
  await page.locator(`button[title="${title}"]`).first().click().catch(()=>{});
  await page.waitForTimeout(1300);
  await shot('A-shell',file,desc);
  await goWorkspace();
}
const attnBtn=page.locator('button[title^="待处理"]');
if(await attnBtn.count()){
  await attnBtn.first().click();
  await page.waitForTimeout(1000);
  await shot('A-shell','10-attention','A2 待处理 surface');
  await goWorkspace();
}else skip('ATTENTION','无待处理项，导航隐藏');

// ============ B. new-session launcher ============
await goWorkspace();
await page.getByRole('button',{name:/新建会话/}).first().click().catch(()=>{});
await page.waitForTimeout(900);
await shot('B-session','01-new-default','B2 新会话表单默认态（智能体会话）');
const sourceWrap=page.getByTestId('new-session-source');
if(await sourceWrap.count()){
  const nativeRadio=sourceWrap.getByRole('radio',{name:'原生任务'});
  if(await nativeRadio.count()){
    await nativeRadio.click();await page.waitForTimeout(1200);
    await shot('B-session','02-source-native','B3 原生任务启动器（engine/project/instruction）');
    await sourceWrap.getByRole('radio',{name:'智能体会话'}).click().catch(()=>{});
    await page.waitForTimeout(600);
  }
}else skip('new-session-source','个人通道不可用，无来源切换');
const projSel=page.getByTestId('new-session-project');
if(await projSel.count()){
  const opts=await projSel.locator('option').allTextContents();
  find('new-session-projects: '+opts.join('|'));
  if(opts.length>1){
    await projSel.selectOption({index:1});
    await page.waitForTimeout(1800);
    await shot('B-session','03-workspace-selected','B3 选中工作区：preflight 后智能体/模型/只读研究出现');
    const profSel=page.getByLabel('专业智能体');
    if(await profSel.count()){
      const popts=await profSel.locator('option').allTextContents();
      find('agent-profiles: '+popts.join('|'));
      if(popts.length>1){await profSel.selectOption({index:1});await page.waitForTimeout(500);
        await shot('B-session','04-profile-selected','B3 专业智能体选中态（描述 + 只读研究默认）');}
    }
    const modelSel=page.getByTestId('new-session-model-selector');
    if(await modelSel.count()){
      await modelSel.click().catch(()=>{});
      await page.waitForTimeout(600);
      await shot('B-session','05-model-menu','B3 模型选择器展开');
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
    }
    await projSel.selectOption({index:0}).catch(()=>{});
    await page.waitForTimeout(400);
  }
}else skip('new-session-project','无已注册项目，项目下拉缺失');

// fill goal but submit only a trivial prompt → creates one cheap chat session
await page.getByLabel('说说想做什么').fill('用一句中文自我介绍，说明你能做什么。').catch(()=>{});
await shot('B-session','06-goal-filled','B3 目标输入 + 发送键可用');
await page.getByRole('button',{name:/开始会话|开始聊天/}).click().catch(()=>{});
await page.waitForTimeout(2500);
await shot('B-session','07-session-created','C1 会话创建后：pending turn / 初始运行状态');
for(let i=0;i<90;i++){
  const stopping=await page.locator('button[aria-label="终止运行"]').count();
  const queued=await page.locator('button[aria-label="排队发送"]').count();
  if(!stopping&&!queued)break;
  if(i===10)await shot('B-session','08-run-running','C1 运行中：RunStatusBar + 活动流');
  await page.waitForTimeout(2500);
}
await page.waitForTimeout(1500);
await shot('B-session','09-run-settled','C1 运行结束：回复消息 + run 块终态');
const newSessionId=await page.evaluate(()=>{const el=document.querySelector('.session-row.selected');return el?el.textContent?.slice(0,40):null;});
find('created-session: '+(newSessionId??'unknown'));

// ============ C. conversation chrome ============
// pick a session that has messages — the one just created works
await shot('C-conv','01-conversation','C1/C7 会话视图：消息 + run 块 + composer');
// reasoning fold if present
const reasoning=page.getByTestId('message-reasoning');
if(await reasoning.count()){await reasoning.first().locator('summary').click().catch(()=>{});await page.waitForTimeout(400);
  await shot('C-conv','02-reasoning-open','C7 reasoning 折叠块展开');}

// composer footer controls
const dirChip=page.locator('button.directory-trigger').first();
if(await dirChip.count()){
  await dirChip.click();await page.waitForTimeout(1000);
  await shot('C-conv','03-directory-panel','C 目录浮动面板（会话目录授权）');
  await dirChip.click().catch(()=>{});await page.waitForTimeout(300);
}else skip('directory-trigger','目录 chip 缺失');
// permission mode menu
const permBtn=page.locator('.composer-footer button:has-text("标准"), .composer-footer button:has-text("权限"), .permission-mode-trigger, [data-testid*="permission"]').first();
const permAny=await page.locator('.composer-footer button').allTextContents().catch(()=>[]);
find('composer-footer-buttons: '+permAny.map(s=>s.trim().slice(0,14)).join('|'));
const permChip=page.locator('.composer-footer .composer-chip, .composer-footer button').filter({hasText:/标准|全自动|完全/}).first();
if(await permChip.count()){await permChip.click().catch(()=>{});await page.waitForTimeout(600);
  await shot('C-conv','04-permission-menu','D5 权限模式菜单（含锁定项/激活态）');
  await page.keyboard.press('Escape');await page.waitForTimeout(300);
}else skip('permission-menu','未找到权限模式入口');
// extension picker
const extBtn=page.locator('.composer-footer button').filter({hasText:/扩展|MCP|skill/i}).first();
const extPicker=page.locator('[data-testid*="extension"], .extension-selection-picker button, .composer-footer .composer-icon').nth(1);
if(await extPicker.count()){
  await extPicker.click().catch(()=>{});await page.waitForTimeout(600);
  await shot('C-conv','05-extension-picker','C10 逐轮扩展选择器');
  await page.keyboard.press('Escape');await page.waitForTimeout(300);
}else skip('extension-picker','扩展选择器入口缺失');
// composer model selector
const compModel=page.getByTestId('composer-model-selector');
if(await compModel.count()){
  await compModel.click().catch(()=>{});await page.waitForTimeout(600);
  await shot('C-conv','06-composer-model','C 会话级模型选择器（reasoning/context 子项）');
  await page.keyboard.press('Escape');await page.waitForTimeout(300);
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
// conversation header buttons: git/status/evidence/terminal/export/collaboration
for(const [tid,file,desc] of [
  ['conversation-header-status','07-status-panel','C 状态摘要面板（ActivitySummaryPanel）'],
  ['conversation-header-evidence','08-evidence-pane','C 证据 pane（EvidenceLayers）'],
  ['conversation-header-terminal','09-terminal-pane','F1 终端面板初始态'],
  ['conversation-header-git','10-git-pane','E1 Git 总览 pane'],
]){
  await closePanes();
  const btn=await openPaneItem(tid);
  if(!(await btn.count())){skip(tid,'按钮缺失');continue;}
  if(await btn.isDisabled()){skip(tid,'disabled（'+(await btn.getAttribute('title')??'')+'）');continue;}
  await btn.click();await page.waitForTimeout(1600);
  await shot('C-conv',file,desc);
}
await closePanes();
// terminal: try create shell + echo
const termInput=page.locator('.terminal-pane input, [data-testid*="terminal"] input').first();
const termCreate=page.getByRole('button',{name:/启动|新建|开始.*终端|PowerShell/i}).first();
if(await termCreate.count()){
  await termCreate.click().catch(()=>{});
  await page.waitForTimeout(2500);
  await shot('C-conv','11-terminal-created','F1 终端会话已创建（xterm 渲染）');
  const xterm=page.locator('.terminal-pane .xterm, .xterm').first();
  if(await xterm.count()){
    await xterm.click().catch(()=>{});
    await page.keyboard.type('echo sweep-terminal-check\n',{delay:10});
    await page.waitForTimeout(1200);
    await shot('C-conv','12-terminal-echo','F1 终端输入回显');
  }
}else skip('terminal-create','终端创建按钮未找到（可能已存在会话或不支持）');
await closePanes();
// export drawer
const expBtn=page.getByTestId('conversation-export-button');
if(await expBtn.count()&&!(await expBtn.isDisabled())){
  await page.evaluate(()=>{document.querySelector('[data-testid="conversation-export-button"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));});
  await page.waitForTimeout(1000);
  await shot('C-conv','13-export-drawer','N7 导出抽屉（格式选项）');
  await closePanes();
}else skip('export','导出按钮缺失/disabled');
// collaboration details fold
const collab=page.locator('details.collaboration-panel, .collaboration-panel').first();
if(await collab.count()){
  const summary=collab.locator('summary').first();
  if(await summary.count()){await summary.click().catch(()=>{});await page.waitForTimeout(600);}
  await shot('C-conv','14-collaboration-panel','H1 协作面板展开');
}else skip('collaboration','协作面板不存在');
// composer diff strip
if(await visible('[data-testid="composer-diff-strip"]'))
  await shot('C-conv','15-diff-strip','E8 composer 变更条');
else skip('diff-strip','无终态 run 或无 diff');
// approval area if any
if(await visible('[data-testid="approval-panel"]'))
  await shot('C-conv','16-approval','D1 待审批卡片');
else skip('approval-panel','当前无待审批');

// ============ E. git surface ============
await goWorkspace();
const tray=page.locator('details.activity-tray').first();
if(await tray.count()&&!(await tray.evaluate(el=>el.open).catch(()=>false))){
  await tray.locator('summary').click().catch(()=>{});
  await page.waitForTimeout(600);
}
const trayRun=page.locator('.run-list .run-select').first();
if(await trayRun.count()&&await trayRun.isVisible().catch(()=>false)){
  await trayRun.click();await page.waitForTimeout(1500);
}else{
  await page.locator('button[title="Git"]').first().click().catch(()=>{});
  await page.waitForTimeout(1500);
}
await shot('E-git','01-git-surface','E1 Git surface：run 上下文 + DIFF/WORKSPACE tab');
const wsTab=page.getByRole('button',{name:/工作区|WORKSPACE/i}).or(page.locator('.git-surface-page button').filter({hasText:/工作区/})).first();
if(await wsTab.count()){
  await wsTab.click();await page.waitForTimeout(1200);
  await shot('E-git','02-workspace-tab','E3 workspace executions（worktree/handoff/reclaim 入口）');
}
const diffTab=page.locator('.git-surface-page button').filter({hasText:/变更|DIFF/i}).first();
if(await diffTab.count()){await diffTab.click();await page.waitForTimeout(1000);}
const diffRow=page.locator('.git-changes-page [role="button"], .git-changes-page li, .diff-file-row').first();
if(await diffRow.count()){
  await diffRow.click().catch(()=>{});
  await page.waitForTimeout(900);
  if(await visible('[aria-label="文件查看"]'))
    await shot('E-git','03-file-ref-dialog','E2 FileReferenceDialog 只读文件查看');
  else await shot('E-git','03-diff-detail','E1 diff 详情展开');
  await closePanes();
}
await goWorkspace();

// ============ G. missions ============
// needs a selected session; use the one created above
const firstSession=page.locator('.session-row').first();
if(await firstSession.count()){
  await firstSession.click();await page.waitForTimeout(1200);
}
const missionNav=page.locator('button[title="任务"], button[title="任务编排"]').first();
// missions surface is reachable only via... check rail nav; MISSIONS isn't in bottom nav — find any entry
// per code, surface set via onOpenMissions (command palette — dead) or... check for a header button
const missionBtn=page.locator('[title*="任务"], [aria-label*="任务"]').filter({hasNotText:/原生|待处理/}).first();
find('mission-nav-candidates: '+(await missionBtn.count()));
// try direct: MISSIONS surface has no nav button? — record
// (the only setter found in code paths is the dead CommandPalette + pane MISSION which is also unwired)
skip('MISSIONS','surface 无可达入口（nav 中无任务项，命令面板死代码）— 已登记为缺失');

// ============ J. settings 13 pages ============
await page.locator('button[title="设置"]').first().click().catch(()=>{});
await page.waitForTimeout(1400);
await shot('J-settings','01-overview','J1 设置·概览');
const cats=page.locator('.settings-category');
const catCount=await cats.count();
find('settings-categories: '+catCount);
const catNames=await cats.allTextContents();
const routeSlug=['general','appearance','models','permissions','projects-sessions','privacy','knowledge','extensions','features','service','runtime','diagnostics','about'];
for(let i=0;i<catCount;i++){
  const name=(catNames[i]??'').trim();
  await cats.nth(i).click();
  await page.waitForTimeout(1100);
  await shot('J-settings',`${String(i+2).padStart(2,'0')}-${routeSlug[i]??'page-'+i}`,`J 设置页·${name}`);
}
// settings search
const sInput=page.getByTestId('settings-search');
if(await sInput.count()){
  await sInput.fill('模型');
  await page.waitForTimeout(500);
  await shot('J-settings','20-search','J15 设置本地搜索（仅路由元数据）');
  await sInput.fill('');
  await page.waitForTimeout(300);
}
// dirty guard: toggle terminal autostart (localStorage-only, safe) then try nav
const generalCat=page.locator('.settings-category').filter({hasText:'通用'}).first();
if(await generalCat.count()){
  await generalCat.click();await page.waitForTimeout(900);
  const t=page.getByTestId('preferences-terminal-autostart-toggle');
  if(await t.count()){
    await t.click();await page.waitForTimeout(300);
    const other=page.locator('.settings-category').filter({hasText:'外观'}).first();
    await other.click().catch(()=>{});
    await page.waitForTimeout(500);
    if(await visible('[data-testid="settings-nav-guard"]'))
      await shot('J-settings','21-dirty-guard','A8 未保存修改导航守卫');
    await page.getByRole('button',{name:'留在本页'}).click().catch(()=>{});
    await page.waitForTimeout(300);
    // discard: click the toggle back + cancel save
    const cancel=page.getByRole('button',{name:/取消|放弃/}).first();
    if(await cancel.count())await cancel.click().catch(()=>{});
    else await t.click().catch(()=>{});
    await page.waitForTimeout(300);
  }
}
// appearance preview — theme switch visual (read-only shot, no save)
const appearCat=page.locator('.settings-category').filter({hasText:'外观'}).first();
if(await appearCat.count()){
  await appearCat.click();await page.waitForTimeout(900);
  const darkOpt=page.locator('input[type="radio"],select,button').filter({hasText:/深色|DARK/i}).first();
  if(await darkOpt.count()){await darkOpt.click().catch(()=>{});await page.waitForTimeout(700);
    await shot('J-settings','22-theme-dark-preview','J3 主题预览即时生效（未保存）');
    const lightOpt=page.locator('input[type="radio"],select,button').filter({hasText:/跟随系统|SYSTEM/i}).first();
    if(await lightOpt.count())await lightOpt.click().catch(()=>{});
    const cancelBtn=page.getByRole('button',{name:/取消|放弃/}).first();
    if(await cancelBtn.count())await cancelBtn.click().catch(()=>{});
    await page.waitForTimeout(400);
  }
}

// ============ K. extensions surface ============
await goWorkspace();
// EXTENSIONS surface has no bottom-nav entry either — reachable via Settings EXTENSIONS page link or dead palette?
// code: setActiveSurface('EXTENSIONS') callers: SettingsSurface context.onOpenExtensions + dead palette.
// Settings EXTENSIONS page likely has an entry button.
const extPageCat=page.locator('.settings-category').filter({hasText:'扩展'}).first();
// we're inside settings; use it
if(await extPageCat.count()){
  await extPageCat.click();await page.waitForTimeout(900);
  const openBtn=page.getByRole('button',{name:/打开|管理|进入.*扩展|扩展工作台/}).first();
  const btns=await page.locator('.settings-content button').allTextContents();
  find('settings-extensions-buttons: '+btns.map(s=>s.trim().slice(0,16)).join('|'));
  if(await openBtn.count()){await openBtn.click();await page.waitForTimeout(1500);}
}
// if still inside settings, try done then evaluate activeSurface fallback
if(await visible('[data-testid="settings-center"]')){
  const done=page.getByTestId('settings-done');
  if(await done.count())await done.click().catch(()=>{});
  await page.waitForTimeout(800);
}
if(await visible('.extensions-screen')){
  await shot('K-ext','01-extensions-surface','K 扩展 surface 总览（MCP/Skills/Hooks/证据）');
  // scroll through the grid
  await page.evaluate(()=>{document.querySelector('.extensions-screen')?.scrollTo({top:600});});
  await page.waitForTimeout(300);
  await shot('K-ext','02-extensions-scrolled','K 扩展 surface 下段');
  // MCP governed panel: try expanding add-server form for audit shot
  const addMcp=page.getByRole('button',{name:/添加|新增.*(MCP|服务)|新建.*服务/}).first();
  if(await addMcp.count()){await addMcp.click().catch(()=>{});await page.waitForTimeout(600);
    await shot('K-ext','03-mcp-add-form','K1 MCP 新增服务器表单');
    await page.keyboard.press('Escape');}
}else skip('EXTENSIONS','surface 不可达（唯一入口在死代码命令面板 / Settings 扩展页入口缺失）');

// ============ L. personal access ============
await goWorkspace();
await page.locator('button[title="个人接入"]').first().click().catch(()=>{});
await page.waitForTimeout(1300);
await shot('L-pac','01-personal-access','L 个人接入 surface 当前态');
const bindBtn=page.getByRole('button',{name:'连接设置'}).first();
if(await bindBtn.count()){await bindBtn.click();await page.waitForTimeout(600);
  await shot('L-pac','02-binding-form','L1 连接设置表单（origin/basePath/CA/token）');}

// ============ M. native lane ============
await goWorkspace();
const nativeRows=page.locator('[data-testid^="native-task-row-"]');
const nCount=await nativeRows.count();
find('native-task-rows: '+nCount);
if(nCount>0){
  await nativeRows.first().click();
  await page.waitForTimeout(2200);
  await shot('M-native','01-native-conversation','M2 原生任务会话（transcript/活动/模型 chip）');
  for(const[btnName,file,desc]of[['状态','02-native-status','M4 状态详情对话框'],['成果','03-native-artifacts','M3 成果列表+核验/保存'],['诊断','04-native-diag','M4 诊断 facts JSON']]){
    const b2=page.getByRole('button',{name:btnName,exact:true}).first();
    if(await b2.count()){
      await b2.click();await page.waitForTimeout(1000);
      await shot('M-native',file,desc);
      const close=page.getByLabel('关闭任务详情');
      if(await close.count())await close.first().click().catch(()=>{});
      await page.waitForTimeout(400);
    }else skip('native-'+btnName,'按钮缺失');
  }
  // composer draft
  const ncomp=page.getByTestId('native-composer');
  if(await ncomp.count()){await ncomp.fill('e2e 截图草稿');await page.waitForTimeout(300);
    await shot('M-native','05-native-draft','M2 草稿输入（切换保留）');
    await ncomp.fill('');}
}else{
  skip('native-rows','侧栏无原生任务；launcher 表单已在 B 组截图');
}
await goWorkspace();

// ============ N. misc ============
await page.locator('button[title="设置"]').first().click().catch(()=>{});
await page.waitForTimeout(1200);
await shot('N-misc','01-settings-surface','A2 设置 surface 外框（工作台壳内）');
await goWorkspace();
await shot('N-misc','02-final-workspace','收尾：工作台还原态');

report.finishedAt=new Date().toISOString();
await writeFile(`${OUT}/manifest.json`,JSON.stringify(report,null,2));
console.log('DONE '+JSON.stringify({shots:report.shots.length,skipped:report.skipped.length,errors:report.errors.length,finds:report.finds.length}));
await b.close();
