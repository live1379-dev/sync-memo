// 에뮬레이터 실측: 들여쓴 줄 맨 앞 백스페이스·빈 줄 엔터 = 내어쓰기 (실제 안드로이드 키 이벤트). node indentreal.mjs
import { _android } from 'playwright-core';
const PKG = 'net.live1379.syncmemo', sleep = ms => new Promise(r => setTimeout(r, ms));
const d = (await _android.devices()).find(x => x.serial().startsWith('emulator-'));
if (!d) { console.error('에뮬레이터 없음'); process.exit(2); }
await d.shell(`am force-stop ${PKG}`); await d.shell(`am start -W -n ${PKG}/.MainActivity`); await sleep(2500);
const p = await (await d.webView({ pkg: PKG })).page();
await p.waitForFunction(() => typeof App !== 'undefined');
const res = []; const check = (n, ok, x = '') => { res.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${n} — ${x}`); };
const html = () => p.$eval('#editor', e => e.innerHTML);
const at = (sel, end) => p.evaluate(([sel, end]) => { const t = [...document.querySelectorAll(sel)].pop(); const r = document.createRange(); r.selectNodeContents(t.querySelector('p') || t); r.collapse(!end); getSelection().removeAllRanges(); getSelection().addRange(r); }, [sel, end]);
await p.evaluate(() => { App.newNote(); const e = document.getElementById('editor'); e.innerHTML = '<p>제목</p><blockquote class="ind"><p>들여쓴 줄</p></blockquote><p>끝</p>'; e.dispatchEvent(new Event('input', { bubbles: true })); });
await sleep(300);
const xy = await p.evaluate(() => { const r = document.getElementById('editor').lastElementChild.getBoundingClientRect(); return [Math.round((r.left + 20) * devicePixelRatio), Math.round((r.top + r.height / 2) * devicePixelRatio)]; });
await d.shell(`input tap ${xy[0]} ${xy[1] + 140}`); await sleep(700);
await at('#editor blockquote', false); await d.shell('input keyevent 67'); await sleep(500);
let h = await html(); check('맨 앞 백스페이스 → 내어쓰기', !h.includes('blockquote') && h.includes('<p>들여쓴 줄</p>'), h);
await p.evaluate(() => { const e = document.getElementById('editor'); e.innerHTML = '<p>제목</p><blockquote class="ind"><p>들여쓴 줄</p></blockquote>'; });
await at('#editor blockquote', true); await d.shell('input keyevent 66'); await sleep(400); await d.shell('input keyevent 66'); await sleep(500);
h = await html(); check('끝 엔터 → 빈 줄 엔터 → 내어쓰기', /<\/blockquote><p><br><\/p>$/.test(h), h);
console.log(`${res.filter(Boolean).length}/${res.length}`); d.close();
