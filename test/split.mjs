// 펼친 폴드 세로 반반 화면 검사 (cd test && node split.mjs)
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
const errs = [];
async function dev(w, h) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.625, serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://localhost:8798/'); await p.waitForTimeout(500); return p;
}
const vis = (p, s) => p.$eval(s, e => { const r = e.getBoundingClientRect(); return getComputedStyle(e).display !== 'none' && r.width > 0 ? Math.round(r.left) + '~' + Math.round(r.right) : null; });
const state = async p => ({ pane: await p.$eval('#app', e => e.dataset.pane), list: await vis(p, '#list'), edit: await vis(p, '#edit'), noNote: await p.$eval('#app', e => e.classList.contains('no-note')), txt: await p.$eval('#editor', e => e.innerText.trim()) });
async function newNote(p, t) { await p.tap('#fab'); await p.waitForTimeout(200); await p.keyboard.type(t); await p.evaluate(() => App._test.saveNow()); }
const back = async p => { await p.tap('#btnToList'); await p.waitForTimeout(350); };
const card = (p, t) => p.locator('#list').getByText(t, { exact: true }).first();

// 1) 펼친 세로
let p = await dev(704, 900);
await newNote(p, '첫 메모'); await back(p);
await newNote(p, '둘째 메모'); let s = await state(p);
check('펼친 세로: 메모 열면 전체 화면', s.pane === 'edit' && !s.list && s.edit === '0~704', JSON.stringify(s));
await back(p); s = await state(p);
check('펼친 세로: 뒤로 → 목록·메모 반반', s.pane === 'list' && s.list === '0~352' && s.edit === '352~704' && s.txt === '둘째 메모', JSON.stringify(s));
await card(p, '첫 메모').tap(); await p.waitForTimeout(300); s = await state(p);
check('반반: 다른 메모 누르면 오른쪽만 바뀜', s.pane === 'list' && s.edit === '352~704' && s.txt === '첫 메모', JSON.stringify(s));
await card(p, '첫 메모').tap(); await p.waitForTimeout(300); s = await state(p);
check('반반: 열린 메모 한 번 더 누르면 전체 화면', s.pane === 'edit' && s.edit === '0~704', JSON.stringify(s));
await back(p); await back(p); s = await state(p);
check('반반에서 뒤로 한 번 더 → 목록만', s.pane === 'list' && s.list === '0~704' && !s.edit && s.noNote, JSON.stringify(s));
// 폰 뒤로가기(브라우저 기록) — 반반 → 목록만, 기록이 쌓이지 않음
await card(p, '둘째 메모').tap(); await p.waitForTimeout(300); await back(p);
await card(p, '둘째 메모').tap(); await p.waitForTimeout(300); await p.goBack(); await p.waitForTimeout(350); s = await state(p);
check('폰 뒤로가기: 전체 → 반반', s.pane === 'list' && s.edit === '352~704' && s.txt === '둘째 메모', JSON.stringify(s));
await p.goBack(); await p.waitForTimeout(350); s = await state(p);
check('폰 뒤로가기: 반반 → 목록만', s.pane === 'list' && s.list === '0~704' && !s.edit && s.noNote, JSON.stringify(s));
check('뒤로가기 기록 남지 않음', await p.evaluate(() => !history.state?.half && history.state?.pane !== 'edit'), JSON.stringify(await p.evaluate(() => [history.length, history.state])));
await card(p, '둘째 메모').tap(); await p.waitForTimeout(300); await back(p);
await p.setViewportSize({ width: 900, height: 704 }); await p.waitForTimeout(400); s = await state(p);
check('반반 → 가로 회전: 세 칸 화면에 메모 유지', s.list && s.edit && s.txt === '둘째 메모', JSON.stringify(s));
await p.setViewportSize({ width: 704, height: 900 }); await p.waitForTimeout(400); s = await state(p);
check('다시 세로: 보던 메모 전체 화면', s.pane === 'edit' && s.txt === '둘째 메모', JSON.stringify(s));

// 2) 폰(접은 화면) — 기존 동작 그대로
p = await dev(390, 844);
await newNote(p, '폰 메모'); await back(p); s = await state(p);
check('폰: 뒤로 → 목록 전체(기존 그대로)', s.pane === 'list' && s.list === '0~390' && !s.edit && s.noNote, JSON.stringify(s));
// 3) 커버 가로 751×475 — 반반 아님
p = await dev(751, 475);
await newNote(p, '커버 메모'); await back(p); s = await state(p);
check('커버 가로: 뒤로 → 목록 전체', s.pane === 'list' && !s.edit && s.noNote, JSON.stringify(s));
// 4) 반반 상태에서 접기(폭 390)
p = await dev(704, 900);
await newNote(p, '접기 메모'); await back(p);
await p.setViewportSize({ width: 390, height: 844 }); await p.waitForTimeout(400); s = await state(p);
check('반반에서 접기: 목록 전체, 화면 안 깨짐', s.pane === 'list' && s.list === '0~390' && !s.edit, JSON.stringify(s));
check('스크립트 오류 없음', errs.length === 0, errs.join(' | '));
console.log(`${res.filter(Boolean).length}/${res.length}`);
await b.close(); srv.close();
