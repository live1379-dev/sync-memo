// 체크리스트 원 탭 → 체크는 되고 편집기에 포커스(=폰 키보드) 안 감 (cd test && node checktap.mjs)
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const ROOT = new URL('../docs/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const srv = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
}).listen(8798);
const res = []; const check = (n, ok, x = '') => { res.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const b = await chromium.launch({ channel: 'chrome' });
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8798/'); await p.waitForTimeout(500);
await p.tap('#fab'); await p.waitForTimeout(200);
await p.keyboard.type('장보기');
await p.$eval('#editor', e => { e.insertAdjacentHTML('beforeend', '<ul class="checklist"><li data-checked="false">사과</li><li data-checked="false">배</li></ul>'); e.dispatchEvent(new InputEvent('input')); });
await p.waitForTimeout(200);
const blur = () => p.evaluate(() => { document.activeElement?.blur(); getSelection().removeAllRanges(); });
const focused = () => p.evaluate(() => !!document.activeElement?.closest?.('#editor'));
const at = (i, dx) => p.$eval(`#editor ul.checklist > li:nth-child(${i})`, (li, dx) => { const b = li.getBoundingClientRect(); return { x: b.left + dx, y: b.top + 12 }; }, dx);
const st = () => p.$$eval('#editor ul.checklist > li', ls => ls.map(l => l.textContent + ':' + l.dataset.checked).join(','));
const nTrue = async () => (await st()).split(',').filter(s => s.endsWith('true')).length;

await blur(); await p.waitForTimeout(200);
let c = await at(1, 12); await p.touchscreen.tap(c.x, c.y); await p.waitForTimeout(200);
check('원 탭 → 체크됨', (await st()).includes('사과:true'), await st());
check('원 탭 → 편집기 포커스 안 감(키보드 안 뜸)', !(await focused()));
c = await at(1, 12); await p.touchscreen.tap(c.x, c.y); await p.waitForTimeout(200); // 맨 아래로 간 사과 다음 = 배가 1번
check('두 번째도 키보드 없이 체크', (await nTrue()) === 2 && !(await focused()), await st());
c = await at(1, 60); await p.touchscreen.tap(c.x, c.y); await p.waitForTimeout(200);
check('글자 탭 → 편집(포커스)', await focused());
c = await at(1, 12); await p.touchscreen.tap(c.x, c.y); await p.waitForTimeout(200);
check('편집 중 원 탭 → 체크 토글(한 번만)', (await nTrue()) === 1, await st());
await blur();
c = await at(1, 12); await p.mouse.click(c.x, c.y); await p.waitForTimeout(200);
check('마우스 클릭 체크(한 번만 토글)', (await nTrue()) === 0 || (await nTrue()) === 2, await st());
check('페이지 오류 없음', !errs.length, errs.join(' | '));
console.log(`\n${res.filter(Boolean).length}/${res.length}`);
await b.close(); srv.close(); process.exit(res.every(Boolean) ? 0 : 1);
