// 실제 안드로이드(에뮬레이터·폰)에 설치된 APK 의 WebView 에 붙어서 검증한다. 실행: node android.mjs
import { _android } from 'playwright-core';
const PKG = 'net.live1379.syncmemo';
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); };
const [d] = await _android.devices();
const sh = async c => (await d.shell(c)).toString().trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function page() { const wv = await d.webView({ pkg: PKG }); const p = await wv.page(); await p.waitForFunction(() => typeof App !== 'undefined' && document.querySelector('#notes')); return p; }
try {
  await sh(`pm clear ${PKG}`);
  const start = await sh(`am start -W -n ${PKG}/.MainActivity`);
  check('앱 실행 (콜드 스타트 시간)', /Status: ok/.test(start), (start.match(/TotalTime: \d+/) || [''])[0] + 'ms');
  let p = await page();
  const env = await p.evaluate(() => ({ native: Native.available, platform: Native.platform, secure: isSecureContext, subtle: !!crypto.subtle, idb: !!indexedDB, w: innerWidth }));
  check('네이티브 연결 + 보안 컨텍스트(암호화·저장소 사용 가능)', env.native && env.platform === 'android' && env.secure && env.subtle && env.idb, JSON.stringify(env));
  const st = await p.evaluate(() => Native.call('auth.status'));
  check('구글 상태 조회 (네이티브)', st && st.connected === false);
  await sleep(500);
  check('동기화 표시 = 연결 필요 (클라이언트 ID 불필요)', (await p.textContent('#syncText')).includes('구글 연결 필요'), await p.textContent('#syncText'));

  // 메모 작성
  await p.evaluate(() => App.newNote());
  await sleep(300);
  await p.keyboard.type('안드로이드 메모');
  await p.keyboard.press('Enter');
  await p.keyboard.type('본문입니다 #테스트');
  await p.evaluate(() => App._test.saveNow());
  // 잠금 (암호화) 동작
  const enc = await p.evaluate(async () => { const n = [...App._test.recs().values()].find(r => r.title === '안드로이드 메모'); return !!n; });
  check('메모 작성·저장', enc);

  // 강제 종료 후 다시 열기
  await sh(`am force-stop ${PKG}`);
  await sh(`am start -W -n ${PKG}/.MainActivity`);
  p = await page();
  check('앱 강제 종료 후 다시 열어도 메모 유지', (await p.textContent('#notes')).includes('안드로이드 메모'));

  // 공유받기 (앱이 열린 상태 → 페이지 새로고침 없이)
  await p.evaluate(() => window.__marker = 1);
  await sh(`am start -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT 'shared-note-text https://example.com' -n ${PKG}/.MainActivity`);
  await sleep(1500);
  const shared = await p.evaluate(() => ({ marker: window.__marker, has: [...App._test.recs().values()].some(r => (r.text || '').includes('shared-note-text')) }));
  check('다른 앱에서 공유 → 새 메모 (새로고침 없이)', shared.has && shared.marker === 1, JSON.stringify(shared));

  // 바로가기 (할 일 템플릿)
  const before = await p.evaluate(() => App._test.recs().size);
  await sh(`am start -a net.live1379.syncmemo.NEW --es template 1 -n ${PKG}/.MainActivity`);
  await sleep(1500);
  const sc = await p.evaluate(() => ({ n: App._test.recs().size, pane: document.getElementById('app').dataset.pane, focus: document.activeElement.id }));
  check('바로가기 "새 메모" → 새 메모 편집 화면', sc.n === before + 1 && sc.pane === 'edit' && sc.focus === 'editor', JSON.stringify(sc));
  await sh('input keyevent 4'); await sleep(500);
  check('뒤로 버튼 → 목록으로 (앱 안 뒤로가기)', await p.evaluate(() => document.getElementById('app').dataset.pane) === 'list');

  // 파일 저장 (백업)
  const sv = await p.evaluate(() => Native.call('saveFile', { name: 'test-backup.json', text: '{"ok":1}', mime: 'application/json' }));
  const ls = await sh(`ls -R /sdcard/Download`);
  check('파일 저장 → 다운로드/싱크메모', ls.includes('test-backup') && sv.path, ls.replace(/\n/g, ' '));

  // 잠금 암호화 (WebCrypto)
  const lockOk = await p.evaluate(async () => { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']); return !!k; });
  check('암호화 기능 (메모 잠금)', lockOk);

  // 다크 모드: 시스템 → 화면·바 색
  await sh('cmd uimode night yes'); await sleep(1200);
  const dk = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
  check('시스템 다크 모드 → 앱 화면도 다크 (재시작 없이)', dk.theme === 'dark' && dk.bg === 'rgb(28, 28, 30)', JSON.stringify(dk));
  await d.screenshot({ path: new URL('./shots/android-dark.png', import.meta.url).pathname });
  await sh('cmd uimode night no'); await sleep(1200);
  check('시스템 라이트 모드 → 앱 화면도 라이트', await p.evaluate(() => document.documentElement.dataset.theme) === 'light');
  await d.screenshot({ path: new URL('./shots/android.png', import.meta.url).pathname });
} catch (e) { check('실행', false, e.stack); }
const fail = results.filter(x => !x).length;
console.log(`\n${results.length - fail}/${results.length} 통과`);
await d.close();
process.exit(fail ? 1 : 0);
