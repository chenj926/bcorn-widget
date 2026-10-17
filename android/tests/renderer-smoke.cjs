/* Chromium mobile integration test with the real Android JS adapter and simulated native replies.
 * This is NOT an Android WebView / emulator / device test. Uses synthetic data only. */
'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '../..');
const fixture = { terms: [{ id: 'test', name: 'Synthetic Android Test', start: '2026-10-01', end: '2026-11-30', timezone: 'America/Toronto', courses: [{ code: 'TEST101', title: 'Synthetic Course', credits: '0.5' }, { code: 'WAIT102', title: 'Synthetic Waitlist', credits: '0.5', status: 'Wait List' }], meetings: [{ code: 'TEST101', title: 'Synthetic Course', section: 'LEC01', kind: 'LEC', day: 1, start: '09:00', end: '10:00', location: 'Example Hall', from: '2026-10-01', until: '2026-11-30', exdates: ['2026-10-26'] }, { code: 'WAIT102', title: 'Synthetic Waitlist', section: 'LEC01', kind: 'LEC', day: 1, start: '09:30', end: '10:30', location: 'Example Hall' }] }] };
const server = http.createServer((req, res) => {
  const route = new URL(req.url, 'http://localhost').pathname;
  const file = route === '/android-bridge.js' ? path.join(root, 'android/app/src/main/assets/android-bridge.js') : path.join(root, route);
  if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    let body = fs.readFileSync(file);
    if (route.endsWith('index.html')) body = Buffer.from(body.toString().replace('<head>', '<head><script src="/android-bridge.js"></script>'));
    res.setHeader('Content-Type', route.endsWith('.html') ? 'text/html' : route.endsWith('.css') ? 'text/css' : 'application/javascript');
    res.end(body);
  } catch { res.writeHead(404); res.end(); }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 }, timezoneId: 'America/Toronto' });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.clock.install({ time: new Date('2026-10-19T13:30:00Z') });
    await page.addInitScript(data => {
      window.__androidTest = { calls: [], data: null, export: null };
      window.AcornNative = { call(id, method, encoded) {
        setTimeout(() => {
          const test = window.__androidTest;
          test.calls.push(method);
          const reply = result => window.__acornNativeReply(id, result, null);
          const status = { state: 'unsupported', message: 'Android 尚未接入 ACORN 登录和刷新。请导入本地 JSON。' };
          if (method === 'getState') reply({ data: test.data, status, pinned: false });
          else if (method === 'importData') { readImport(new File([JSON.stringify(data)], 'synthetic.json', { type: 'application/json' })); reply({ preview: true }); }
          else if (method === 'saveData') { test.data = JSON.parse(encoded); window.__acornNativeUpdate({ data: test.data, status }); reply(test.data); }
          else if (method === 'clearData') { test.data = null; const cleared = { data: null, status }; window.__acornNativeUpdate(cleared); reply(cleared); }
          else if (method === 'exportCalendar') { test.export = JSON.parse(encoded); reply({ saved: true }); }
          else reply(null);
        }, 0);
      } };
    }, fixture);
    await page.goto(`http://127.0.0.1:${server.address().port}/src/renderer/index.html`);
    await page.waitForSelector('[data-action="import"]');
    assert.match(await page.locator('#view').textContent(), /本地课表/);
    assert.equal(await page.evaluate(() => window.acorn.platform), 'android');
    assert.equal(await page.evaluate(() => typeof window.acornMock), 'undefined');
    await page.click('#view [data-action="import"]');
    await page.click('[data-action="choose-json"]');
    await page.waitForSelector('[data-action="confirm-import"]');
    assert.equal(await page.evaluate(() => window.__androidTest.data), null, 'preview must not save');
    await page.click('[data-action="confirm-import"]');
    await page.waitForFunction(() => !document.querySelector('#app-dialog').open);
    await page.click('[data-tab="term"]');
    assert.equal(await page.locator('.course-open').count(), 2);
    assert.equal(await page.locator('.block.waitlisted').count(), 1);
    assert.equal(await page.locator('[data-action="export"]').count(), 0);
    await page.click('[data-action="toggle-course-list"]');
    await page.click('[data-action="toggle-selection"]');
    await page.click('[data-action="select-all"]');
    await page.click('.course-toolbar [data-action="export"]');
    await page.click('#export-form [type="submit"]');
    await page.waitForFunction(() => window.__androidTest.export !== null);
    const output = await page.evaluate(() => window.__androidTest.export);
    assert.match(output.content, /^BEGIN:VCALENDAR/);
    assert.match(output.content, /TEST101/);
    assert.doesNotMatch(output.content, /WAIT102/);
    await page.waitForFunction(() => !document.querySelector('#app-dialog').open);
    await page.click('[data-action="menu"]'); await page.click('[data-action="clear-local"]');
    await page.click('[data-action="close-dialog"]');
    assert.notEqual(await page.evaluate(() => window.__androidTest.data), null, 'cancel must retain data');
    await page.click('[data-action="menu"]'); await page.click('[data-action="clear-local"]');
    await page.click('[data-action="confirm-clear-local"]');
    await page.waitForFunction(() => window.__androidTest.data === null);
    await page.waitForFunction(() => !document.querySelector('#app-dialog').open);
    assert.match(await page.locator('#view').textContent(), /本地课表/);
    assert.deepEqual(errors, []);
    console.log('PASS simulated Android adapter: no mock fallback, native import preview/confirmation/save, waitlist rendering, native ICS export, clear cancellation/confirmation, no page errors');
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
