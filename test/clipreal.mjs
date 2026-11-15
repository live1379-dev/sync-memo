// 에뮬레이터 실측: 메모 안에서 실제 안드로이드 복사(Ctrl+C) → 클립보드에 HTML 이 들어가는지, 붙여넣기(Ctrl+V) 글자가 원래 줄대로인지. node clipreal.mjs
import { _android } from 'playwright-core';
const PKG = 'net.live1379.syncmemo', sleep = ms => new Promise(r => setTimeout(r, ms));
const d = (await _android.devices()).find(x => x.serial().startsWith('emulator-'));
if (!d) { console.error('에뮬레이터 없음'); process.exit(2); }
await d.shell(`am force-stop ${PKG}`); await d.shell(`am start -W -n ${PKG}/.MainActivity`); await sleep(2500);
const p = await (await d.webView({ pkg: PKG })).page();
await p.waitForFunction(() => typeof App !== 'undefined');
await p.evaluate(() => { App.newNote(); const e = document.getElementById('editor'); e.innerHTML = '<p>제목</p><p>첫째 줄</p><p><br></p><p>둘째 줄</p><p>셋째 줄</p>'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(300);
const xy = await p.evaluate(() => { const r = document.getElementById('editor').lastElementChild.getBoundingClientRect(); return [Math.round((r.left + 20) * devicePixelRatio), Math.round((r.top + r.height / 2) * devicePixelRatio)]; });
await d.shell(`input tap ${xy[0]} ${xy[1] + 140}`); await sleep(700);
await p.evaluate(() => { const ed = document.getElementById('editor'); ed.focus(); const r = document.createRange(); r.setStartBefore(ed.children[1]); r.setEndAfter(ed.lastElementChild); getSelection().removeAllRanges(); getSelection().addRange(r); });
await d.shell('input keycombination 113 31'); await sleep(800); // 실제 Ctrl+C
await p.evaluate(() => { const ed = document.getElementById('editor'); window.__got = null; ed.addEventListener('paste', e => { window.__got = { types: [...e.clipboardData.types], text: e.clipboardData.getData('text/plain') }; }, { capture: true, once: true }); const r = document.createRange(); r.selectNodeContents(ed.lastElementChild); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });
await d.shell('input keycombination 113 50'); await sleep(800); // 실제 Ctrl+V
const got = await p.evaluate(() => window.__got);
const ver = await p.evaluate(() => document.body.innerHTML.match(/싱크 메모 v[\d.]+/)?.[0] || '');
console.log(JSON.stringify({ got, lines: await p.$eval('#editor', e => [...e.children].map(c => c.textContent)) }));
d.close();
