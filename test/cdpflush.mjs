import { chromium } from 'playwright-core';
const b = await chromium.connectOverCDP('http://localhost:' + process.argv[2]);
const p = b.contexts()[0].pages()[0];
console.log(await p.evaluate(async () => { await App._test.saveNow(); return 'saved'; }));
await b.close();
