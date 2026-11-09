import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
const OUT=process.env.PC_E2E_OUTPUT||'E:/project/e2e-electron-pi+codex/acs-jump-probe';
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env:{...env,CODEAGENT_DESKTOP_PROFILE:'acs-jump',CODEAGENT_DESKTOP_PROFILE_ROOT:path.join(OUT,'_profiles')}});
const page=await app.firstWindow();
await page.waitForTimeout(6000);
await page.getByRole('button',{name:/新建会话/}).first().click();
await page.waitForTimeout(1000);
const radio=page.getByRole('radio',{name:'智能体会话'});
if(await radio.count())await radio.click();
await page.getByLabel('说说想做什么').fill('Output the numbers 1 through 200, one per line. Then write three paragraphs about the sea.');
await page.getByRole('button',{name:/开始会话|开始聊天/}).click();
await expect(page.locator('.conversation').first()).toBeVisible({timeout:30000});
const conv=page.locator('.conversation').first();
const dbg=await page.evaluate(()=>({n:document.querySelectorAll('.conversation-scroll').length,dims:[...document.querySelectorAll('.conversation-scroll')].map(e=>({sh:e.scrollHeight,ch:e.clientHeight,vis:e.offsetParent!==null}))}));
console.log('SCROLL_DEBUG',JSON.stringify(dbg));
const scroller=page.locator('.conversation-scroll').first();
let scrollable=false,jumpSeen=false,jumpWorked=false,settled=false;
const t0=Date.now();
// ACS runs stream inside the AgentRunBlock viewport; the OUTER
// .conversation-scroll only becomes scrollable once the reply lands in the
// transcript — so check scrollability regardless of settle state.
while(Date.now()-t0<240000){
  const dims=await scroller.evaluate(el=>({sh:el.scrollHeight,ch:el.clientHeight})).catch(()=>null);
  const t=await conv.innerText();
  if(/SUCCEEDED|FAILED/.test(t)){settled=true;if(dims&&dims.sh>dims.ch+40){scrollable=true;break}}
  if(dims&&dims.sh>dims.ch*1.8){scrollable=true;break}
  await page.waitForTimeout(2000);
}
if(scrollable){
  await scroller.evaluate(el=>{el.scrollTop=0});
  await page.waitForTimeout(1200);
  await mkdir(OUT,{recursive:true});
  await page.screenshot({path:path.join(OUT,'scrolled-top.png')});
  const btn=page.locator('.composer-jump, button:has-text("回到最新内容")').first();
  jumpSeen=await btn.count()>0;
  if(jumpSeen){
    await btn.click();await page.waitForTimeout(800);
    jumpWorked=await scroller.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight).catch(()=>9999)<120;
    await page.screenshot({path:path.join(OUT,'after-jump.png')});
  }
}
if(!settled){for(let i=0;i<100;i++){const t=await conv.innerText();if(/SUCCEEDED|FAILED/.test(t)){settled=true;break}await page.waitForTimeout(2500)}}
await page.screenshot({path:path.join(OUT,'final.png')});
const dbg2=await page.evaluate(()=>({n:document.querySelectorAll('.conversation-scroll').length,dims:[...document.querySelectorAll('.conversation-scroll')].map(e=>({sh:e.scrollHeight,ch:e.clientHeight,vis:e.offsetParent!==null}))}));
console.log('SCROLL_DEBUG_FINAL',JSON.stringify(dbg2));
await writeFile(path.join(OUT,'facts.json'),JSON.stringify({scrollable,jumpSeen,jumpWorked,settled,dbg,dbg2},null,2));
console.log(JSON.stringify({scrollable,jumpSeen,jumpWorked,settled}));
await app.close();
