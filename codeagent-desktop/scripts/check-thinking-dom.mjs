import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const webRequire=createRequire(path.resolve(root,'../control-plane-web/package.json'));
const {chromium}=webRequire('@playwright/test');
const b=await chromium.connectOverCDP('http://localhost:9333');
const page=b.contexts()[0].pages()[0];
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForTimeout(4000);
// reopen the math ordinary-chat conversation
const row=page.locator('button, [role="button"], a, li').filter({hasText:/逐步推理后回答/}).first();
if(await row.count()){await row.click();await page.waitForTimeout(2500);}
const sel='[data-testid="message-reasoning"],[data-testid^="run-reasoning"],[data-testid="ungrouped-reasoning"],.round-thinking';
console.log('reasoning elements after rebuild:',await page.locator(sel).count());
console.log('message-reasoning:',await page.locator('[data-testid="message-reasoning"]').count());
const outDir=process.env.VERIFY_OUT||path.resolve(root,'.local','verify-reasoning');
await page.screenshot({path:path.join(outDir,'05-ordinary-after-fix.png')});
process.exit(0);
