import { chromium } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'});
const errors=[];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(process.env.PERSONAL_WEB_TEST_URL+'/personal.html#/tasks');
  const project=page.getByLabel('项目',{exact:true});
  await project.locator('option').nth(1).waitFor({state:'attached'});
  await project.selectOption(await project.locator('option').nth(1).getAttribute('value'));
  await page.getByLabel('任务要求',{exact:true}).fill('Change x.txt from v1 to v2 in the isolated workspace, then report the result.');
  await page.getByRole('button',{name:'开始任务',exact:true}).click();
  await page.waitForURL(/#\/tasks\/task-/, {timeout:60000});
  await page.waitForFunction(() => /状态：(已完成|执行失败|已取消)/.test(document.body.innerText),{},{timeout:180000});
  await page.reload();
  await page.waitForFunction(() => /状态：(已完成|执行失败|已取消)/.test(document.body.innerText),{},{timeout:15000});
  await page.getByText(/FILE_WRITE.*SUCCEEDED/).waitFor({timeout:15000});
  await page.getByText('总 token',{exact:true}).waitFor({timeout:15000});
  const taskId = page.url().split('/tasks/')[1];
  await page.screenshot({path:process.env.PERSONAL_WEB_TEST_OUT+'/detail.png',fullPage:true});
  const result = await page.evaluate(async id => {
    const headers={'x-personal-control':'1','x-personal-tab':sessionStorage.getItem('pae.personal.tabId')};
    const read=async suffix => (await fetch('/api/personal/v1/tasks/'+id+suffix,{headers})).json();
    return {detail:await read(''),metrics:await read('/metrics'),activities:await read('/activities'),output:await read('/output')};
  },taskId);
  if (errors.length) throw new Error('Browser errors: '+errors.join(';'));
  await writeFile(process.env.PERSONAL_WEB_TEST_OUT+'/browser-result.json',JSON.stringify({taskId,...result},null,2));
  // A fresh tab discovers the same task from the server, without localStorage.
  const other=await browser.newPage();
  await other.goto(process.env.PERSONAL_WEB_TEST_URL+'/personal.html#/tasks');
  await other.getByRole('link',{name:/Change x.txt/}).waitFor({timeout:15000});
  if (result.detail.data.run?.state !== 'COMPLETED') throw new Error('Source run did not complete: '+result.detail.data.run?.failureMessage);
  console.log('BROWSER_REAL_TASK_PASS '+taskId);
} catch(error) {
  await page.screenshot({path:process.env.PERSONAL_WEB_TEST_OUT+'/failure.png',fullPage:true});
  await writeFile(process.env.PERSONAL_WEB_TEST_OUT+'/failure.txt',await page.locator('body').innerText());
  throw error;
} finally {await browser.close();}
