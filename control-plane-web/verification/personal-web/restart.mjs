import {chromium} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const previous=JSON.parse(await readFile(process.env.PERSONAL_WEB_TEST_OUT+'/browser-result.json','utf8'));
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.goto(process.env.PERSONAL_WEB_TEST_URL+'/index.html#/manage/tasks');
  await page.waitForURL(/personal.html#\/tasks$/,{timeout:15000});
  await page.getByRole('link',{name:/Change x.txt/}).click();
  await page.getByText('状态：已完成',{exact:true}).waitFor({timeout:15000});
  const detail=await page.evaluate(async id=>(await (await fetch('/api/personal/v1/tasks/'+id,{headers:{'x-personal-control':'1','x-personal-tab':sessionStorage.getItem('pae.personal.tabId')}})).json()),previous.taskId);
  for (const key of ['sessionId','runId']) if (detail.data[key]!==previous.detail.data[key]) throw new Error('Restart changed original source identity');
  if (detail.meta.controlPlaneId!==previous.detail.meta.controlPlaneId || detail.meta.instance===previous.detail.meta.instance) throw new Error('Did not verify a real BFF restart with the same registry');
  await writeFile(process.env.PERSONAL_WEB_TEST_OUT+'/restart-result.json',JSON.stringify({status:'PASS',taskId:previous.taskId,sessionId:detail.data.sessionId,runId:detail.data.runId,controlPlaneId:detail.meta.controlPlaneId,changedInstance:true,legacyNavigationRedirect:true},null,2));
  console.log('BFF_RESTART_AND_LEGACY_NAVIGATION_PASS');
}finally{await browser.close();}
