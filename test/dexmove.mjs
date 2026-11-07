// 덱스 흉내 — 켜진 앱을 다른 화면(보조 디스플레이 1920×1080·160dpi)으로 옮길 때 배율·쓰던 메모. 에뮬레이터에서만: node dexmove.mjs
// 앱이 화면을 새로 만들면 같은 프로세스의 playwright 는 닫힌 옛 웹뷰를 계속 잡는다 → 단계마다 node 를 새로 띄운다.
import { _android } from 'playwright-core';
import { execFileSync } from 'child_process';
const PKG = 'net.live1379.syncmemo';
const phase = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const d = (await _android.devices()).find(x => x.serial().startsWith('emulator-'));
if (!d) { console.error('에뮬레이터가 없습니다 — 실제 폰에서는 실행하지 않습니다'); process.exit(2); }
const sh = async c => (await d.shell(c)).toString().trim();

if (phase) { // 하위 단계: 웹뷰에 붙어 한 가지 일만 하고 JSON 출력
  let p;
  for (let i = 0; i < 20 && !p; i++) {
    try { const wv = await d.webView({ pkg: PKG }, { timeout: 5000 }); const q = await wv.page(); await q.waitForFunction(() => typeof App !== 'undefined' && document.querySelector('#notes'), null, { timeout: 5000 }); p = q; } catch { await sleep(1000); }
  }
  const out = phase === 'write'
    ? await p.evaluate(m => { App.newNote(); const e = document.getElementById('editor'); e.innerHTML = `<p>${m}</p>`; e.dispatchEvent(new Event('input', { bubbles: true })); return true; }, process.argv[3])
    : await p.evaluate(m => ({ dpr: devicePixelRatio, w: innerWidth, h: innerHeight, saved: [...App._test.recs().values()].some(r => r.kind === 'note' && (r.text || '').includes(m)) }), process.argv[3] || '');
  console.log(JSON.stringify(out)); d.close(); process.exit(0);
}

const res = []; const check = (n, ok, x = '') => { res.push(!!ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const sub = (...a) => JSON.parse(execFileSync('node', [new URL(import.meta.url).pathname, ...a], { encoding: 'utf8' }).trim().split('\n').pop());
try {
  await sh('settings put global overlay_display_devices 1920x1080/160'); await sleep(2500);
  const disp = Number((await sh('dumpsys display')).match(/mDisplayId=([1-9]\d*)/)[1]);
  await sh(`am force-stop ${PKG}`); await sh(`am start -W --display 0 -n ${PKG}/.MainActivity`); await sleep(2000);
  const mark = '덱스이동' + Date.now();
  d.close();
  sub('write', mark);
  // 저장 대기(350ms)가 끝나기 전에 바로 옮긴다
  const d2 = (await _android.devices()).find(x => x.serial().startsWith('emulator-'));
  await d2.shell(`am start --display ${disp} -n ${PKG}/.MainActivity`); await sleep(4000);
  let s = sub('info', mark);
  check('모니터로 옮기면 배율 1 (전엔 2.625)', Math.abs(s.dpr - 1) < 0.05, JSON.stringify(s));
  check('모니터 화면 폭 그대로 (세 칸 화면)', s.w > 1500, JSON.stringify(s));
  check('옮기기 직전 쓰던 메모 저장됨', s.saved, mark);
  await d2.shell(`am start --display 0 -n ${PKG}/.MainActivity`); await sleep(4000);
  s = sub('info', mark);
  check('폰 화면으로 돌아오면 원래 배율', Math.abs(s.dpr - 2.625) < 0.05, JSON.stringify(s));
  await d2.shell('settings put global overlay_display_devices ""'); d2.close();
} finally {
  console.log(`${res.filter(Boolean).length}/${res.length}`);
}
