// 실제 Chrome 으로 두 기기(맥·폰)를 띄우고 가짜 구글 드라이브를 사이에 둬서 동기화를 검증한다.
// 실행: cd test && node e2e.mjs
import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile, mkdir } from 'fs/promises';
import { extname, join } from 'path';

const ROOT = new URL('../docs/', import.meta.url).pathname;
const SHOTS = new URL('./shots/', import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const srv = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  try { const b = await readFile(join(ROOT, p)); res.writeHead(200, { 'Content-Type': MIME[extname(p)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
}).listen(8799);
const BASE = 'http://localhost:8799/';

// ── 가짜 드라이브 ──
const drive = { files: new Map(), seq: 0, tokenCalls: [] };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
async function handle(route) {
  const req = route.request(), url = new URL(req.url()), m = req.method();
  if (m === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
  const json = (o, status = 200) => route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(o) });
  if (url.host === 'oauth2.googleapis.com') {
    const f = new URLSearchParams(req.postData() || '');
    drive.tokenCalls.push(Object.fromEntries(f));
    return json({ access_token: 'tok' + drive.tokenCalls.length, expires_in: 3600, ...(f.get('grant_type') === 'authorization_code' ? { refresh_token: 'refresh1' } : {}) });
  }
  if (req.headers()['authorization']?.startsWith('Bearer tok') !== true) return json({ error: 'unauth' }, 401);
  if (url.pathname === '/drive/v3/files' && m === 'GET') {
    return json({ files: [...drive.files.values()].map(f => ({ id: f.id, name: f.name, appProperties: f.appProperties })) });
  }
  let mm = url.pathname.match(/^\/drive\/v3\/files\/([^/]+)$/);
  if (mm && m === 'GET' && url.searchParams.get('fields') === 'appProperties') { const f = drive.files.get(mm[1]); return f ? json({ appProperties: f.appProperties }) : json({}, 404); }
  if (mm && url.searchParams.get('alt') === 'media') {
    const f = drive.files.get(mm[1]); return f ? route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: f.content }) : json({}, 404);
  }
  if (mm && m === 'DELETE') { drive.files.delete(mm[1]); return route.fulfill({ status: 204, headers: CORS }); }
  mm = url.pathname.match(/^\/upload\/drive\/v3\/files(?:\/([^/]+))?$/);
  if (mm) {
    const ct = req.headers()['content-type'];
    const boundary = ct.match(/boundary=(\S+)/)[1];
    const body = req.postDataBuffer().toString('utf8');
    const parts = body.split('--' + boundary).slice(1, -1).map(p => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    const meta = JSON.parse(parts[0]), content = parts[1];
    if (m === 'POST') { const id = 'f' + (++drive.seq); drive.files.set(id, { id, name: meta.name, appProperties: meta.appProperties, content }); return json({ id }); }
    const f = drive.files.get(mm[1]); if (!f) return json({}, 404);
    f.appProperties = meta.appProperties; f.content = content; return json({ id: f.id });
  }
  return json({ error: 'unknown ' + url.pathname }, 404);
}

// ── 검사 도구 ──
const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`); };
const errors = [];
const browser = await chromium.launch({ channel: 'chrome' });
async function device(opts) {
  const ctx = await browser.newContext({ serviceWorkers: 'block', ...opts });
  await ctx.route(/googleapis\.com/, handle);
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push(e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.goto(BASE);
  return { ctx, p };
}
const connect = p => p.evaluate(async () => { await DB.setMeta('gcfg', { clientId: 'cid', clientSecret: 'sec' }); await DB.setMeta('gauth', { refresh: 'r1', access: 'old', exp: 0 }); });
const sync = p => p.evaluate(async () => { await Sync.run(); return Sync.state; });
const save = p => p.evaluate(() => App._test.saveNow());
const noteCount = p => p.evaluate(() => [...App._test.recs().values()].filter(r => r.kind === 'note' && !r.purged && !r.trashedAt).length);
const driveNotes = () => [...drive.files.values()].filter(f => f.name.startsWith('note-')).map(f => ({ ...f, data: JSON.parse(f.content) }));
const endOfEditor = p => p.evaluate(() => { const e = document.getElementById('editor'); e.focus(); const r = document.createRange(); r.selectNodeContents(e); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); });

try {
  const A = await device({ viewport: { width: 1280, height: 800 } });
  const B = await device({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await connect(A.p); await connect(B.p);

  // 1. 맥에서 메모 작성 → 드라이브에 올라감
  await A.p.click('#btnNew');
  await A.p.keyboard.type('장보기 목록');
  await A.p.keyboard.press('Enter');
  await A.p.keyboard.type('우유 사기 #마트');
  await save(A.p);
  let st = await sync(A.p);
  check('맥: 동기화 완료 상태', st.status === 'synced', st.status + ' ' + st.error);
  check('토큰 자동 갱신 (refresh token)', drive.tokenCalls.some(c => c.grant_type === 'refresh_token' && c.refresh_token === 'r1'));
  let dn = driveNotes();
  check('드라이브에 메모 1개 업로드', dn.length === 1 && dn[0].data.title === '장보기 목록', JSON.stringify(dn.map(d => d.data.title)));
  check('태그 추출 (#마트)', dn[0]?.data.tags?.includes('마트'));

  // 2. 폰에서 받기
  st = await sync(B.p);
  check('폰: 맥에서 쓴 메모가 보임', (await B.p.textContent('#notes')).includes('장보기 목록'));

  // 2-1. 폰 세로: 목록 위에 폴더·보기 칩 줄
  const chipsB = await B.p.evaluate(() => ({ shown: getComputedStyle(document.getElementById('chips')).display !== 'none', chips: [...document.querySelectorAll('#chips .chip-v')].map(b => b.textContent) }));
  check('폰 세로: 메모 목록 위에 폴더·보기 칩 표시', chipsB.shown && chipsB.chips.includes('모든 메모') && chipsB.chips.includes('최근 삭제됨'), JSON.stringify(chipsB));
  await B.p.tap('#chips [data-type="trash"]');
  check('칩 누르면 그 보기로 전환', (await B.p.textContent('#listTitle')) === '최근 삭제됨');
  await B.p.tap('#chips [data-type="all"]');

  // 3. 폰에서 수정 → 맥 반영
  await B.p.tap('.card');
  check('폰: 편집 화면으로 전환', await B.p.evaluate(() => document.getElementById('app').dataset.pane === 'edit'));
  await endOfEditor(B.p);
  await B.p.keyboard.type(' 그리고 빵');
  await save(B.p);
  await sync(B.p);
  await A.p.click('#q'); // 편집기 포커스 해제
  await sync(A.p);
  await A.p.waitForTimeout(100);
  check('맥: 폰에서 고친 내용이 반영', (await A.p.textContent('#editor')).includes('그리고 빵'));
  check('폰 편집 후에도 드라이브 파일 1개 (중복 없음)', driveNotes().length === 1);

  // 4. 둘 다 오프라인에서 같은 메모 수정 → 충돌 사본
  await A.ctx.setOffline(true); await B.ctx.setOffline(true);
  await A.p.click('.card');
  await endOfEditor(A.p); await A.p.keyboard.type(' A수정'); await save(A.p);
  await endOfEditor(B.p); await B.p.keyboard.type(' B수정'); await save(B.p);
  st = await sync(A.p);
  check('오프라인이면 상태 = offline, 기기에는 저장', st.status === 'offline' && (await A.p.evaluate(async () => (await DB.all()).some(r => r._dirty && (r.html || '').includes('A수정')))));
  await A.ctx.setOffline(false); await B.ctx.setOffline(false);
  await sync(A.p); await sync(B.p); await A.p.click('#q'); await sync(A.p);
  check('충돌: 양쪽 다 메모 2개(원본+충돌 사본)', (await noteCount(A.p)) === 2 && (await noteCount(B.p)) === 2, `${await noteCount(A.p)}/${await noteCount(B.p)}`);
  dn = driveNotes();
  const both = dn.map(d => d.data.html).join(' ');
  check('충돌: A수정·B수정 둘 다 보존', both.includes('A수정') && both.includes('B수정'));
  check('충돌 사본 표시', dn.some(d => d.data.html.includes('충돌 사본')));

  // 5. 체크리스트 (맥) — 체크하면 아래로
  await A.p.click('#btnNew');
  await A.p.keyboard.type('할 일 테스트'); await A.p.keyboard.press('Enter');
  await A.p.click('[data-cmd="checklist"]');
  await A.p.keyboard.type('항목1'); await A.p.keyboard.press('Enter'); await A.p.keyboard.type('항목2');
  const li = A.p.locator('#editor ul.checklist > li').first();
  const box = await li.boundingBox();
  await A.p.mouse.click(box.x + 10, box.y + box.height / 2);
  const order = await A.p.$$eval('#editor ul.checklist > li', ls => ls.map(l => l.textContent + ':' + l.dataset.checked));
  check('체크리스트가 문단 밖에 바르게 들어감 (<p><ul> 없음)', !(await A.p.$('#editor p > ul')));
  check('체크리스트 생성 + 체크한 항목 맨 아래로', JSON.stringify(order) === JSON.stringify(['항목2:false', '항목1:true']), JSON.stringify(order));

  // 6. 형광펜
  await A.p.evaluate(() => { const li = document.querySelector('#editor ul.checklist > li'); const r = document.createRange(); r.selectNodeContents(li); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await A.p.click('[data-cmd="format"]');
  await A.p.locator('#menu .row').first().locator('.chip').first().click();
  check('형광펜 → mark.hl-yellow', await A.p.$('#editor mark.hl-yellow') !== null, await A.p.innerHTML('#editor'));

  // 7. 손글씨
  await endOfEditor(A.p);
  await A.p.click('[data-cmd="draw"]');
  const cb = await A.p.locator('#canvas').boundingBox();
  await A.p.mouse.move(cb.x + 50, cb.y + 50); await A.p.mouse.down();
  for (let i = 0; i < 20; i++) await A.p.mouse.move(cb.x + 50 + i * 10, cb.y + 50 + Math.sin(i) * 20);
  await A.p.mouse.up();
  await A.p.click('#drawDone');
  check('손글씨 → 메모에 그림 삽입 (다시 편집 가능 데이터 포함)', await A.p.$('#editor img.drawing[data-strokes]') !== null);

  // 8. 표
  await endOfEditor(A.p);
  await A.p.click('[data-cmd="table"]');
  check('표 3×3 삽입', (await A.p.$$('#editor table td')).length === 9);
  await save(A.p);

  // 8-1. 레이아웃: 폴더 칸 기본 숨김 → 버튼으로 열기, 기본 글씨 15px
  const lay0 = await A.p.evaluate(() => ({ hidden: document.getElementById('app').classList.contains('side-hidden'), sideW: Math.round(document.getElementById('side').getBoundingClientRect().width), fs: getComputedStyle(document.getElementById('editor')).fontSize }));
  check('폴더 칸 기본 숨김 + 기본 글씨 14px', lay0.hidden && lay0.sideW === 0 && lay0.fs === '14px', JSON.stringify(lay0));
  await A.p.click('#btnSideToggle'); await A.p.waitForTimeout(350);
  check('폴더 칸 버튼으로 열림', await A.p.evaluate(() => document.getElementById('side').getBoundingClientRect().width) > 150);
  // 8-2. 폴드 접기(커버 화면 폭) — 보던 메모가 이어짐, 다시 펼치면 3칸
  const openId = await A.p.evaluate(() => document.querySelector('.card.on')?.dataset.id);
  await A.p.setViewportSize({ width: 380, height: 800 }); await A.p.waitForTimeout(300);
  const folded = await A.p.evaluate(() => ({ pane: document.getElementById('app').dataset.pane, edVisible: document.getElementById('editor').getBoundingClientRect().width > 300, listVisible: getComputedStyle(document.getElementById('list')).display !== 'none' }));
  check('접으면(폭 380) 보던 메모가 한 칸으로 이어짐', folded.pane === 'edit' && folded.edVisible && !folded.listVisible, JSON.stringify(folded));
  await A.p.setViewportSize({ width: 1280, height: 800 }); await A.p.waitForTimeout(400);
  const unfolded = await A.p.evaluate(() => ({ list: document.getElementById('list').getBoundingClientRect().width, edit: document.getElementById('edit').getBoundingClientRect().width, on: document.querySelector('.card.on')?.dataset.id }));
  check('펼치면 목록+편집 함께, 같은 메모 선택', unfolded.list > 200 && unfolded.edit > 500 && unfolded.on === openId, JSON.stringify(unfolded));

  // 9. 폴더
  await A.p.click('#btnAddFolder');
  await A.p.fill('.sheet input', '교회');
  await A.p.click('.sheet [data-ok]');
  await sync(A.p); await sync(B.p);
  await B.p.tap('#btnToList').catch(() => {});
  await B.p.evaluate(() => document.getElementById('app').dataset.pane = 'side');
  check('폴더 동기화 (맥 → 폰)', (await B.p.textContent('#folders')).includes('교회'));
  await B.p.evaluate(() => document.getElementById('app').dataset.pane = 'list');

  // 10. 잠금 — 드라이브엔 암호문만
  await A.p.click('.card:not(:has-text("충돌")):has-text("장보기 목록")');
  await A.p.click('#btnMore');
  await A.p.click('#menu >> text=메모 잠그기…');
  const pws = A.p.locator('.sheet input[type=password]');
  await pws.nth(0).fill('1234'); await pws.nth(1).fill('1234');
  await A.p.click('.sheet [data-ok]');
  await A.p.waitForTimeout(200);
  await sync(A.p);
  const locked = driveNotes().find(d => d.data.locked);
  check('잠금: 드라이브 파일에 본문 평문 없음', locked && locked.data.locked && !locked.content.includes('우유') && locked.data.enc?.d);
  await sync(B.p);
  await B.p.tap('.card:not(:has-text("충돌")):has-text("장보기 목록")');
  check('폰: 잠긴 메모는 잠금 화면', await B.p.isVisible('#lockedView'));
  await B.p.tap('#btnUnlock');
  await B.p.fill('.sheet input[type=password]', '1234');
  await B.p.tap('.sheet [data-ok]');
  await B.p.waitForTimeout(400);
  check('폰: 같은 암호로 열림', (await B.p.textContent('#editor')).includes('우유'));
  await B.p.goBack();

  // 11. 삭제 → 폰 휴지통
  await A.p.click('.card:has-text("충돌")');
  await A.p.click('#btnMore');
  await A.p.click('#menu >> text=삭제');
  await sync(A.p); await sync(B.p);
  check('삭제 동기화 (폰에서 최근 삭제됨에 표시)', await B.p.evaluate(() => [...App._test.recs().values()].filter(r => r.trashedAt).length) === 1);

  const names = [...drive.files.values()].map(f => f.name);
  check('드라이브: 레코드당 버전 파일 1개로 정리됨', new Set(names).size === names.length, `${names.length}개`);

  // 11-0. 링크 자동 인식: 주소 + 스페이스 / 주소 + 엔터
  await A.p.click('#btnNew');
  await A.p.keyboard.type('링크 테스트'); await A.p.keyboard.press('Enter');
  await A.p.keyboard.type('여기 https://example.com/a?b=1 봐요');
  await A.p.keyboard.press('Enter');
  await A.p.keyboard.type('https://youtu.be/xyz');
  await A.p.keyboard.press('Enter');
  await A.p.keyboard.type('끝');
  const lk = await A.p.evaluate(() => ({ links: [...document.querySelectorAll('#editor a[href]')].map(a => a.getAttribute('href')), last: document.querySelector('#editor').lastElementChild.textContent }));
  check('링크 자동 인식 (스페이스·엔터로 끝내면 하이퍼링크)', JSON.stringify(lk.links) === JSON.stringify(['https://example.com/a?b=1', 'https://youtu.be/xyz']) && lk.last === '끝', JSON.stringify(lk));

  // 11-0b. 새 메모는 본문으로 시작 + 애플 메모 단축키 + 글자 크게
  await A.p.click('#btnNew');
  check('새 메모 첫 줄은 본문 크기 (제목 서식 없음)', await A.p.evaluate(() => document.querySelector('#editor').firstElementChild.tagName) === 'P');
  await A.p.keyboard.type('단축키 제목'); await A.p.keyboard.press('Control+Shift+KeyT');
  await A.p.keyboard.press('Enter'); await A.p.keyboard.press('Control+Shift+KeyB'); await A.p.keyboard.type('본문 줄');
  await A.p.keyboard.press('Enter'); await A.p.keyboard.press('Control+Shift+KeyL'); await A.p.keyboard.type('할 일 하나');
  await A.p.keyboard.press('Control+Shift+KeyU');
  await A.p.keyboard.press('Enter'); await A.p.keyboard.type('하위 항목'); await A.p.keyboard.press('Control+BracketRight');
  const sc = await A.p.evaluate(() => { const e = document.getElementById('editor'); return { h1: e.querySelector('h1')?.textContent, p: e.querySelector('p')?.textContent, checked: e.querySelector('ul.checklist > li')?.dataset.checked, nested: !!e.querySelector('ul.checklist ul li, ul.checklist li ul, ul ul') }; });
  check('단축키: ⌘⇧T 제목 · ⌘⇧B 본문 · ⌘⇧L 체크리스트 · ⌘⇧U 체크 · ⌘] 들여쓰기', sc.h1 === '단축키 제목' && sc.p === '본문 줄' && sc.checked === 'true' && sc.nested, JSON.stringify(sc));
  await A.p.evaluate(() => { const p = document.querySelector('#editor p'); const r = document.createRange(); r.selectNodeContents(p); getSelection().removeAllRanges(); getSelection().addRange(r); });
  await A.p.keyboard.press('Control+Equal'); await A.p.keyboard.press('Control+Equal');
  const fz = await A.p.evaluate(() => { const s = document.querySelector('#editor p [class*="fz-"]'); return s ? { cls: s.className, size: getComputedStyle(s).fontSize } : null; });
  check('고른 글자 ⌘+ 두 번 → 2단계 크게 (fz-5)', fz && /fz-5/.test(fz.cls) && parseFloat(fz.size) > 17, JSON.stringify(fz));
  await A.p.keyboard.press('Control+Minus');
  check('⌘- 로 한 단계 작게 (fz-4)', await A.p.evaluate(() => !!document.querySelector('#editor p .fz-4')));
  await A.p.click('[data-cmd="format"]');
  const fm = await A.p.evaluate(() => { const m = document.getElementById('menu'); const btns = [...m.querySelectorAll('.seg button')]; return { w: m.offsetWidth, wrapped: btns.filter(b => b.offsetHeight > 40).length, n: btns.length }; });
  check('서식 메뉴: 버튼 글자가 줄바꿈되지 않음', fm.wrapped === 0 && fm.n >= 17, JSON.stringify(fm));
  await A.p.keyboard.press('Escape');

  // 11-1. 긴 글 붙여넣기: 서식 버리고 줄 단위, 화면 안 밀림
  await A.p.click('#btnNew');
  const long = Array.from({ length: 60 }, (_, i) => i % 2 ? `- ${i}번째 줄 설명` : `https://www.youtube.com/watch?v=abc${i}`).join('\n');
  await A.p.evaluate(t => {
    const dt = new DataTransfer(); dt.setData('text/plain', t); dt.setData('text/html', '<h1 style="font-size:40px"><b>' + t.split('\n').join('</b></h1><h1><b>') + '</b></h1>');
    document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, long);
  const pv = await A.p.evaluate(() => {
    const e = document.getElementById('editor');
    return { h1: e.querySelectorAll('h1').length, bold: e.querySelectorAll('b,strong').length, p: e.querySelectorAll('p').length, links: e.querySelectorAll('a[href^="https://www.youtube.com"]').length,
      scroll: document.scrollingElement.scrollTop + document.getElementById('app').scrollTop, headVisible: document.querySelector('.list-head').getBoundingClientRect().top >= 0,
      editH: document.getElementById('edit').getBoundingClientRect().height, vh: innerHeight };
  });
  check('붙여넣기: 서식 없이 줄 단위 (전부 본문, 링크 유지)', pv.h1 === 0 && pv.bold === 0 && pv.p >= 60 && pv.links === 30, JSON.stringify(pv));
  check('긴 글 붙여넣어도 화면이 밀리지 않음', pv.scroll === 0 && pv.headVisible && pv.editH <= pv.vh, JSON.stringify(pv));
  await A.p.screenshot({ path: SHOTS + 'paste-long.png' });

  // 12. 정리·변환
  const s = await A.p.evaluate(() => App._test.sanitize('<p onclick="x()">a<script>alert(1)</script><img src="javascript:1"><a href="javascript:alert(1)">l</a><span style="color:red">r</span></p>'));
  check('붙여넣기 정리: script·onclick·javascript: 제거', !/script|onclick|javascript|style/.test(s), s);
  const md = await A.p.evaluate(() => App._test.htmlToMd('<h1>제목</h1><ul class="checklist"><li data-checked="true">a</li><li data-checked="false">b</li></ul><p><b>굵게</b></p>'));
  check('마크다운 변환', md.includes('# 제목') && md.includes('- [x] a') && md.includes('- [ ] b') && md.includes('**굵게**'), JSON.stringify(md));

  // 13. 맥 메모 가져오기 형식
  const added = await A.p.evaluate(() => App._test.importData({ format: 'apple-notes-export', notes: [{ id: 'apple-1', folderName: '맥 폴더', html: '<div><h1>맥 메모</h1></div><div>내용</div>', createdAt: 1700000000000, updatedAt: 1700000000000 }] }));
  check('맥 메모 가져오기 (폴더 자동 생성)', added === 1 && (await A.p.textContent('#folders')).includes('맥 폴더'));

  // 스크린샷
  await A.p.click('.card:has-text("할 일 테스트")');
  await A.p.screenshot({ path: SHOTS + 'mac-light.png' });
  await A.p.emulateMedia({ colorScheme: 'dark' });
  await A.p.screenshot({ path: SHOTS + 'mac-dark.png' });
  await B.p.screenshot({ path: SHOTS + 'phone-list.png' });
  await B.p.tap('.card:has-text("할 일 테스트")');
  await B.p.screenshot({ path: SHOTS + 'phone-edit.png' });
  await A.ctx.close(); await B.ctx.close();

  // 14. 구글 로그인 리디렉션 (코드 → refresh token)
  const C = await device({});
  await C.p.evaluate(async () => { await DB.setMeta('gcfg', { clientId: 'cid', clientSecret: 'sec' }); localStorage.setItem('sm_pkce', JSON.stringify({ verifier: 'ver123', st: 's1' })); });
  await C.p.goto(BASE + '?code=abc&state=s1');
  await C.p.waitForTimeout(500);
  const ga = await C.p.evaluate(() => DB.getMeta('gauth'));
  const tc = drive.tokenCalls.find(c => c.grant_type === 'authorization_code');
  check('구글 로그인: 코드 교환 → refresh token 저장', ga?.refresh === 'refresh1' && tc?.code_verifier === 'ver123' && tc?.redirect_uri === BASE);
  check('로그인 후 주소창 정리', !C.p.url().includes('code='));
  await C.ctx.close();

  // 15. 오프라인에서 앱 다시 열기 (서비스워커)
  const D = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const dp = await D.newPage();
  dp.on('pageerror', e => errors.push('D: ' + e.message));
  await dp.goto(BASE);
  await dp.evaluate(() => navigator.serviceWorker.ready);
  await dp.reload();
  await dp.click('#btnNew'); await dp.keyboard.type('오프라인 메모'); await dp.keyboard.press('Enter'); await dp.keyboard.type('본문');
  await dp.evaluate(() => App._test.saveNow());
  await D.setOffline(true);
  await dp.reload();
  check('오프라인 상태에서 앱 열림 + 메모 유지', (await dp.textContent('#notes')).includes('오프라인 메모'));
  check('오프라인 표시', (await dp.textContent('#syncText')).length > 0, await dp.textContent('#syncText'));
  await D.close();

  // 16. 터치 제스처: 길게 누르기 메뉴 · 스와이프 고정/삭제
  const G = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const gp = await G.newPage();
  gp.on('pageerror', e => errors.push('G: ' + e.message));
  await gp.goto(BASE);
  for (const t of ['제스처A', '제스처B']) { await gp.click('#fab'); await gp.keyboard.type(t); await gp.evaluate(() => App._test.saveNow()); await gp.goBack(); await gp.waitForTimeout(200); }
  const touch = (title, steps, hold = 0) => gp.evaluate(async ([title, steps, hold]) => {
    const c = [...document.querySelectorAll('#notes .card')].find(x => x.textContent.includes(title));
    const r = c.getBoundingClientRect(), x = r.left + 60, y = r.top + r.height / 2;
    const ev = (type, dx, t) => (t || window).dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: 'touch', clientX: x + dx, clientY: y }));
    ev('pointerdown', 0, c);
    if (hold) await new Promise(r => setTimeout(r, hold));
    for (const dx of steps) { ev('pointermove', dx); await new Promise(r => setTimeout(r, 16)); }
    ev('pointerup', steps.at(-1) || 0);
    c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
  }, [title, steps, hold]);
  await touch('제스처A', [], 650);
  const menu = await gp.evaluate(() => { const m = document.querySelector('#menu'); return m && !m.hidden ? m.textContent : ''; });
  check('길게 누르기 → 메뉴(고정·이동·복제·색상·삭제)', ['고정', '폴더로 이동', '복제', '메모 색상', '삭제'].every(w => menu.includes(w)), menu.slice(0, 60));
  check('길게 누르기 후 메모가 열리지 않음', await gp.evaluate(() => document.querySelector('#app').dataset.pane !== 'edit'));
  await gp.keyboard.press('Escape'); await gp.mouse.click(380, 830).catch(() => {}); await gp.evaluate(() => { const m = document.querySelector('#menu'); if (m) m.hidden = true; });
  const pinOf = t => gp.evaluate(t => [...App._test.recs().values()].find(n => n.kind === 'note' && (n.title || '').includes(t))?.pinned, t);
  await touch('제스처A', [20, 60, 120, 160]);
  check('오른쪽 스와이프 → 고정', await pinOf('제스처A') === true);
  await touch('제스처A', [20, 50]);
  check('짧게 밀면 아무 일 없음(열리지도 않음)', await pinOf('제스처A') === true && await gp.evaluate(() => document.querySelector('#app').dataset.pane !== 'edit'));
  await touch('제스처B', [-20, -60, -120, -160]);
  check('왼쪽 스와이프 → 최근 삭제됨', await gp.evaluate(() => !!([...App._test.recs().values()].find(n => n.kind === 'note' && (n.title || '').includes('제스처B'))?.trashedAt)));
  await G.close();

  // 17. 되돌리기·다시 실행 버튼
  const U = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const up = await U.newPage();
  up.on('pageerror', e => errors.push('U: ' + e.message));
  await up.goto(BASE);
  await up.click('#fab'); await up.keyboard.type('되돌리기A'); await up.keyboard.press('Enter'); await up.keyboard.type('지울글');
  const ed = () => up.evaluate(() => document.querySelector('#editor').innerText);
  await up.tap('#btnUndo');
  const u1 = await ed();
  check('되돌리기 버튼 → 방금 친 글 취소', !u1.includes('지울글') && u1.includes('되돌리기A'), JSON.stringify(u1));
  await up.tap('#btnRedo');
  check('다시 실행 버튼 → 복구', (await ed()).includes('지울글'));
  await up.evaluate(() => App._test.saveNow()); await up.goBack(); await up.waitForTimeout(200);
  await up.click('#fab'); await up.keyboard.type('되돌리기B'); await up.evaluate(() => App._test.saveNow());
  for (let i = 0; i < 5; i++) await up.tap('#btnUndo');
  await up.evaluate(() => App._test.saveNow());
  const a = await up.evaluate(() => [...App._test.recs().values()].find(n => n.kind === 'note' && (n.title || '').includes('되돌리기A'))?.html || '');
  check('다른 메모의 되돌리기가 앞 메모를 건드리지 않음', a.includes('지울글'));
  await U.close();
} catch (e) {
  check('테스트 실행', false, e.stack);
} finally {
  check('페이지 오류 없음', errors.length === 0, errors.slice(0, 5).join(' | '));
  await browser.close(); srv.close();
  const fail = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - fail}/${results.length} 통과`);
  process.exit(fail ? 1 : 0);
}
