// 메모 전환 속도·더블클릭 검사 — 실제 크기 데이터(맥 메모 내보내기 json)로 (cd test && node perf.mjs <파일.json>)
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const ROOT = new URL('../docs/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const srv = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
}).listen(8796);
const res = []; const check = (n, ok, x = '') => { res.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const b = await chromium.launch({ channel: 'chrome' });
const errs = [];
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
// 맥 앱 흉내: 네이티브 호출을 기록하고 바로 응답
await ctx.addInitScript(() => { window.__calls = []; window.webkit = { messageHandlers: { native: { postMessage: m => { const o = JSON.parse(m); __calls.push(o.method); setTimeout(() => window.__native.resolve(o.id, true, o.method === 'auth.status' ? { connected: false } : null)); } } } }; });
const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8796/'); await p.waitForTimeout(500);
const data = JSON.parse(await readFile(process.argv[2], 'utf8'));
for (const x of data.notes) x.html = (x.html || '').replace(/src="data:[^"]*"/g, 'src=""'); // 사진 데이터는 빼고 개수만 실제대로
const n = await p.evaluate(d => App._test.importData(d), data);
console.log(`메모 ${n}개 가져옴`);
await p.waitForTimeout(500);
// 맥 앱처럼 보이게 openWindow 호출을 잡는다
await p.evaluate(() => { window.__opened = []; const call = Native.call; Native.call = (m, a) => { if (m === 'openWindow') __opened.push(a.id); return call(m, a); }; });

// 클릭 → 편집기 내용이 바뀔 때까지(다음 프레임까지 포함)
const times = [];
for (let i = 1; i <= 6; i++) {
  const t = await p.evaluate(async i => {
    const c = document.querySelectorAll('#notes .card')[i]; const id = c.dataset.id;
    const t0 = performance.now();
    c.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    await new Promise(r => requestAnimationFrame(() => setTimeout(r)));
    return { ms: Math.round(performance.now() - t0), ok: document.querySelector('#notes .card.on')?.dataset.id === id };
  }, i * 3);
  times.push(t);
}
const avg = Math.round(times.reduce((s, t) => s + t.ms, 0) / times.length);
check('메모 전환 평균 100ms 이하', avg <= 100 && times.every(t => t.ok), JSON.stringify(times.map(t => t.ms)) + ` 평균 ${avg}ms`);

// 실제 마우스 더블클릭 → 새 창 요청
const card = p.locator('#notes .card').nth(10);
const id = await card.getAttribute('data-id');
await card.dblclick(); await p.waitForTimeout(400);
const opened = await p.evaluate(() => __opened);
check('목록 더블클릭 → 새 창 요청', opened.includes(id), JSON.stringify(opened));
// 머리글 빈 곳 끌기·두 번 누르면 확대, 버튼은 그대로
const calls = async f => { await p.evaluate(() => { __calls.length = 0; }); await f(); await p.waitForTimeout(150); return p.evaluate(() => __calls.filter(m => /Window$/.test(m))); };
const box = async s => p.locator(s).first().boundingBox();
let bx = await box('.list-head'); let r = await calls(() => p.mouse.click(bx.x + bx.width - 4, bx.y + 6));
check('목록 머리글 빈 곳 → 창 끌기', r.includes('dragWindow'), JSON.stringify(r));
bx = await box('#listTitle'); r = await calls(() => p.mouse.click(bx.x + 5, bx.y + bx.height / 2));
check('목록 제목(모든 메모) → 창 끌기', r.includes('dragWindow'), JSON.stringify(r));
bx = await box('.edit-head .grow'); r = await calls(() => p.mouse.dblclick(bx.x + bx.width / 2, bx.y + bx.height / 2));
check('메모 머리글 빈 곳 두 번 → 확대', r.includes('zoomWindow'), JSON.stringify(r));
r = await calls(() => p.click('#btnSort')); await p.keyboard.press('Escape');
check('머리글 버튼은 끌기 안 함', !r.includes('dragWindow'), JSON.stringify(r));
r = await calls(() => p.click('#editor'));
check('본문 클릭은 끌기 안 함', r.length === 0, JSON.stringify(r));
check('스크립트 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`${res.filter(Boolean).length}/${res.length}`);
await b.close(); srv.close();
