// 첨부 공유받기 · 파일 칩 · Claude 요청 메뉴 — 에뮬레이터에 설치된 APK 로 검증. 실행: node attach.mjs
// ★ 앱 데이터를 지운다(pm clear) → 에뮬레이터에서만.
import { _android } from 'playwright-core';
const PKG = 'net.live1379.syncmemo';
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const d = (await _android.devices()).find(x => x.serial().startsWith('emulator-'));
if (!d) { console.error('에뮬레이터가 없습니다'); process.exit(2); }
const sh = async c => (await d.shell(c)).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page() { const wv = await d.webView({ pkg: PKG }); const p = await wv.page(); await p.waitForFunction(() => typeof App !== 'undefined' && document.querySelector('#notes')); return p; }
try {
  await sh(`pm clear ${PKG}`);
  await sh(`am start -W -n ${PKG}/.MainActivity`);
  let p = await page();
  // 회의 메모 하나
  await p.evaluate(() => App.newNote()); await sleep(300);
  await p.keyboard.type('셀리더 회의 1108'); await p.keyboard.press('Enter'); await p.keyboard.type('김 집사 셀 보고');
  await p.evaluate(() => App._test.saveNow());
  await p.evaluate(() => history.back()); await sleep(400);

  // 1) 녹음 파일 공유 → 붙일 메모 고르기 창
  const share = await sh(`am start -a android.intent.action.SEND -t audio/mp4 --eu android.intent.extra.STREAM 'file:///sdcard/Recordings/Voice%20Recorder/%EC%9D%8C%EC%84%B1%20261108_161000.m4a' -n ${PKG}/.MainActivity`);
  await sleep(1500);
  const modal = await p.evaluate(() => ({ open: !document.querySelector('#modal').hidden, text: document.querySelector('.sheet')?.innerText || '' }));
  check('녹음 공유 → "어느 메모에 붙일까요?" 창', !/Error/.test(share) && modal.open && modal.text.includes('어느 메모에') && modal.text.includes('음성 261108_161000.m4a'), modal.text.replace(/\n/g, ' / ').slice(0, 120));
  check('창에 최근 메모(셀리더 회의) 표시', modal.text.includes('셀리더 회의 1108'));

  // 2) 메모 고르면 올리기 시도 → 에뮬레이터엔 구글 계정이 없어 실패 안내(앱이 죽지 않음)
  await p.evaluate(() => [...document.querySelectorAll('.sheet [data-id]')].find(b => b.textContent.includes('셀리더'))?.click());
  await sleep(4000);
  const top = await sh('dumpsys activity activities | grep -m1 topResumedActivity');
  check('메모를 고르면 구글 드라이브 권한 창이 뜸(처음 한 번)', top.includes('com.google.android.gms'), top.split(' ').pop());
  for (let i = 0; i < 4 && !(await sh('dumpsys activity activities | grep -m1 topResumedActivity')).includes('syncmemo'); i++) { await sh('input keyevent KEYCODE_BACK'); await sleep(1500); }
  await sleep(1500);
  p = await page();
  const t = await p.evaluate(() => document.querySelector('#toast').hidden ? '' : document.querySelector('#toast').textContent);
  check('권한 창을 취소하면 실패 안내(앱 유지)', /올리지 못했어요.*취소/.test(t), t);

  // 3) 파일 칩: 정리(sanitize) 후에도 유지 + 첨부 목록 추출
  const chip = await p.evaluate(() => {
    const h = App._test.sanitize(App._test.fileChip({ id: 'abc_123', name: '음성 261108_161000.m4a', size: 31234567 }) + App._test.fileChip({ id: 'def', name: '음성 261108_161000_original.txt', size: 2048 }));
    return { h, files: App._test.chipFiles(h) };
  });
  check('파일 칩이 정리 후에도 남음(드라이브 링크)', /class="file"/.test(chip.h) && /data-file="abc_123"/.test(chip.h) && chip.h.includes('drive.google.com/file/d/abc_123'), chip.h.slice(0, 120));
  check('메모에서 첨부 목록 추출(이름에서 크기 떼기)', JSON.stringify(chip.files) === JSON.stringify([{ id: 'abc_123', name: '음성 261108_161000.m4a' }, { id: 'def', name: '음성 261108_161000_original.txt' }]), JSON.stringify(chip.files));

  // 4) 길게 누르기 메뉴에 회의록·콘티 항목, 누르면 요청 내용이 맞게 만들어짐 (네이티브 호출은 가로채서 확인)
  await p.evaluate(h => { const n = [...App._test.recs().values()].find(r => r.title === '셀리더 회의 1108'); n.html += h; }, chip.h);
  await p.evaluate(() => { const c = [...document.querySelectorAll('#notes .card')].find(c => c.textContent.includes('셀리더 회의 1108')); c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 200 })); });
  await sleep(300);
  const menu = await p.evaluate(() => document.querySelector('#menu').innerText);
  check('길게 누르기 메뉴: 회의록 만들기·콘티 준비하기', menu.includes('회의록 만들기') && menu.includes('콘티 준비하기'), menu.replace(/\n/g, ' / '));
  await p.evaluate(() => {
    window.__sent = null;
    const orig = Native.call;
    Native.call = (m, a) => m === 'claude.request' ? (window.__sent = a, Promise.resolve({ id: 'x' })) : orig(m, a);
    [...document.querySelectorAll('#menu .mi')].find(b => b.textContent.includes('회의록 만들기')).click();
  });
  await sleep(300);
  const desc = await p.evaluate(() => document.querySelector('.sheet').innerText);
  check('확인 창에 첨부 2개 안내', desc.includes('첨부 2개') && desc.includes('보내기'), desc.replace(/\n/g, ' / ').slice(0, 140));
  await p.evaluate(() => document.querySelector('.sheet [data-ok]').click());
  await sleep(500);
  const sent = await p.evaluate(() => window.__sent && { name: window.__sent.name, body: JSON.parse(window.__sent.json) });
  check('요청 파일: 종류·제목·본문·첨부 ID', sent && /회의록 셀리더 회의 1108\.json$/.test(sent.name) && sent.body.kind === '회의록' && sent.body.title === '셀리더 회의 1108'
    && sent.body.text.includes('김 집사 셀 보고') && sent.body.files.map(f => f.id).join() === 'abc_123,def', sent && sent.name);
} catch (e) {
  check('예외 없이 끝남', false, e.message);
}
const ok = results.filter(Boolean).length;
console.log(`\n${ok}/${results.length} 통과`);
process.exit(ok === results.length ? 0 : 1);
