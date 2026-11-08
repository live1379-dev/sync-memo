// "1. 글" 엔터 → 번호 목록·되돌리기 한 번에 원래 글자 + 메모 화면 새 메모 버튼 (cd test && node numlist.mjs [webkit])
import { chromium, webkit } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const ROOT = new URL('../docs/', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/json' };
const srv = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
}).listen(8797);
const res = []; const check = (n, ok, x = '') => { res.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const wk = process.argv[2] === 'webkit';
const b = wk ? await webkit.launch() : await chromium.launch({ channel: 'chrome' });
const errs = [];
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8797/'); await p.waitForTimeout(500);
const html = () => p.$eval('#editor', e => e.innerHTML);
const undo = () => p.tap('#btnUndo');

await p.tap('#fab'); await p.waitForTimeout(200);
check('메모 화면에 새 메모 버튼 보임', await p.isVisible('#btnNewE'));
await p.keyboard.type('제목'); await p.keyboard.press('Enter');
await p.keyboard.type('1. 샤밭메뉴'); await p.keyboard.press('Enter');
let h = await html();
check('엔터 → 번호 목록 2칸', /<ol><li>샤밭메뉴<\/li><li><br><\/li><\/ol>/.test(h), h);
await p.keyboard.type('결혼식'); await p.keyboard.press('Enter'); await p.keyboard.type('하누카');
h = await html();
check('계속 치면 3번까지', /<ol><li>샤밭메뉴<\/li><li>결혼식<\/li><li>하누카<\/li><\/ol>/.test(h), h);
const text = await p.$eval('#editor', e => e.innerText);
check('다른 줄 그대로', text.includes('제목'));

// 되돌리기: 새 메모에서 바로
await p.tap('#btnNewE'); await p.waitForTimeout(300);
check('새 메모 버튼 → 빈 새 메모', (await p.$eval('#editor', e => e.innerText.trim())) === '');
await p.keyboard.type('1. 마라탕'); await p.keyboard.press('Enter');
check('두 번째 메모도 목록', /<ol><li>마라탕<\/li>/.test(await html()), await html());
await undo(); await p.waitForTimeout(100);
h = await html();
check('되돌리기 한 번 → 번호 목록 없이 원래 글자', !h.includes('<ol') && (await p.$eval('#editor', e => e.innerText)).includes('1. 마라탕'), h);
await p.keyboard.type('X');
check('되돌린 뒤 커서가 글 끝', (await p.$eval('#editor', e => e.innerText)).includes('1. 마라탕X'), await html());

// 글 중간에서 엔터·숫자 아닌 줄·3. 시작
await p.tap('#btnNewE'); await p.waitForTimeout(300);
await p.keyboard.type('3. 셋째'); await p.keyboard.press('Enter'); await p.keyboard.type('넷째');
h = await html();
check('3. 으로 시작하면 3부터', /<ol start="3"><li>셋째<\/li><li>넷째<\/li><\/ol>/.test(h), h);
await p.evaluate(() => App._test.saveNow());
check('저장해도 시작 번호 유지', /<ol start="3">/.test(await p.evaluate(() => [...App._test.recs().values()].find(r => (r.html || '').includes('셋째'))?.html || '')));
await p.keyboard.press('Enter'); await p.keyboard.press('Enter'); await p.keyboard.type('2024.11 회의');
await p.keyboard.press('Enter');
h = await html();
check('빈 칸에서 엔터 → 목록 끝, 연도 같은 줄은 안 바뀜', !/<li>2024/.test(h) && (h.match(/<ol/g) || []).length === 1, h);
await p.keyboard.type('5. 가운데');
for (let i = 0; i < 3; i++) await p.keyboard.press('ArrowLeft');
await p.keyboard.press('Enter');
h = await html();
check('글 중간 엔터는 그냥 줄바꿈', (h.match(/<ol/g) || []).length === 1, h);

// 탭 = 들여쓰기 (일반 줄)
await p.tap('#btnNewE'); await p.waitForTimeout(300);
await p.keyboard.type('첫 줄'); await p.keyboard.press('Enter'); await p.keyboard.type('들여쓸 줄');
await p.keyboard.press('Tab');
h = await html();
check('일반 줄 탭 → 들여쓰기', /<blockquote class="ind"><p>들여쓸 줄<\/p><\/blockquote>/.test(h) || /<blockquote class="ind">들여쓸 줄<\/blockquote>/.test(h), h);
check('포커스는 편집칸에 그대로', await p.evaluate(() => document.activeElement.id === 'editor'));
const ml = await p.$eval('#editor blockquote', e => getComputedStyle(e).marginLeft + '/' + getComputedStyle(e).borderLeftWidth);
check('인용문(세로줄) 아닌 들여쓰기 모양', ml.startsWith('3') && ml.endsWith('/0px'), ml);
await p.evaluate(() => App._test.saveNow());
const saved = await p.evaluate(() => [...App._test.recs().values()].find(r => (r.html || '').includes('들여쓸 줄'))?.html || '');
check('저장 후에도 들여쓰기 표시 유지', saved.includes('blockquote class="ind"'), saved);
await p.keyboard.press('Shift+Tab');
h = await html();
check('Shift+탭 → 내어쓰기', !h.includes('blockquote') && h.includes('들여쓸 줄'), h);
await p.keyboard.press('Shift+Tab');
check('더 내어쓸 게 없으면 그대로', !(await html()).includes('blockquote'));
await p.keyboard.press('End'); await p.keyboard.press('Enter'); await p.keyboard.type('1. 하나'); await p.keyboard.press('Enter'); await p.keyboard.type('둘'); await p.keyboard.press('Tab');
h = await html();
check('목록 안 탭은 하위 목록', /<li>하나<ol><li>둘<\/li><\/ol><\/li>|<ol><li>하나<\/li><ol><li>둘/.test(h), h);
check('페이지 오류 없음', !errs.length, errs.join(' / '));
console.log(`\n${res.filter(Boolean).length}/${res.length} 통과 (${wk ? 'webkit' : 'chrome'})`);
await b.close(); srv.close(); process.exit(res.every(Boolean) ? 0 : 1);
