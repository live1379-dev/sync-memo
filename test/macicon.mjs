import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
const svg = readFileSync(new URL('../docs/icon.svg', import.meta.url), 'utf8');
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1024, height: 1024 } });
// macOS 아이콘 규격: 1024 캔버스 안에 824 크기, 그림자
await p.setContent(`<html><body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;height:1024px"><div style="width:824px;height:824px;filter:drop-shadow(0 12px 18px rgba(0,0,0,.28))">${svg.replace('<svg ', '<svg width="824" height="824" ')}</div></body></html>`);
await p.screenshot({ path: new URL('../mac/icon-1024.png', import.meta.url).pathname, omitBackground: true });
await b.close(); console.log('mac icon ok');
