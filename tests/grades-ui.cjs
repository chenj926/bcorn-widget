// Synthetic user-flow test. Run with CHROME_BIN pointing at a supported Chromium.
'use strict';
const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs/promises');const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_BIN?{executablePath:process.env.CHROME_BIN}:{}),args:['--no-sandbox']});
 try {
  const context=await browser.newContext({viewport:{width:360,height:740}});const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(pathToFileURL(path.resolve(__dirname,'../src/renderer/index.html')).href);
  await page.click('[data-tab="grades"]');await page.waitForSelector('.gb-new-course');
  await page.locator('.gb-new-course > summary').click();const course=page.locator('[data-gb-form="course"]');
  await course.locator('[name="title"]').fill('Synthetic weighted course');await course.locator('[name="ordinary"]').check();await course.locator('button[type="submit"]').click();
  await page.waitForSelector('.gb-add-assessment');
  async function add(title,weight,status,score){await page.locator('.gb-add-assessment > summary').click();const form=page.locator('.gb-add-assessment form');await form.locator('[name="title"]').fill(title);await form.locator('[name="weight"]').fill(weight);await form.locator('[name="status"]').selectOption(status);if(score)await form.locator('[name="score"]').fill(score);await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.querySelectorAll('.gb-assessment').length>0);}
  await add('A', '10', 'graded', '40/50');await add('B','20','graded','0');await add('C','70','ungraded','');
  await page.waitForFunction(()=>document.querySelectorAll('.gb-assessment').length===3);
  const metrics=await page.locator('.gb-metrics').textContent();assert.match(metrics,/26\.67%/);assert.match(metrics,/8 个百分点/);assert.match(metrics,/70%/);
  assert.match(await page.locator('.gb-sync-state').textContent(),/未配置/);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.reload();await page.waitForSelector('.gb-assessment');assert.equal(await page.locator('.gb-assessment').count(),3);assert.match(await page.locator('.gb-metrics').textContent(),/26\.67%/);
  await page.locator('.gb-assessment').first().locator('summary').click();const form=page.locator('.gb-assessment').first().locator('form');await form.locator('[name="score"]').fill('=1+1');await form.locator('button[type="submit"]').click();assert.match(await page.locator('.gb-message').textContent(),/格式无效/);
  await form.locator('[name="score"]').fill('90%');await form.locator('button[type="submit"]').click();await page.waitForFunction(()=>document.querySelector('.gb-metrics').textContent.includes('30%'));
  await page.locator('.gb-add-assessment > summary').click();await page.locator('.gb-add-assessment [name="title"]').fill('Unsaved');assert.equal(await page.evaluate(()=>GradesUI.hasUnsavedChanges()),true);
  page.once('dialog',dialog=>dialog.dismiss());await page.click('[data-tab="term"]');assert.equal(await page.locator('.gb-add-assessment').count(),1);
  page.once('dialog',dialog=>dialog.accept());await page.click('[data-tab="term"]');await page.click('[data-tab="grades"]');await page.waitForSelector('.gb-assessment');assert.equal(await page.locator('.gb-assessment').count(),3);
  const directory=process.env.SCREENSHOT_DIR||'/tmp/bcorn-grades-ui';await fs.mkdir(directory,{recursive:true});await page.screenshot({path:path.join(directory,'grades-synthetic.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('PASS: synthetic grade UI create/edit/zero/ungraded/reload/dirty guard and mobile overflow');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
