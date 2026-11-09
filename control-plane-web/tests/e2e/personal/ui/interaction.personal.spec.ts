import {test,expect} from '../fixtures/personal-ui';
import {createTaskViaUi,gotoTasks,personalApi,taskDetail} from '../fixtures/assertions';

test('PCI-UI-001 迟到的旧 Run 输出不覆盖新 Run，控制显式选中新运行',async({page,personalUi})=>{
  await gotoTasks(page,personalUi.url);const id=await createTaskViaUi(page,'PCI-UI-001 multi-run');
  const first=await taskDetail(page,id);await expect(page.getByLabel('查看运行')).toBeVisible();
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(done=>{release=done;}),captured=new Promise<void>(done=>{entered=done;});
  let delayed=false;
  await page.route('**/api/personal/v1/tasks/*/output?*',async route=>{
    const response=await route.fetch(),body=await response.json(),run=new URL(route.request().url()).searchParams.get('runId');
    if(run===first.runId&&!delayed){delayed=true;entered();await held;body.data.text='OLD_LATE_OUTPUT';}
    else if(run!==first.runId)body.data.text='NEW_SELECTED_OUTPUT';
    await route.fulfill({response,json:body});
  });
  try{
    await page.getByRole('button',{name:'刷新全部'}).click();await captured;
    const sent=await personalApi(page,`/api/personal/v1/tasks/${id}/messages`,{method:'POST',body:{requestKey:'ui-message-key',clientMessageId:'ui-client-id',content:'follow-up',expectedSessionVersion:first.session.sessionVersion}});
    expect(sent.status).toBe(201);const next=sent.body.data.acceptance.runId;expect(next).not.toBe(first.runId);
    await expect(page.getByText('NEW_SELECTED_OUTPUT',{exact:true})).toBeVisible({timeout:20000});
    release();await expect(page.getByText('OLD_LATE_OUTPUT',{exact:true})).toHaveCount(0);
    await expect(page.getByText('NEW_SELECTED_OUTPUT',{exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'停止',exact:true})).toBeEnabled();
    page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'停止',exact:true}).click();
    await expect.poll(()=>personalUi.source.audit.filter(v=>v.method==='POST'&&v.path.endsWith('/commands')).at(-1)?.targetId).toBe(next);
    const detail=await taskDetail(page,id);expect(detail.conversation.initialRunId).toBe(first.runId);
  }finally{release();}
});
