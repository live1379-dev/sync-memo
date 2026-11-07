// 맥 메모(아이클라우드) 가져오기 날짜 검사 (cd test && node dates.mjs)
import { chromium } from 'playwright-core';
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
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
const p = await ctx.newPage(); p.on('pageerror', e => errs.push(e.message));
await p.goto('http://localhost:8797/'); await p.waitForTimeout(500);

const D = s => new Date(s).getTime();
const data = { format: 'apple-notes-export', version: 1, folders: [], notes: [
  { id: 'apple-a', folderName: '기도문', html: '<div>가장 옛날 메모</div>', createdAt: D('2023-01-01'), updatedAt: D('2023-02-01') },
  { id: 'apple-b', folderName: '기도문', html: '<div>중간 메모</div>', createdAt: D('2024-01-01'), updatedAt: D('2024-05-27') },
  { id: 'apple-c', folderName: '기도문', html: '<div>최근 메모</div>', createdAt: D('2025-01-01'), updatedAt: D('2025-10-03') },
] };
const titles = () => p.$$eval('#notes .card', cs => cs.map(c => c.querySelector('b, .t, strong')?.textContent || c.textContent.slice(0, 8)));
const recOf = id => p.evaluate(id => { const r = App._test.recs().get('note-' + id); return { editedAt: r.editedAt, updatedAt: r.updatedAt, createdAt: r.createdAt }; }, id);

// 1) 새로 가져오기 — 원래 수정일 유지
await p.evaluate(d => App._test.importData(d), data); await p.waitForTimeout(200);
let a = await recOf('apple-a'), c = await recOf('apple-c');
check('가져오기: 수정한 날 = 맥 메모 수정일', a.editedAt === D('2023-02-01') && c.editedAt === D('2025-10-03'), JSON.stringify(a));
let t = await titles();
check('가져오기: 수정한 날 순서(최근 → 옛날)', t.findIndex(x => x.includes('최근')) < t.findIndex(x => x.includes('중간')) && t.findIndex(x => x.includes('중간')) < t.findIndex(x => x.includes('옛날')), JSON.stringify(t));
const meta = await p.evaluate(() => { const c = [...document.querySelectorAll('#notes .card')].find(x => x.textContent.includes('옛날')); return c.querySelector('time').textContent; });
check('목록에 옛 날짜 표시', /^23\. 2\. 1/.test(meta), meta);

// 2) 예전 판으로 가져와 날짜를 잃은 상태 흉내 → 같은 파일 다시 가져오기 = 복구
await p.evaluate(async () => {
  const now = Date.now();
  for (const id of ['apple-a', 'apple-b', 'apple-c']) { const r = App._test.recs().get('note-' + id); delete r.editedAt; r.updatedAt = now + 1; await DB.put(r); }
  // b 는 가져온 뒤 고친 메모 → 날짜를 되돌리면 안 됨
  const rb = App._test.recs().get('note-apple-b'); rb.html = '<div>중간 메모 고침</div>'; rb.text = '중간 메모 고침'; await DB.put(rb);
});
const before = await recOf('apple-a');
const n = await p.evaluate(d => App._test.importData(d).then(n => [n, App._test.importData.fixed]), data);
a = await recOf('apple-a'); const bb = await recOf('apple-b');
check('다시 가져오기: 손대지 않은 메모 날짜 복구', a.editedAt === D('2023-02-01') && n[1] === 2, JSON.stringify({ n, a }));
check('다시 가져오기: 고친 메모는 그대로', !bb.editedAt, JSON.stringify(bb));
check('복구해도 동기화 버전은 앞으로만', a.updatedAt > before.updatedAt, `${before.updatedAt} → ${a.updatedAt}`);
check('다시 가져오기: 새 메모 안 생김', n[0] === 0 && await p.evaluate(() => [...App._test.recs().values()].filter(r => r.kind === 'note').length) === 3);

// 3) 고정·색은 수정한 날 유지, 편집은 지금으로
await p.locator('#notes .card', { hasText: '최근' }).click(); await p.waitForTimeout(200);
await p.click('#btnPin'); await p.waitForTimeout(200);
c = await recOf('apple-c');
check('고정해도 수정한 날 그대로', c.editedAt === D('2025-10-03'), JSON.stringify(c));
await p.click('#editor'); await p.keyboard.press('End'); await p.keyboard.type(' 추가'); await p.evaluate(() => App._test.saveNow());
c = await recOf('apple-c');
check('내용을 고치면 수정한 날 = 지금', Date.now() - c.editedAt < 60000, JSON.stringify(c));
check('스크립트 오류 없음', errs.length === 0, errs.join(' | '));
console.log(`${res.filter(Boolean).length}/${res.length}`);
await b.close(); srv.close();
