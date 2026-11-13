// 앱 안 복사→붙여넣기 줄바꿈: 갤럭시 클립보드가 문단마다 빈 줄을 더 넣어도 원래 줄대로 (cd test && node copypaste.mjs)
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
const b = await chromium.launch({ channel: 'chrome' });
const errs = [];
const ctx = await b.newContext({ viewport: { width: 412, height: 900 }, hasTouch: true, serviceWorkers: 'block' });
const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8797/'); await p.waitForTimeout(500);
const lines = () => p.$eval('#editor', e => [...e.children].map(c => c.textContent));
await p.tap('#fab'); await p.waitForTimeout(200);
for (const t of ['제목', '첫째 줄', '', '둘째 줄']) { await p.keyboard.type(t); await p.keyboard.press('Enter'); }
await p.keyboard.type('셋째 줄');
const before = await lines();
const want = JSON.stringify([...before, ...before.slice(1)]);
const selCopy = () => p.evaluate(() => {
  const ed = document.getElementById('editor'); const r = document.createRange(); r.setStartBefore(ed.children[1]); r.setEndAfter(ed.lastElementChild); getSelection().removeAllRanges(); getSelection().addRange(r);
  const dt = new DataTransfer(); ed.dispatchEvent(new ClipboardEvent('copy', { clipboardData: dt, bubbles: true, cancelable: true })); return dt.getData('text/plain');
});
const toEnd = () => p.evaluate(() => { const ed = document.getElementById('editor'); const r = document.createRange(); r.selectNodeContents(ed.children[4]); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
const reset = async () => { await p.evaluate(() => { const ed = document.getElementById('editor'); while (ed.children.length > 5) ed.lastElementChild.remove(); }); };
const copied = await selCopy();
check('복사 글자 원래 줄', copied === '첫째 줄\n\n둘째 줄\n셋째 줄', JSON.stringify(copied));
const doubled = '첫째 줄\n\n\n\n둘째 줄\n\n셋째 줄\n\n'; // 갤럭시 Html.fromHtml 식
// ① 툴바 붙여넣기: paste 이벤트에 두 배 줄바꿈 글자
await toEnd(); await p.keyboard.press('Enter');
await p.evaluate(t => { const dt = new DataTransfer(); dt.setData('text/plain', t); document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, doubled);
let after = JSON.stringify(await lines());
check('붙여넣기 메뉴: 줄 그대로', after === want, after);
// ② 키보드 클립보드: 글자 입력(IME commit)으로 들어옴
await reset(); await toEnd(); await p.keyboard.press('Enter');
const cdp = await ctx.newCDPSession(p); await cdp.send('Input.insertText', { text: doubled }); await p.waitForTimeout(200);
after = JSON.stringify(await lines());
check('키보드 클립보드: 줄 그대로', after === want, after);
// ③ 다른 데서 복사한 빈 줄 많은 글은 손대지 않음
await reset(); await toEnd(); await p.keyboard.press('Enter');
await p.evaluate(() => { const dt = new DataTransfer(); dt.setData('text/plain', '가\n\n\n나'); document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); });
after = await lines();
check('다른 글은 원래 빈 줄 유지', JSON.stringify(after.slice(5)) === JSON.stringify(['가', '', '', '나']), JSON.stringify(after.slice(5)));
check('페이지 오류 없음', !errs.length, errs.join(' / '));
console.log(`\n${res.filter(Boolean).length}/${res.length} 통과`);
await b.close(); srv.close(); process.exit(res.every(Boolean) ? 0 : 1);
