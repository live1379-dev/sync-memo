// 구글 드라이브 동기화 — 오너 드라이브의 앱 전용 숨김 폴더(appDataFolder)에 레코드 1개 = 파일 1개.
// 인증: OAuth 코드 + PKCE → refresh token 저장 → 한 번 로그인하면 계속 유지 (서버 없음).
const Sync = (() => {
  const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
  const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN = 'https://oauth2.googleapis.com/token';
  const DRIVE = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const listeners = new Set();
  let state = { status: 'idle', lastSync: 0, error: '' };
  let running = null, again = false;

  const emit = patch => { state = { ...state, ...patch }; listeners.forEach(f => f(state)); };
  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const rand = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const redirectUri = () => new URL('./', location.href).href;

  async function cfg() { return (await DB.getMeta('gcfg')) || {}; }
  async function auth() { return (await DB.getMeta('gauth')) || null; }

  async function login() {
    const c = await cfg();
    if (!c.clientId) throw new Error('설정에서 클라이언트 ID를 먼저 넣어주세요');
    const verifier = rand(48);
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const st = rand(16);
    localStorage.setItem('sm_pkce', JSON.stringify({ verifier, st }));
    const q = new URLSearchParams({
      client_id: c.clientId, redirect_uri: redirectUri(), response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', code_challenge: challenge, code_challenge_method: 'S256', state: st,
    });
    location.href = `${AUTH}?${q}`;
  }

  // 구글에서 돌아왔을 때 (?code=...) 토큰 교환
  async function handleRedirect() {
    const u = new URL(location.href);
    const code = u.searchParams.get('code'), st = u.searchParams.get('state'), err = u.searchParams.get('error');
    if (!code && !err) return false;
    history.replaceState(null, '', redirectUri());
    if (err) { emit({ status: 'error', error: '구글 로그인 취소: ' + err }); return true; }
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('sm_pkce') || '{}'); } catch {}
    localStorage.removeItem('sm_pkce');
    if (saved.st !== st) { emit({ status: 'error', error: '로그인 상태값 불일치 — 다시 시도하세요' }); return true; }
    const c = await cfg();
    const r = await fetch(TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code, client_id: c.clientId, client_secret: c.clientSecret || '', redirect_uri: redirectUri(),
        grant_type: 'authorization_code', code_verifier: saved.verifier,
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.refresh_token) { emit({ status: 'error', error: '토큰 교환 실패: ' + (j.error_description || j.error || r.status) }); return true; }
    await DB.setMeta('gauth', { refresh: j.refresh_token, access: j.access_token, exp: Date.now() + j.expires_in * 1000 });
    emit({ status: 'idle', error: '' });
    return true;
  }

  async function token(force) {
    const a = await auth();
    if (!a) throw Object.assign(new Error('구글 연결 필요'), { code: 'login' });
    if (!force && a.access && a.exp - 60000 > Date.now()) return a.access;
    const c = await cfg();
    const r = await fetch(TOKEN, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret || '', refresh_token: a.refresh, grant_type: 'refresh_token' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') { await DB.delMeta('gauth'); throw Object.assign(new Error('구글 연결이 끊겼어요 — 다시 연결'), { code: 'login' }); }
      throw new Error('토큰 갱신 실패 ' + r.status);
    }
    await DB.setMeta('gauth', { ...a, access: j.access_token, exp: Date.now() + j.expires_in * 1000 });
    return j.access_token;
  }

  async function api(url, opts = {}, retry = true) {
    const t = await token();
    const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + t } });
    if (r.status === 401 && retry) { await token(true); return api(url, opts, false); }
    if (!r.ok) throw new Error(`드라이브 오류 ${r.status}`);
    return r;
  }

  async function listAll() {
    const files = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', fields: 'nextPageToken,files(id,name,appProperties)', pageSize: '1000' });
      if (pageToken) q.set('pageToken', pageToken);
      const j = await (await api(`${DRIVE}/files?${q}`)).json();
      files.push(...(j.files || []));
      pageToken = j.nextPageToken || '';
    } while (pageToken);
    return files;
  }

  const download = async id => (await api(`${DRIVE}/files/${id}?alt=media`)).json();

  // 버전 파일은 덮어쓰지 않고 항상 새로 만든다 (create-only) — 두 기기가 동시에 올려도 어느 쪽도 사라지지 않는다.
  // appProperties: k = 레코드 key, u = 이 버전의 updatedAt, p = 이 버전이 고친 원래 버전(u)
  async function upload(rec) {
    const meta = { name: rec.key + '.json', parents: ['appDataFolder'], appProperties: { k: rec.key, u: String(rec.updatedAt), p: String(rec._base || 0) } };
    const b = 'smb' + rand(8);
    const body = new Blob([
      `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
      `--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(strip(rec))}\r\n--${b}--`,
    ]);
    await api(`${UPLOAD}/files?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  }
  const remove = id => api(`${DRIVE}/files/${id}`, { method: 'DELETE' }).catch(() => {});

  function strip(rec) {
    const o = {};
    for (const k in rec) if (k[0] !== '_') o[k] = rec[k];
    return o;
  }
  const BANNER = '<p><b>⚠ 충돌 사본</b> — 두 기기에서 동시에 고친 내용입니다. 확인 후 지워주세요.</p>';
  function conflictCopy(r, u) {
    const nid = r.id + '~' + Number(u).toString(36); // 결정적 id: 두 기기가 같은 충돌을 풀어도 사본은 하나
    return { ...strip(r), key: 'note-' + nid, id: nid, pinned: false, conflictOf: r.id, title: (r.title || '메모') + ' (충돌 사본)',
      text: (r.text || '') + '\n⚠ 충돌 사본', html: (r.html || '') + BANNER, updatedAt: Date.now(), _dirty: true, _base: 0 };
  }

  // 한 번 동기화: 1) 원격의 새 버전 받기(갈라졌으면 사본) 2) 이 기기 변경 올리기 3) 반영 끝난 옛 버전 지우기
  async function runOnce() {
    if (!navigator.onLine) { emit({ status: 'offline' }); return; }
    if (!(await auth())) { emit({ status: 'login' }); return; }
    emit({ status: 'syncing', error: '' });
    let changed = false;
    const byKey = new Map(), garbage = new Set();
    for (const f of await listAll()) {
      const key = f.appProperties?.k || (f.name || '').replace(/\.json$/, '');
      if (!/^(note|folder)-/.test(key)) continue;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ id: f.id, u: Number(f.appProperties?.u || 0), p: Number(f.appProperties?.p || 0) });
    }
    for (const [key, vs] of byKey) {
      // head = 다른 버전이 이어 고치지 않은 버전
      const heads = vs.filter(v => !vs.some(w => w !== v && w.p >= v.u));
      vs.filter(v => !heads.includes(v)).forEach(v => garbage.add(v.id));
      const cur = await DB.get(key);
      const base = cur?._base || 0;
      const others = heads.filter(h => h.u !== base); // 내가 아는 버전(base) 말고 다른 끝 버전 = 새 정보
      if (!others.length) continue;
      for (const h of others) h.data = await download(h.id);
      const now = await DB.get(key); // 다운로드 중 편집했을 수도
      const mine = heads.find(h => h.u === base);
      const cands = others.map(h => ({ rec: h.data, u: h.u, id: h.id }));
      if (now && (now._dirty || mine)) cands.push({ rec: now, u: now._dirty ? now.updatedAt : base, id: mine?.id, local: true });
      const order = (a, b) => (a.rec.updatedAt || 0) - (b.rec.updatedAt || 0) || a.u - b.u;
      cands.sort(order);
      let win = cands[cands.length - 1];
      const sig = r => { const o = strip(r); delete o.updatedAt; return JSON.stringify(o); };
      if (win.local && !now._dirty && cands.every(c => sig(c.rec) === sig(now))) win = cands.filter(c => !c.local).sort((a, b) => a.u - b.u).pop(); // 내용이 같으면 다시 올리지 않는다
      if (key.startsWith('note-')) {
        for (const c of cands) {
          if (c === win) continue;
          const r = c.rec, w = win.rec;
          if (r.purged || w.purged || r.locked || w.locked || (r.html || '') === (w.html || '')) continue; // 같은 내용·잠금·삭제는 최신 것만
          const cp = conflictCopy(r, c.u);
          if (!(await DB.get(cp.key))) await DB.put(cp);
        }
      }
      const maxU = Math.max(...heads.map(h => h.u));
      if (win.local) await DB.put({ ...now, updatedAt: Math.max(now.updatedAt, maxU + 1), _base: maxU, _dirty: true }); // 내 것이 최신 → 새 버전이 모든 끝 버전을 대체
      else {
        await DB.put({ ...strip(win.rec), key, _base: win.u, _dirty: false });
        heads.filter(h => h.id !== win.id).forEach(h => garbage.add(h.id)); // 진 쪽 내용은 사본으로 보존됨
      }
      changed = true;
    }
    for (const rec of (await DB.all()).filter(r => r._dirty)) {
      await upload(rec);
      (byKey.get(rec.key) || []).filter(v => v.u <= (rec._base || 0)).forEach(v => garbage.add(v.id));
      const cur = await DB.get(rec.key);
      const done = { ...cur, _base: Math.max(cur._base || 0, rec.updatedAt) }; // 올리는 중 또 고쳤으면 dirty 유지, 다음 버전은 이걸 이어받음
      if (cur.updatedAt === rec.updatedAt) done._dirty = false;
      await DB.put(done);
    }
    for (const id of garbage) await remove(id);
    const now = Date.now();
    await DB.setMeta('lastSync', now);
    emit({ status: 'synced', lastSync: now });
    if (changed) App.onRemoteChange();
  }
  async function run() {
    if (running) { again = true; return running; }
    running = (async () => {
      try {
        do { again = false; await runOnce(); } while (again);
      } catch (e) {
        if (e.code === 'login') emit({ status: 'login', error: e.message });
        else if (!navigator.onLine) emit({ status: 'offline' });
        else emit({ status: 'error', error: e.message });
      } finally { running = null; }
    })();
    return running;
  }

  let timer;
  const soon = (ms = 3000) => { clearTimeout(timer); timer = setTimeout(run, ms); };

  async function init() {
    emit({ lastSync: (await DB.getMeta('lastSync')) || 0 });
    await handleRedirect().catch(e => emit({ status: 'error', error: e.message }));
    if (!(await auth())) emit({ status: (await cfg()).clientId ? 'login' : 'nosetup' });
    addEventListener('online', () => run());
    addEventListener('offline', () => emit({ status: 'offline' }));
    document.addEventListener('visibilitychange', () => { if (!document.hidden) run(); });
    setInterval(() => { if (!document.hidden) run(); }, 30000);
    run();
  }

  async function logout() { await DB.delMeta('gauth'); emit({ status: 'login' }); }

  return { init, run, soon, login, logout, cfg, auth, on: f => { listeners.add(f); f(state); }, get state() { return state; } };
})();
