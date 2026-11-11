import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Multi-lane UI e2e suite for alignment analysis. Runs the SAME case table on
// ACS session / pi native / codep native inside one real Electron, captures
// screenshots + machine-diffable facts per lane per case.
// Output: <OUT_ROOT>/<lane>/<caseId>/{*.png,facts.json} and <OUT_ROOT>/summary.json
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.join(root,'package.json'));
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {_electron,expect}=webRequire('@playwright/test');
const OUT=process.env.PC_E2E_OUTPUT||'E:/project/e2e-electron-pi+codex';
const PROFILE_ROOT=path.join(OUT,'_profiles');
const MD_PROMPT='Reply using markdown with exactly these elements: a level-2 heading, one bullet list of 3 items, one **bold** word, one `inline code` span, and a fenced code block containing print(42). Then one short closing line.';
const CJK_PROMPT='用中文回复：一句问候，然后三项无序列表（甲、乙、丙），其中一个词要**加粗**。';
const FOLLOWUP='One more short line please.';
const FOLLOWUP2='And one final short line.';
const LONG_PROMPT='Write a detailed story of about 1200 words about a deep-sea research station on Europa. Use several short sections with level-2 headings. Do not stop early.';
const TOOL_PROMPT='Use your tools: list the files in the project root, read README.md if it exists, then reply with a one-line summary of what this project is.';

const summary={schemaVersion:'lane-e2e-suite/1',startedAt:new Date().toISOString(),lanes:{},verdicts:[]};
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;

function hist(html){
  const tags={};
  for(const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)\b/g))tags[m[1].toLowerCase()]=(tags[m[1].toLowerCase()]||0)+1;
  return tags;
}
const now=()=>Date.now();

let app,page;
async function shot(lane,caseId,name){
  const dir=path.join(OUT,lane,caseId);await mkdir(dir,{recursive:true});
  await page.screenshot({path:path.join(dir,name+'.png')});
}
async function facts(lane,caseId,data){
  const dir=path.join(OUT,lane,caseId);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'facts.json'),JSON.stringify(data,null,2));
}

// ---------- lane-specific drivers ----------
const drivers={
  acs:{
    convSel:'.conversation',
    async create(prompt){
      await page.getByRole('button',{name:/新建会话/}).first().click();
      await page.waitForTimeout(1000);
      const radio=page.getByRole('radio',{name:'智能体会话'});
      if(await radio.count())await radio.click();
      const goal=page.getByLabel('说说想做什么');
      await goal.fill(prompt);
      await page.getByRole('button',{name:/开始会话|开始聊天/}).click();
      await expect(page.locator('.conversation').first()).toBeVisible({timeout:30000});
    },
    conv(){return page.locator('.conversation').first()},
    async settledText(){const t=await this.conv().innerText();return /SUCCEEDED|FAILED/.test(t)?t:null},
    sidebarRow(hint){return page.locator('.session-list li, [data-testid^="session-row"], .session-item').filter({hasText:hint}).first()},
    async openDiag(){const b=page.locator('.conversation-header, [data-testid="conversation-header"]').first().getByRole('button',{name:'状态'});if(await b.count()){await b.click();return true}return false},
    liveTailSel:null,
  },
  native:{
    convSel:'[data-testid="native-conversation"]',
    async create(prompt,engineId,projectLabel){
      await page.getByRole('button',{name:/新建会话/}).first().click();
      await page.waitForTimeout(1000);
      await page.locator('[data-testid="new-session-source-native"]').click();
      await page.waitForTimeout(700);
      const projSel=page.locator('select[aria-label="原生项目"]');
      await projSel.selectOption({label:projectLabel});
      await page.waitForTimeout(600);
      const engSel=page.locator('select[aria-label="原生引擎"]');
      if(await engSel.count()){
        const vals=await engSel.locator('option').evaluateAll(os=>os.map(o=>o.value));
        if(vals.includes(engineId))await engSel.selectOption(engineId);
      }
      await page.locator('[data-testid="native-instruction"]').fill(prompt);
      await page.locator('[data-testid="native-create"]').click();
      await expect(page.getByTestId('native-conversation')).toBeVisible({timeout:30000});
    },
    conv(){return page.getByTestId('native-conversation')},
    async settledText(){const t=await this.conv().innerText();return /已完成|SUCCEEDED|FAILED|已取消/.test(t)?t:null},
    sidebarRow(hint){return page.locator('[data-testid^="native-task-row-"]').filter({hasText:hint}).first()},
    async openDiag(){const b=page.getByTestId('conversation-header').getByRole('button',{name:'诊断'});if(await b.count()){await b.click();return true}return false},
    liveTailSel:'[data-testid="native-message-native-live-tail"]',
  },
};

async function discoverEngines(){
  // open native launcher once to read project->engine bindings
  await page.getByRole('button',{name:/新建会话/}).first().click();
  await page.waitForTimeout(1000);
  await page.locator('[data-testid="new-session-source-native"]').click();
  await page.waitForTimeout(700);
  const projSel=page.locator('select[aria-label="原生项目"]');
  const options=(await projSel.locator('option').allInnerTexts()).filter(o=>o.trim()&&o!=='选择已登记项目');
  const engSel=page.locator('select[aria-label="原生引擎"]');
  const map={};
  for(const opt of options){
    await projSel.selectOption({label:opt});
    await page.waitForTimeout(650);
    if(await engSel.count()){
      for(const v of await engSel.locator('option').evaluateAll(os=>os.map(o=>o.value)))if(v)map[v]=opt;
    }
  }
  await page.keyboard.press('Escape').catch(()=>{});
  return map;
}

// ---------- case helpers ----------
async function waitSettled(drv,timeout=300000){
  const t0=now();
  while(now()-t0<timeout){const s=await drv.settledText();if(s)return s;await page.waitForTimeout(3000)}
  return null;
}

async function runTaskA(lane,drv,createArgs){
  // one task covering c01,c03,c06,c09,c07,c08,c04,c05
  await drv.create(...createArgs);
  const conv=drv.conv();
  // c03 streaming samples
  const samples=[];const t0=now();
  let settled=await drv.settledText();
  while(!settled&&now()-t0<300000){
    const len=(await conv.innerText()).length;
    const tail=drv.liveTailSel?await page.locator(drv.liveTailSel).innerText().catch(()=>null):null;
    samples.push({t:now()-t0,len,tailLen:tail?tail.length:null});
    await page.waitForTimeout(2500);
    settled=await drv.settledText();
  }
  const fin={t:now()-t0,len:(await conv.innerText()).length,tailLen:drv.liveTailSel?(await page.locator(drv.liveTailSel).innerText().catch(()=>null)||'').length??0:null};
  samples.push(fin);
  await shot(lane,'c03-stream','final');await facts(lane,'c03-stream',{samples,settled:!!settled});
  summary.lanes[lane].c03={growth:samples.filter(s=>s.len>0).length>=2,tailSeen:samples.some(s=>(s.tailLen??0)>0),tailGone:!fin.tailLen,samples:samples.length};
  if(!settled){summary.lanes[lane].c01={settled:false};return null}

  // c01 markdown dom
  const html=await conv.innerHTML();
  await shot(lane,'c01-markdown','settled');
  await facts(lane,'c01-markdown',{tags:hist(html)});
  summary.lanes[lane].c01={settled:true,tags:hist(html)};

  // c09 instruction bubble once — count USER rows that START with the prompt
  // (assistant replies legitimately echo 'level-2 heading' phrasing).
  const turns=page.locator(lane==='acs'?'.conversation .message-turn':'.native-conversation .message-turn');
  const n=await turns.count();let instrCount=0;
  for(let i=0;i<n;i++){const t=(await turns.nth(i).innerText()).replace(/^[你助][^\n]*\n/, '').trimStart();if(t.startsWith('Reply using markdown with exactly'))instrCount++}
  await facts(lane,'c09-instr-once',{turnCount:n,instructionBubbles:instrCount});
  summary.lanes[lane].c09={instructionBubbles:instrCount,pass:instrCount===1};

  // c06 chips
  const chips=await page.locator('.conversation-header, .native-conversation header, [class*="chip"]').allInnerTexts().catch(()=>[]);
  await facts(lane,'c06-chips',{chips:chips.filter(Boolean).slice(0,12)});
  summary.lanes[lane].c06={chips:chips.filter(Boolean).slice(0,12)};

  // c07 diagnostics surface
  const opened=await drv.openDiag();
  await page.waitForTimeout(900);
  await shot(lane,'c07-diag','open');
  // excerpt must come from the info surface itself, never the sidebar
  const diagText=await page.locator('.native-info-dialog, .work-pane-floating, [role="dialog"]').first().innerText().catch(()=>'');
  // close: native modal closes on backdrop click; ACS work-pane closes on Escape
  if(await page.locator('.modal-backdrop').count()){
    await page.locator('.modal-backdrop').first().click({position:{x:8,y:8}}).catch(()=>{});
  } else {
    await page.keyboard.press('Escape').catch(()=>{});
  }
  await page.waitForTimeout(500);
  const stillOpen=await page.locator('.native-info-dialog, .work-pane-floating, .modal-backdrop').count();
  await facts(lane,'c07-diag',{opened,closed:stillOpen===0,excerpt:diagText.slice(0,400)});
  summary.lanes[lane].c07={opened,closed:stillOpen===0,excerptLen:diagText.length};

  // c04 settled reopen: navigate away & back
  const other=page.locator('[data-testid^="native-task-row-"], .session-list li').first();
  if(await other.count()){await other.click();await page.waitForTimeout(1500)}
  await drv.sidebarRow(/markdown|Reply|markdown with/i).first().click().catch(async()=>{await page.locator('[data-testid^="native-task-row-"]').first().click()});
  await page.waitForTimeout(2500);
  const after=await conv.innerText();
  const tailAfter=drv.liveTailSel?await page.locator(drv.liveTailSel).count():0;
  const regen=/生成中|本条回复进行中/.test(after)&&!/已完成|SUCCEEDED/.test(after);
  await shot(lane,'c04-reopen','reopened');
  await facts(lane,'c04-reopen',{tailElements:tailAfter,regen,finalLen:after.length});
  summary.lanes[lane].c04={tailElements:tailAfter,regen,pass:tailAfter===0&&!regen};

  // c05/c10 multi-turn follow-ups through composer: two sequential sends, each
  // must echo a user bubble and produce a new settled assistant reply.
  const composer=page.locator('textarea[placeholder^="输入消息"]');
  const rounds=[];
  for(const text of [FOLLOWUP,FOLLOWUP2]){
    const before=(await conv.innerText()).length;
    await composer.fill(text);
    await composer.press('Enter');
    await page.waitForTimeout(3500);
    // settled-for-this-round = text stable 3 polls AND no live-run indicators.
    // (settledText can't be reused: earlier turns keep their SUCCEEDED label.)
    let lastLen=0,stable=0,resettled=false;
    for(let i=0;i<80;i++){
      const t=await conv.innerText();
      const busy=await page.locator('.composer-dock, [data-testid="native-message-native-live-tail"]').count()>0
        ||/生成中|进行中/.test(t.slice(-400));
      stable=(t.length===lastLen&&!busy)?stable+1:0;
      lastLen=t.length;
      if(stable>=3){resettled=true;break}
      await page.waitForTimeout(3000);
    }
    const fin=await conv.innerText();
    rounds.push({text,echoVisible:fin.includes(text)||/待核对|已送达|已消费/.test(fin),grew:fin.length>before,resettled,finalLen:fin.length});
  }
  await shot(lane,'c05-followup','done');
  const userTurns=await page.locator(lane==='acs'?'.conversation .message-turn':'.native-conversation .message-turn').count();
  await facts(lane,'c05-followup',{rounds});
  await facts(lane,'c10-multi-turn',{rounds,userTurns});
  summary.lanes[lane].c05={userEchoVisible:rounds[0].echoVisible,resettled:rounds[0].resettled,finalLen:rounds[0].finalLen};
  summary.lanes[lane].c10={rounds:rounds.length,allEcho:rounds.every(r=>r.echoVisible),allResettled:rounds.every(r=>r.resettled),allGrew:rounds.every(r=>r.grew),userTurns};
  return {settled};
}

// ---------- c11 long-running task + c08 mid-stream scroll affordance ----------
async function runLongTask(lane,drv,createArgs){
  await drv.create(...createArgs);
  const conv=drv.conv();
  const t0=now();
  const samples=[];
  let settled=await drv.settledText();
  let scrollDone=false;let jumpSeen=false;let jumpWorked=false;
  const scroller=page.locator(lane==='acs'?'.conversation-scroll':'.native-conversation .conversation-scroll, [data-testid="native-conversation-body"]').first();
  while(!settled&&now()-t0<420000){
    const len=(await conv.innerText()).length;
    samples.push({t:now()-t0,len});
    // c08: once content is clearly scrollable mid-stream, jump to top and look
    // for the back-to-latest affordance, then use it and confirm bottom re-pin.
    if(!scrollDone){
      const dims=await scroller.evaluate(el=>({sh:el.scrollHeight,ch:el.clientHeight})).catch(()=>null);
      if(dims&&dims.sh>dims.ch*1.8){
        await scroller.evaluate(el=>{el.scrollTop=0});
        await page.waitForTimeout(1200);
        await shot(lane,'c08-scroll','scrolled-top');
        const jumpBtn=page.locator('.native-jump, .composer-jump, button:has-text("回到最新内容"), button:has-text("新消息")').first();
        jumpSeen=await jumpBtn.count()>0;
        if(jumpSeen){await jumpBtn.click().catch(()=>{});await page.waitForTimeout(800);
          const pos=await scroller.evaluate(el=>el.scrollHeight-el.scrollTop-el.clientHeight).catch(()=>9999);
          jumpWorked=pos<120;
        }
        scrollDone=true;
      }
    }
    await page.waitForTimeout(4000);
    settled=await drv.settledText();
  }
  const durationMs=now()-t0;
  await shot(lane,'c11-longrun','settled');
  const finalLen=(await conv.innerText()).length;
  const tailCount=drv.liveTailSel?await page.locator(drv.liveTailSel).count():0;
  await facts(lane,'c08-scroll',{scrollable:scrollDone,jumpSeen,jumpWorked});
  await facts(lane,'c11-longrun',{durationMs,samples:samples.length,finalLen,settled:!!settled,tailCount});
  summary.lanes[lane].c08={scrollable:scrollDone,jumpSeen,jumpWorked};
  summary.lanes[lane].c11={durationMs,settled:!!settled,finalLen,grew:samples.filter(s=>s.len>0).length>=2,tailGone:tailCount===0};
}

// ---------- c12 thinking + inline execution-process rendering ----------
// Same standard across lanes: when the lane executes tools, the conversation
// must show an inline 执行过程 fold with real rows; thinking blocks are recorded
// (provider decides per-turn whether reasoning parts exist — presence is fact).
async function runProcessCheck(lane,drv,createArgs){
  await drv.create(...createArgs);
  const settled=await waitSettled(drv,240000);
  const sels=lane==='acs'
    ?{fold:'[data-testid="run-process-fold"]',rows:'.cli-activity-row',think:'.round-thinking',summary:'[data-testid="run-process-summary"]'}
    :{fold:'[data-testid="native-process"]',rows:'.native-process-list li',think:'[data-testid^="native-thinking-"]',summary:'.run-process-summary'};
  const processBlock=await page.locator(sels.fold).count();
  // expand the fold if it renders collapsed so rows are countable
  const sumBtn=page.locator(sels.summary).first();
  if(await sumBtn.count()&&await sumBtn.getAttribute('aria-expanded')!=='true')await sumBtn.click().catch(()=>{});
  await page.waitForTimeout(800);
  const processRows=await page.locator(sels.rows).count();
  const thinkingBlocks=await page.locator(sels.think).count();
  const thinkingText=(await page.locator(sels.think).allInnerTexts()).join(' ').length;
  const processHeader=await sumBtn.innerText().catch(()=>null);
  await shot(lane,'c12-process','settled');
  await facts(lane,'c12-process',{settled:!!settled,processBlock,processRows,thinkingBlocks,thinkingText,processHeader});
  summary.lanes[lane].c12={settled:!!settled,processBlock,processRows,thinkingBlocks,thinkingText};
}

async function runTaskB(lane,drv,createArgs){
  await drv.create(...createArgs);
  const settled=await waitSettled(drv,240000);
  const conv=drv.conv();
  const text=await conv.innerText();
  const cjk=/[\u4e00-\u9fff]/.test(text)&&/[甲乙丙]/.test(text);
  await shot(lane,'c02-cjk','settled');
  await facts(lane,'c02-cjk',{settled:!!settled,cjk,excerpt:text.slice(-300)});
  summary.lanes[lane].c02={settled:!!settled,cjk};
}

async function run(){
  app=await _electron.launch({executablePath:require('electron'),args:[root],cwd:root,env:{...env,CODEAGENT_DESKTOP_PROFILE:'lane-suite',CODEAGENT_DESKTOP_PROFILE_ROOT:PROFILE_ROOT}});
  page=await app.firstWindow();
  await page.waitForTimeout(6000);
  const engines=await discoverEngines();
  summary.engineProject=engines;
  summary.acsBanner=await page.locator('text=ACS 会话服务未连接').count();

  // lane drivers: acs uses its own; pi/codep share 'native' with bound engine
  const lanes=[
    ['acs',drivers.acs,[MD_PROMPT]],
    ['pi',{...drivers.native,create:(p)=>drivers.native.create(p,'pi',engines.pi)},[MD_PROMPT]],
    ['codep',{...drivers.native,create:(p)=>drivers.native.create(p,'codep',engines.codep)},[MD_PROMPT]],
  ];
  for(const [lane,drv,args] of lanes){
    if(lane!=='acs'&&!engines[lane]){summary.lanes[lane]={skipped:'no engine project'};continue}
    summary.lanes[lane]={};
    try{await runTaskA(lane,drv,args)}catch(e){summary.lanes[lane].taskAError=e.message;await shot(lane,'_errors','taskA')}
    try{await runTaskB(lane,{...drv,create:(p)=>drivers[lane==='acs'?'acs':'native'].create.apply(drv,lane==='acs'?[p]:[p,lane,engines[lane]])},[CJK_PROMPT])}catch(e){summary.lanes[lane].taskBError=e.message;await shot(lane,'_errors','taskB')}
    try{await runLongTask(lane,{...drv,create:(p)=>drivers[lane==='acs'?'acs':'native'].create.apply(drv,lane==='acs'?[p]:[p,lane,engines[lane]])},[LONG_PROMPT])}catch(e){summary.lanes[lane].taskCError=e.message;await shot(lane,'_errors','taskC')}
    try{await runProcessCheck(lane,{...drv,create:(p)=>drivers[lane==='acs'?'acs':'native'].create.apply(drv,lane==='acs'?[p]:[p,lane,engines[lane]])},[TOOL_PROMPT])}catch(e){summary.lanes[lane].taskDError=e.message;await shot(lane,'_errors','taskD')}
  }
  // verdicts
  const l=summary.lanes;
  for(const lane of Object.keys(l)){
    if(l[lane].c09&&!l[lane].c09.pass)summary.verdicts.push(`${lane}: instruction bubbles=${l[lane].c09.instructionBubbles}`);
    if(l[lane].c04&&!l[lane].c04.pass)summary.verdicts.push(`${lane}: reopen shows stale tail/regen`);
    if(l[lane].c03&&l[lane].c03.tailSeen&&!l[lane].c03.tailGone)summary.verdicts.push(`${lane}: live tail persisted after settle`);
    if(l[lane].c02&&!l[lane].c02.cjk)summary.verdicts.push(`${lane}: CJK render missing`);
    if(l[lane].c07&&l[lane].c07.opened&&!l[lane].c07.closed)summary.verdicts.push(`${lane}: info surface did not close`);
    if(l[lane].c08&&l[lane].c08.scrollable&&!l[lane].c08.jumpSeen)summary.verdicts.push(`${lane}: no back-to-latest affordance while scrolled up mid-stream`);
    if(l[lane].c08&&l[lane].c08.jumpSeen&&!l[lane].c08.jumpWorked)summary.verdicts.push(`${lane}: back-to-latest button did not re-pin`);
    if(l[lane].c10&&!(l[lane].c10.allEcho&&l[lane].c10.allResettled))summary.verdicts.push(`${lane}: multi-turn echo/settle failure`);
    if(l[lane].c11&&!l[lane].c11.settled)summary.verdicts.push(`${lane}: long task never settled`);
    if(lane!=='acs'&&l[lane].c12&&l[lane].c12.settled&&l[lane].c12.processRows===0)summary.verdicts.push(`${lane}: tool task produced no process rows`);
  }
  await writeFile(path.join(OUT,'summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify({lanes:Object.fromEntries(Object.entries(summary.lanes).map(([k,v])=>[k,{c03:v.c03,c09:v.c09,c04:v.c04,c05:v.c05,c02:v.c02,c08:v.c08,c10:v.c10,c11:v.c11,c12:v.c12,err:v.taskAError||v.taskBError||v.taskCError||v.taskDError}])),verdicts:summary.verdicts,engines:summary.engineProject},null,1));
}

try{await run()}finally{if(app)await app.close()}
