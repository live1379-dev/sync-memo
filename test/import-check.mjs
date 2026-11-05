// 큰 가져오기 파일이 실제로 들어가는지 확인: node test/import-check.mjs <파일.json>
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
const T = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const file = process.argv[2];
const srv = createServer(async (q, r) => {
  try {
    if (q.url === '/__import.json') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(await readFile(file)); }
    const p = join('docs', decodeURIComponent(q.url.split('?')[0]).replace(/\/$/, '/index.html'));
    r.writeHead(200, { 'content-type': T[extname(p)] || 'application/octet-stream' }); r.end(await readFile(p));
  } catch { r.writeHead(404); r.end(); }
}).listen(0);
const BASE = `http://127.0.0.1:${srv.address().port}/`;
const browser = await chromium.launch({ channel: 'chrome' });
const p = await (await browser.newContext()).newPage();
const errs = []; p.on('pageerror', e => errs.push(e.message));
await p.goto(BASE); await p.waitForTimeout(500);
const t0 = Date.now();
const r = await p.evaluate(async () => {
  const d = await (await fetch('/__import.json')).json();
  const added = await App._test.importData(d);
  const ns = [...App._test.recs().values()].filter(n => n.kind === 'note' && !n.trashedAt);
  return { input: d.notes.length, added, notes: ns.length, withImg: ns.filter(n => n.html.includes('<img')).length, folders: [...App._test.recs().values()].filter(f => f.kind === 'folder').map(f => f.name) };
});
await p.reload(); await p.waitForTimeout(1500);
const after = await p.evaluate(() => [...App._test.recs().values()].filter(n => n.kind === 'note').length);
const cards = await p.locator('#notes .card').count();
console.log(JSON.stringify({ ...r, afterReload: after, cards, sec: Math.round((Date.now() - t0) / 1000), errs }));
await browser.close(); srv.close();
