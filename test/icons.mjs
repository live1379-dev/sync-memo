import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';
const svg = readFileSync(new URL('../app/icon.svg', import.meta.url), 'utf8');
const b = await chromium.launch({ channel: 'chrome' });
for (const n of [192, 512]) {
  const p = await b.newPage({ viewport: { width: n, height: n } });
  await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${n}" height="${n}" `)}</body></html>`);
  await p.screenshot({ path: new URL(`../app/icon-${n}.png`, import.meta.url).pathname, omitBackground: true });
}
await b.close(); console.log('icons ok');
