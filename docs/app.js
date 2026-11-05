// 싱크 메모 — 애플 메모 + 삼성 노트의 좋은 점을 합친 오프라인 우선 메모 앱
const App = (() => {
  const VERSION = '1.2.0';
  const $ = s => document.querySelector(s);
  const app = $('#app'), editor = $('#editor'), menuEl = $('#menu'), modalEl = $('#modal'), sheet = $('#sheet');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isMobile = () => matchMedia('(max-width: 760px)').matches;
  const DAY = 86400000, TRASH_DAYS = 30;
  const TAG_RE = /(^|[\s(])#([\p{L}\p{N}_-]{1,30})/gu;
  const COLORS = { red: '#e5484d', orange: '#f08c00', yellow: '#e6b800', green: '#30a46c', blue: '#2d7ff9', purple: '#8e4ec6', gray: '#8b8d98' };
  const CNAME = { red: '빨강', orange: '주황', yellow: '노랑', green: '초록', blue: '파랑', purple: '보라', gray: '회색' };
  const HL = { yellow: '#ffe58a', green: '#c6f0c2', blue: '#c7e0ff', pink: '#ffd0e3', purple: '#e3d2ff' };
  const TC = { red: '#e5484d', orange: '#e5800f', green: '#2f9e55', blue: '#2d7ff9', purple: '#8e4ec6' };
  const ICON = {
    all: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    pin: '<svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 6 4 4H6l4-4-1-6Z"/></svg>',
    todo: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="6" height="6" rx="3"/><path d="M12 7h9M12 17h9"/><rect x="3" y="14" width="6" height="6" rx="3"/></svg>',
    lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    img: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/></svg>',
  };

  let recs = new Map();
  let view = { type: 'all' };
  let curId = null, loadedVer = 0, pendingSave = false, saveTimer = null, deferReload = false;
  let q = '';
  let prefs = { layout: 'list', sort: 'updated', checkedToBottom: true, theme: 'auto', sideHidden: true, fontSize: 'm' };
  const FS = { s: '13px', m: '14px', l: '16px' }, FSN = { s: '작게', m: '보통', l: '크게' };
  let lockPw = null, lockTimer = null;
  const unlocked = new Map(); // 잠금 풀린 메모의 평문 (메모리에만)
  const keyCache = new Map();
  let lastRange = null;

  // ───────── 데이터 ─────────
  const notes = () => [...recs.values()].filter(r => r.kind === 'note' && !r.purged);
  const folders = () => [...recs.values()].filter(r => r.kind === 'folder' && !r.deleted).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name, 'ko'));
  const cur = () => (curId ? recs.get('note-' + curId) : null);

  // 동기화가 저장소에 써 둔 로컬 전용 필드(_fileId·_base)를 메모리 사본에 합친다 — 안 하면 드라이브에 중복 파일이 생긴다
  async function fresh(rec) {
    const d = await DB.get(rec.key);
    if (d) { rec._fileId = d._fileId || rec._fileId; rec._base = Math.max(d._base || 0, rec._base || 0); }
    return rec;
  }
  async function refreshMeta() {
    for (const d of await DB.all()) {
      const m = recs.get(d.key);
      if (m && m.updatedAt === d.updatedAt) { m._fileId = d._fileId; m._base = d._base; m._dirty = d._dirty; }
    }
  }
  async function persist(rec) {
    await fresh(rec);
    rec.updatedAt = Math.max(Date.now(), (rec.updatedAt || 0) + 1, (rec._base || 0) + 1);
    rec._dirty = true;
    recs.set(rec.key, rec);
    await DB.put(rec);
    if (SINGLE) bc?.postMessage({ t: 'sync' }); else Sync.soon();
    bc?.postMessage({ t: 'changed', key: rec.key });
  }
  // 메모 창이 여러 개일 때(맥 더블클릭 새 창) 서로 변경을 알린다. 동기화는 본 창만.
  const SINGLE = new URLSearchParams(location.search).get('single') === '1';
  const bc = 'BroadcastChannel' in window ? new BroadcastChannel('sync-memo') : null;
  if (bc) bc.onmessage = e => {
    if (e.data?.t === 'sync' && !SINGLE) Sync.soon(1500);
    if (e.data?.t === 'changed') onRemoteChange(true);
  };
  async function reload() { recs = new Map((await DB.all()).map(r => [r.key, r])); }

  function textOf(html) {
    const d = new DOMParser().parseFromString('<body>' + html.replace(/<\/(p|div|h[1-6]|li|pre|tr|blockquote)>|<br\s*\/?>/gi, '$&\n') + '</body>', 'text/html');
    return d.body.textContent || '';
  }
  function derive(rec, text) {
    const html = rec.locked ? (unlocked.get(rec.id) || '') : (rec.html || '');
    if (text == null) text = textOf(html);
    const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
    if (!rec.locked || unlocked.has(rec.id)) rec.title = (lines[0] || '').slice(0, 100);
    rec.text = rec.locked ? '' : text;
    rec.tags = rec.locked ? [] : [...new Set([...text.matchAll(TAG_RE)].map(m => m[2]))];
    const total = (html.match(/data-checked="(true|false)"/g) || []).length;
    rec.chk = total ? [(html.match(/data-checked="true"/g) || []).length, total] : null;
    rec.hasMedia = /<(img|audio)\b/i.test(html);
  }
  function newNoteRec(html = '<h1><br></h1>') {
    const id = uid(), now = Date.now();
    const rec = { key: 'note-' + id, kind: 'note', id, html, createdAt: now, updatedAt: now, folderId: view.type === 'folder' ? view.id : null, pinned: view.type === 'pinned' };
    derive(rec);
    return rec;
  }

  // ───────── 정리 (sanitize) ─────────
  const KEEP = new Set('P DIV BR H1 H2 H3 B STRONG I EM U S STRIKE DEL MARK SPAN UL OL LI PRE CODE BLOCKQUOTE TABLE THEAD TBODY TR TD TH IMG A AUDIO HR SUB SUP'.split(' '));
  const DROP = new Set('SCRIPT STYLE IFRAME OBJECT EMBED LINK META TITLE FORM INPUT BUTTON TEXTAREA SELECT SVG MATH NOSCRIPT TEMPLATE VIDEO CANVAS'.split(' '));
  const CLS = /^(checklist|hl-(yellow|green|blue|pink|purple)|tc-(red|orange|green|blue|purple)|att|lbl|drawing|tag)$/;
  function sanitize(html) {
    const d = new DOMParser().parseFromString('<body>' + (html || '') + '</body>', 'text/html');
    clean(d.body);
    return d.body.innerHTML;
  }
  function clean(node) {
    for (const el of [...node.children]) {
      const t = el.tagName;
      if (DROP.has(t)) { el.remove(); continue; }
      clean(el);
      if (/^H[4-6]$/.test(t)) { const h = el.ownerDocument.createElement('h3'); h.append(...el.childNodes); el.replaceWith(h); continue; }
      if (!KEEP.has(t)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) {
        const n = a.name;
        const ok = n === 'class' || n === 'alt' || n === 'colspan' || n === 'rowspan'
          || (n === 'data-checked' && t === 'LI') || (n === 'data-note' && t === 'A') || (n === 'href' && t === 'A')
          || (/^data-(strokes|w|h)$/.test(n) && t === 'IMG') || (n === 'src' && (t === 'IMG' || t === 'AUDIO'))
          || (n === 'controls' && t === 'AUDIO') || (n === 'contenteditable' && t === 'DIV');
        if (!ok) el.removeAttribute(n);
      }
      if (el.hasAttribute('class')) {
        const c = [...el.classList].filter(x => CLS.test(x));
        c.length ? (el.className = c.join(' ')) : el.removeAttribute('class');
      }
      if (t === 'A' && !/^(https?:|mailto:|tel:|#)/i.test(el.getAttribute('href') || '')) el.removeAttribute('href');
      if ((t === 'IMG' || t === 'AUDIO') && !/^(data:(image|audio)\/|https:)/i.test(el.getAttribute('src') || '')) el.remove();
      if (t === 'SPAN' && !el.attributes.length) el.replaceWith(...el.childNodes);
    }
  }

  // ───────── 암호 (잠금 메모) ─────────
  const te = new TextEncoder(), td = new TextDecoder();
  function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  async function keyFor(pw, salt) {
    const ck = pw + '|' + salt;
    if (keyCache.has(ck)) return keyCache.get(ck);
    const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveKey']);
    const k = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: fromB64(salt), iterations: 210000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    keyCache.set(ck, k);
    return k;
  }
  async function encrypt(html, pw, salt) {
    salt = salt || toB64(crypto.getRandomValues(new Uint8Array(16)));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(pw, salt), te.encode(html));
    return { s: salt, i: toB64(iv), d: toB64(new Uint8Array(ct)) };
  }
  async function decrypt(enc, pw) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(enc.i) }, await keyFor(pw, enc.s), fromB64(enc.d));
    return td.decode(pt);
  }
  function touchLock() {
    clearTimeout(lockTimer);
    if (lockPw) lockTimer = setTimeout(lockAll, 10 * 60000);
  }
  function lockAll() {
    lockPw = null; keyCache.clear(); unlocked.clear();
    if (cur()?.locked) renderEditor();
  }

  // ───────── 사이드바 ─────────
  const VIEWS = [
    { type: 'all', name: '모든 메모', icon: 'all' },
    { type: 'pinned', name: '고정됨', icon: 'pin' },
    { type: 'todo', name: '할 일 남은 메모', icon: 'todo' },
    { type: 'locked', name: '잠긴 메모', icon: 'lock' },
    { type: 'trash', name: '최근 삭제됨', icon: 'trash' },
  ];
  function countOf(v) {
    const live = notes().filter(n => !n.trashedAt);
    switch (v.type) {
      case 'all': return live.length;
      case 'pinned': return live.filter(n => n.pinned).length;
      case 'todo': return live.filter(n => n.chk && n.chk[0] < n.chk[1]).length;
      case 'locked': return live.filter(n => n.locked).length;
      case 'trash': return notes().filter(n => n.trashedAt).length;
      case 'folder': return live.filter(n => n.folderId === v.id).length;
      case 'tag': return live.filter(n => n.tags?.includes(v.id)).length;
    }
    return 0;
  }
  const same = (a, b) => a.type === b.type && (a.id || null) === (b.id || null);
  function viewName(v) {
    if (v.type === 'folder') return recs.get('folder-' + v.id)?.name || '폴더';
    if (v.type === 'tag') return '#' + v.id;
    return VIEWS.find(x => x.type === v.type)?.name || '';
  }
  function renderSide() {
    $('#views').innerHTML = VIEWS.map(v => {
      const n = countOf(v);
      if ((v.type === 'locked' || v.type === 'todo' || v.type === 'pinned') && !n) return '';
      return `<a data-type="${v.type}" class="${same(v, view) ? 'on' : ''}">${ICON[v.icon]}<span>${v.name}</span><span class="n">${n || ''}</span></a>`;
    }).join('');
    $('#folders').innerHTML = folders().map(f => {
      const v = { type: 'folder', id: f.id };
      return `<a data-type="folder" data-id="${esc(f.id)}" class="${same(v, view) ? 'on' : ''}"><i class="sw" style="background:${COLORS[f.color] || COLORS.gray}"></i><span>${esc(f.name)}</span><span class="n">${countOf(v) || ''}</span></a>`;
    }).join('');
    const tagCount = new Map();
    notes().filter(n => !n.trashedAt).forEach(n => (n.tags || []).forEach(t => tagCount.set(t, (tagCount.get(t) || 0) + 1)));
    const tags = [...tagCount].sort((a, b) => b[1] - a[1]).slice(0, 40);
    $('#tagSec').hidden = !tags.length;
    $('#tags').innerHTML = tags.map(([t, n]) => `<a data-type="tag" data-id="${esc(t)}" class="${same({ type: 'tag', id: t }, view) ? 'on' : ''}">#${esc(t)}<span class="n">${n}</span></a>`).join('');
  }
  function setView(v) {
    view = v; q = ''; $('#q').value = '';
    renderSide(); renderList();
    if (isMobile() && app.dataset.pane === 'side') history.back();
  }

  // ───────── 목록 ─────────
  const sortField = () => (prefs.sort === 'created' ? 'createdAt' : 'updatedAt');
  function filtered() {
    let arr = notes();
    if (view.type === 'trash') arr = arr.filter(n => n.trashedAt);
    else {
      arr = arr.filter(n => !n.trashedAt);
      if (view.type === 'pinned') arr = arr.filter(n => n.pinned);
      if (view.type === 'todo') arr = arr.filter(n => n.chk && n.chk[0] < n.chk[1]);
      if (view.type === 'locked') arr = arr.filter(n => n.locked);
      if (view.type === 'folder') arr = arr.filter(n => n.folderId === view.id);
      if (view.type === 'tag') arr = arr.filter(n => n.tags?.includes(view.id));
    }
    if (q) {
      const t = q.toLowerCase();
      arr = arr.filter(n => (n.title || '').toLowerCase().includes(t) || (n.text || '').toLowerCase().includes(t) || (n.tags || []).some(x => ('#' + x).toLowerCase().includes(t)));
    }
    const f = sortField();
    arr.sort((a, b) => {
      if (view.type !== 'trash' && !!b.pinned - !!a.pinned) return !!b.pinned - !!a.pinned;
      if (prefs.sort === 'title') return (a.title || '').localeCompare(b.title || '', 'ko');
      return (b[f] || 0) - (a[f] || 0);
    });
    return arr;
  }
  function groupOf(ts) {
    const now = new Date(), d = new Date(ts);
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (ts >= start) return '오늘';
    if (ts >= start - DAY) return '어제';
    if (ts >= start - 7 * DAY) return '지난 7일';
    if (ts >= start - 30 * DAY) return '지난 30일';
    return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}월` : `${d.getFullYear()}년 ${d.getMonth() + 1}월`;
  }
  function fmtShort(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
    if (now - d < 7 * DAY) return d.toLocaleDateString('ko-KR', { weekday: 'short' });
    return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}. ${d.getDate()}.` : `${String(d.getFullYear()).slice(2)}. ${d.getMonth() + 1}. ${d.getDate()}.`;
  }
  const fmtLong = ts => new Date(ts).toLocaleString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' });
  function hilite(s) {
    const e = esc(s);
    if (!q) return e;
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return e;
    return esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  }
  function snippetOf(n) {
    if (n.locked) return '잠긴 메모';
    const lines = (n.text || '').split('\n').map(s => s.trim()).filter(Boolean);
    let s = lines.slice(1).join(' ');
    if (q) {
      const i = s.toLowerCase().indexOf(q.toLowerCase());
      if (i > 30) s = '…' + s.slice(i - 20);
    }
    return s.slice(0, 160) || (n.hasMedia ? '첨부 파일' : '추가 텍스트 없음');
  }
  const thumbOf = n => (n.locked || !n.hasMedia ? null : (n.html.match(/<img[^>]+src="(data:image[^"]+)"/) || [])[1]);
  function renderList() {
    const arr = filtered();
    const el = $('#notes');
    el.className = prefs.layout === 'grid' ? 'grid' : '';
    $('#listTitle').textContent = viewName(view);
    $('#backLabel').textContent = viewName(view);
    $('#trashBar').hidden = view.type !== 'trash' || !arr.length;
    const f = sortField();
    let html = '', lastG = '';
    for (const n of arr) {
      let g = '';
      if (n.pinned && view.type !== 'trash') g = '고정됨';
      else if (prefs.sort !== 'title') g = groupOf(n[f] || n.updatedAt);
      else g = prefs.layout === 'grid' ? '' : '메모';
      if (g && g !== lastG) { html += `<div class="grp">${g}</div>`; lastG = g; }
      const fo = n.folderId && view.type !== 'folder' ? recs.get('folder-' + n.folderId) : null;
      const th = thumbOf(n);
      html += `<a class="card${n.id === curId ? ' on' : ''}${th ? ' has-thumb' : ''}" data-id="${n.id}"${n.color ? ` data-color="${n.color}"` : ''}>`
        + (th ? `<img class="thumb" src="${th}" alt="" loading="lazy">` : '')
        + `<div class="t">${n.locked ? ICON.lock : ''}${hilite(n.title || '새 메모')}</div>`
        + `<div class="s"><time>${view.type === 'trash' ? Math.max(0, TRASH_DAYS - Math.floor((Date.now() - n.trashedAt) / DAY)) + '일 남음' : fmtShort(n[f] || n.updatedAt)}</time>${hilite(snippetOf(n))}</div>`
        + `<div class="meta">${fo && !fo.deleted ? `<span class="fold"><i style="background:${COLORS[fo.color] || COLORS.gray}"></i>${esc(fo.name)}</span>` : ''}${n.chk ? `<span class="${n.chk[0] === n.chk[1] ? 'chk' : ''}">☑ ${n.chk[0]}/${n.chk[1]}</span>` : ''}${(n.tags || []).slice(0, 3).map(t => '#' + esc(t)).join(' ')}</div>`
        + `</a>`;
    }
    el.innerHTML = html || `<div class="empty-list">${q ? '검색 결과가 없습니다' : view.type === 'trash' ? '삭제된 메모가 없습니다' : '메모가 없습니다'}</div>`;
    $('#count').textContent = arr.length ? `메모 ${arr.length}개` : '';
  }

  // ───────── 편집기 ─────────
  // 포커스는 터치한 그 순간 동기적으로 줘야 폰 키보드가 뜬다 — 저장은 뒤에서
  function openNote(id, opts = {}) {
    const leaving = curId && curId !== id ? leaveNote() : null;
    curId = id;
    renderEditor();
    renderList();
    if (isMobile() && app.dataset.pane !== 'edit') { history.pushState({ pane: 'edit' }, ''); app.dataset.pane = 'edit'; }
    if (opts.focus) focusStart();
    return leaving;
  }
  function renderEditor() {
    const n = cur();
    app.classList.toggle('no-note', !n);
    $('#edit').classList.remove('locked');
    $('#lockedView').hidden = true;
    if (!n) { editor.innerHTML = ''; $('#edit').removeAttribute('data-color'); return; }
    n.color ? ($('#edit').dataset.color = n.color) : $('#edit').removeAttribute('data-color');
    $('#btnPin').classList.toggle('on', !!n.pinned);
    $('#editMeta').textContent = fmtLong(n.updatedAt);
    const trashed = !!n.trashedAt;
    if (n.locked && !unlocked.has(n.id)) {
      $('#edit').classList.add('locked');
      $('#lockedView').hidden = false;
      editor.innerHTML = '';
      return;
    }
    editor.innerHTML = sanitize(n.locked ? unlocked.get(n.id) : n.html);
    editor.contentEditable = trashed ? 'false' : 'true';
    linkifyIn(editor); // 예전 메모의 주소 글자도 링크로 (저장은 다음 편집 때)
    if (SINGLE && Native.platform === 'mac') Native.call('setTitle', { title: n.title || '메모' }).catch(() => {});
    loadedVer = n.updatedAt;
    deferReload = false;
  }
  function focusStart() {
    editor.focus();
    const first = editor.firstElementChild || editor;
    const r = document.createRange();
    r.selectNodeContents(first); r.collapse(false);
    const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  }
  function scheduleSave() {
    pendingSave = true;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 350);
  }
  async function saveNow() {
    clearTimeout(saveTimer);
    if (!pendingSave) return;
    pendingSave = false;
    const n = cur();
    if (!n || n.trashedAt) return;
    const html = editor.innerHTML, text = editor.innerText;
    if (n.locked) {
      if (!lockPw || !unlocked.has(n.id)) return;
      unlocked.set(n.id, html);
      n.enc = await encrypt(html, lockPw, n.enc?.s);
      touchLock();
    } else n.html = html;
    derive(n, text);
    await persist(n);
    loadedVer = n.updatedAt;
    $('#editMeta').textContent = fmtLong(n.updatedAt);
    renderList(); renderSide();
  }
  const isBlank = n => !n.locked && !n.hasMedia && !(n.text || '').trim();
  async function leaveNote() {
    const n = cur(), saving = saveNow(); // saveNow 는 편집기 내용을 동기적으로 먼저 읽는다
    await saving;
    if (n && !n.trashedAt && isBlank(n)) { await purge(n, true); renderList(); renderSide(); }
  }
  async function purge(n, quiet) {
    await fresh(n);
    if (!n._base) { recs.delete(n.key); await DB.del(n.key); }
    else {
      const t = { key: n.key, kind: 'note', id: n.id, purged: true, updatedAt: n.updatedAt, _fileId: n._fileId, _base: n._base };
      await persist(t);
    }
    unlocked.delete(n.id);
    if (curId === n.id) { curId = null; renderEditor(); }
    if (!quiet) { renderList(); renderSide(); }
  }

  async function newNote(html, folderId) {
    if (view.type === 'trash' || view.type === 'locked' || view.type === 'todo') setView({ type: 'all' });
    const rec = newNoteRec(html);
    if (folderId !== undefined) rec.folderId = folderId;
    if (view.type === 'tag') rec.html += `<p>#${esc(view.id)}</p>`;
    if (view.type === 'tag' || html) derive(rec);
    recs.set(rec.key, rec);
    await openNote(rec.id, { focus: true }); // 포커스는 여기서 즉시, await 는 이전 메모 저장
    if (isBlank(rec)) await DB.put(rec); else await persist(rec); // 빈 메모는 내용이 생길 때까지 올리지 않는다
    renderSide();
  }

  // 선택 영역 보관 (메뉴·파일창이 포커스를 뺏어도 복원)
  document.addEventListener('selectionchange', () => {
    const s = getSelection();
    if (s.rangeCount && editor.contains(s.anchorNode)) lastRange = s.getRangeAt(0).cloneRange();
  });
  function restoreSel() {
    if (document.activeElement !== editor) editor.focus({ preventScroll: true });
    const s = getSelection();
    if (lastRange && editor.contains(lastRange.startContainer)) { s.removeAllRanges(); s.addRange(lastRange); }
    else if (!s.rangeCount || !editor.contains(s.anchorNode)) {
      const r = document.createRange(); r.selectNodeContents(editor); r.collapse(false); s.removeAllRanges(); s.addRange(r);
    }
  }
  function exec(cmd, val) { restoreSel(); document.execCommand(cmd, false, val); afterEdit(); }
  // ───────── 링크 자동 인식 ─────────
  const URL_RE = /https?:\/\/[^\s<>"']*[^\s<>"'.,;:!?)\]}>]/g;
  function caretOffset(block) {
    const sel = getSelection();
    if (!sel.rangeCount || !block.contains(sel.anchorNode)) return -1;
    const r = document.createRange(); r.selectNodeContents(block); r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  }
  function setCaretOffset(block, off) {
    const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let n, left = off;
    while ((n = w.nextNode())) {
      if (left <= n.data.length) { const r = document.createRange(); r.setStart(n, left); r.collapse(true); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return; }
      left -= n.data.length;
    }
  }
  // root 안의 링크 아닌 주소 글자를 <a> 로 바꾼다. 커서가 그 안에 있으면 위치 유지.
  function linkifyIn(root) {
    if (!root) return false;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement.closest('a,pre,code') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const hits = [];
    while (w.nextNode()) { URL_RE.lastIndex = 0; if (URL_RE.test(w.currentNode.data)) hits.push(w.currentNode); }
    if (!hits.length) return false;
    const block = root === editor ? null : root, off = block ? caretOffset(block) : -1;
    for (const node of hits) {
      const frag = document.createDocumentFragment(), t = node.data;
      let last = 0, m;
      URL_RE.lastIndex = 0;
      while ((m = URL_RE.exec(t))) {
        if (m.index > last) frag.append(t.slice(last, m.index));
        const a = document.createElement('a'); a.href = m[0]; a.textContent = m[0]; frag.append(a);
        last = m.index + m[0].length;
      }
      if (last < t.length) frag.append(t.slice(last));
      node.replaceWith(frag);
    }
    if (off >= 0) setCaretOffset(block, off);
    return true;
  }
  const blockOf = () => caretEl('p,h1,h2,h3,li,blockquote,td,th,div:not(.att)');
  // 스페이스·엔터로 주소를 끝냈을 때 그 줄(과 엔터면 윗줄)을 링크로
  function autoLink(e) {
    const space = e.inputType === 'insertText' && /\s/.test(e.data || ''), enter = e.inputType === 'insertParagraph';
    if (!space && !enter) return;
    const b = blockOf();
    let changed = false;
    if (enter && b) changed = linkifyIn(b.previousElementSibling) || changed;
    if (space && b) changed = linkifyIn(b) || changed;
    if (changed) scheduleSave();
  }

  // 여러 줄 글을 문단으로 넣는다. 첫 줄은 지금 커서 자리(새 메모면 제목), 둘째 줄부터는 본문 크기. 주소만 있는 줄은 링크.
  function pastePlain(text) {
    restoreSel();
    const lines = text.replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').split('\n');
    while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
    lines.forEach((line, i) => {
      if (i) {
        document.execCommand('insertParagraph');
        if (caretEl('h1,h2,h3,pre')) document.execCommand('formatBlock', false, '<p>');
      }
      const t = line.trim();
      if (/^https?:\/\/\S+$/.test(t)) document.execCommand('insertHTML', false, `<a href="${esc(t)}">${esc(t)}</a>`);
      else if (line) document.execCommand('insertText', false, line);
    });
    [...editor.children].forEach(b => b.contains(getSelection().anchorNode) || linkifyIn(b));
    linkifyIn(blockOf());
    afterEdit();
    const r = getSelection().rangeCount && getSelection().getRangeAt(0).getBoundingClientRect();
    if (r && r.bottom > $('#paper').getBoundingClientRect().bottom) caretEl('p,h1,h2,h3,li,div,pre')?.scrollIntoView({ block: 'nearest' });
  }
  function insertHTML(html) { restoreSel(); document.execCommand('insertHTML', false, html); afterEdit(); }
  function afterEdit() { fixColors(); normalizeChecklists(); scheduleSave(); }
  function caretEl(sel = 'li') {
    const s = getSelection();
    if (!s.rangeCount) return null;
    let n = s.anchorNode;
    if (n && n.nodeType === 3) n = n.parentElement;
    const el = n?.closest?.(sel);
    return el && editor.contains(el) ? el : null;
  }

  // 형광펜·글자색: execCommand 가 만든 style 을 클래스로 바꾼다
  const norm = c => { const d = document.createElement('div'); d.style.color = c; return d.style.color; };
  let HLN, TCN;
  function fixColors() {
    HLN = HLN || Object.fromEntries(Object.entries(HL).map(([k, v]) => [norm(v), k]));
    TCN = TCN || Object.fromEntries(Object.entries(TC).map(([k, v]) => [norm(v), k]));
    editor.querySelectorAll('font[color]').forEach(f => {
      const k = TCN[norm(f.getAttribute('color'))];
      const s = document.createElement('span'); if (k) s.className = 'tc-' + k; s.append(...f.childNodes); f.replaceWith(s);
    });
    editor.querySelectorAll('[style]').forEach(el => {
      const bg = el.style.backgroundColor, co = el.style.color;
      if (el.tagName === 'SPAN' && (HLN[bg] || TCN[co])) {
        let inner = el;
        if (HLN[bg]) { const m = document.createElement('mark'); m.className = 'hl-' + HLN[bg]; m.append(...el.childNodes); el.replaceWith(m); inner = m; }
        if (TCN[co]) { const s = document.createElement('span'); s.className = 'tc-' + TCN[co]; s.append(...inner.childNodes); inner.append(s); }
      } else el.removeAttribute('style');
    });
  }
  function unwrapIn(selector) {
    restoreSel();
    const s = getSelection(); if (!s.rangeCount) return;
    const r = s.getRangeAt(0);
    editor.querySelectorAll(selector).forEach(el => { if (r.intersectsNode(el)) el.replaceWith(...el.childNodes); });
    afterEdit();
  }
  function color(cmd, hex) {
    restoreSel();
    document.execCommand('styleWithCSS', false, true);
    document.execCommand(cmd, false, hex);
    document.execCommand('styleWithCSS', false, false);
    afterEdit();
  }

  // 체크리스트
  function normalizeChecklists(paragraph) {
    // 크롬이 <p> 안에 목록을 넣는 경우(<p><ul>) 목록을 밖으로 꺼낸다 — 커서 위치는 유지
    const bad = editor.querySelectorAll('p > ul, p > ol');
    if (bad.length) {
      const sel = getSelection(), r = sel.rangeCount ? sel.getRangeAt(0) : null;
      const pos = r && [r.startContainer, r.startOffset];
      bad.forEach(l => { const p = l.parentElement; const rest = [...p.childNodes].filter(n => n !== l && !(n.nodeName === 'BR' || (n.nodeType === 3 && !n.textContent.trim()))); rest.length ? p.after(l) : p.replaceWith(l); });
      if (pos && editor.contains(pos[0])) { const nr = document.createRange(); nr.setStart(pos[0], Math.min(pos[1], pos[0].length ?? pos[0].childNodes.length)); nr.collapse(true); sel.removeAllRanges(); sel.addRange(nr); }
    }
    editor.querySelectorAll('ul.checklist > li:not([data-checked])').forEach(li => li.dataset.checked = 'false');
    if (paragraph) {
      const li = caretEl('ul.checklist > li');
      if (li && !li.textContent.trim()) li.dataset.checked = 'false';
    }
  }
  function toggleChecklist() {
    restoreSel();
    const li = caretEl('li');
    const ul = li?.parentElement;
    if (ul?.classList.contains('checklist')) { document.execCommand('insertUnorderedList'); }
    else if (ul?.tagName === 'UL') { ul.classList.add('checklist'); }
    else {
      document.execCommand('insertUnorderedList');
      caretEl('ul')?.classList.add('checklist');
    }
    afterEdit();
  }
  function toggleCheck(li) {
    const on = li.dataset.checked !== 'true';
    li.dataset.checked = String(on);
    if (on && prefs.checkedToBottom) {
      const ul = li.parentElement;
      ul.append(li);
    }
    scheduleSave();
  }

  // 표
  function insertTable(rows = 3, cols = 3) {
    const tr = '<tr>' + '<td><br></td>'.repeat(cols) + '</tr>';
    insertHTML(`<table><tbody>${tr.repeat(rows)}</tbody></table><p><br></p>`);
  }
  function tableOp(op) {
    const td = caretEl('td,th'); if (!td) return;
    const tr = td.parentElement, table = tr.closest('table'), idx = [...tr.children].indexOf(td);
    if (op === 'row') { const n = tr.cloneNode(true); n.querySelectorAll('td,th').forEach(c => c.innerHTML = '<br>'); tr.after(n); }
    if (op === 'col') table.querySelectorAll('tr').forEach(r => { const c = document.createElement('td'); c.innerHTML = '<br>'; r.children[idx].after(c); });
    if (op === 'delrow') { tr.parentElement.children.length > 1 ? tr.remove() : table.remove(); }
    if (op === 'delcol') { if (tr.children.length > 1) table.querySelectorAll('tr').forEach(r => r.children[idx]?.remove()); else table.remove(); }
    if (op === 'deltable') table.remove();
    scheduleSave();
  }

  // 사진
  function compressImage(file, max = 1600) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', 0.82));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('이미지를 읽을 수 없어요')); };
      img.src = url;
    });
  }
  async function insertImages(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try { insertHTML(`<img src="${await compressImage(f)}" alt=""><p><br></p>`); } catch (e) { toast(e.message); }
    }
  }

  // ───────── 메뉴·모달·토스트 ─────────
  let menuClose = null;
  function openMenu(anchor, items) {
    closeMenu();
    menuEl.innerHTML = '';
    for (const it of items) {
      if (!it) continue;
      if (it === 'hr') { menuEl.append(Object.assign(document.createElement('hr'))); continue; }
      if (it.cap) { const d = document.createElement('div'); d.className = 'cap'; d.textContent = it.cap; menuEl.append(d); continue; }
      if (it.el) { menuEl.append(it.el); continue; }
      const b = document.createElement('button');
      b.className = 'mi' + (it.on ? ' on' : '') + (it.danger ? ' danger' : '');
      b.innerHTML = `<span>${esc(it.label)}</span>${it.k ? `<span class="k">${esc(it.k)}</span>` : ''}`;
      b.onclick = () => { if (!it.keep) closeMenu(); it.act(); };
      menuEl.append(b);
    }
    menuEl.hidden = false;
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, bottom: anchor.y, top: anchor.y };
    const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
    let x = Math.min(r.left, innerWidth - w - 8), y = r.bottom + 4;
    if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 4);
    menuEl.style.left = Math.max(8, x) + 'px'; menuEl.style.top = y + 'px';
    const off = e => { if (!menuEl.contains(e.target)) closeMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', off, true));
    menuClose = () => document.removeEventListener('pointerdown', off, true);
  }
  function closeMenu() { menuEl.hidden = true; if (menuClose) { menuClose(); menuClose = null; } }
  function row(items) {
    const d = document.createElement('div'); d.className = 'seg';
    for (const it of items) {
      const b = document.createElement('button');
      b.innerHTML = it.html; b.title = it.title || '';
      b.onclick = () => { it.act(); if (!it.keep) closeMenu(); };
      d.append(b);
    }
    return { el: d };
  }
  function chips(map, act, onKey, extra) {
    const d = document.createElement('div'); d.className = 'row';
    for (const [k, v] of Object.entries(map)) {
      const b = document.createElement('button'); b.className = 'chip' + (k === onKey ? ' on' : ''); b.style.background = v; b.title = CNAME[k] || k;
      b.onclick = () => { act(k); closeMenu(); }; d.append(b);
    }
    if (extra) { const b = document.createElement('button'); b.className = 'chip'; b.textContent = '✕'; b.title = '없음'; b.onclick = () => { extra(); closeMenu(); }; d.append(b); }
    return { el: d };
  }
  menuEl.addEventListener('pointerdown', e => { if (!e.target.closest('input')) e.preventDefault(); });

  function openModal(html, mount) {
    closeMenu();
    sheet.innerHTML = html;
    modalEl.hidden = false;
    const close = () => { modalEl.hidden = true; sheet.innerHTML = ''; modalEl.onclose && modalEl.onclose(); modalEl.onclose = null; };
    modalEl.onclick = e => { if (e.target === modalEl) close(); };
    mount && mount(sheet, close);
    const f = sheet.querySelector('input'); if (f && !isMobile()) setTimeout(() => f.focus(), 30);
    return close;
  }
  function ask({ title, desc = '', fields, ok = '확인', danger }) {
    return new Promise(res => {
      let done = false;
      const close = openModal(`<h3>${esc(title)}</h3>${desc ? `<p>${desc}</p>` : ''}${(fields || []).map((f, i) => `<label>${esc(f.label)}</label><input type="${f.type || 'text'}" data-i="${i}" value="${esc(f.value || '')}" placeholder="${esc(f.ph || '')}" autocomplete="off">`).join('')}<div class="err-text"></div><div class="acts"><button data-x>취소</button><button class="primary${danger ? ' danger' : ''}" data-ok>${esc(ok)}</button></div>`, (s, close) => {
        const submit = () => { done = true; const v = [...s.querySelectorAll('input')].map(i => i.value); close(); res(fields ? v : true); };
        s.querySelector('[data-ok]').onclick = submit;
        s.querySelector('[data-x]').onclick = () => close();
        s.querySelectorAll('input').forEach(i => i.onkeydown = e => { if (e.key === 'Enter') submit(); });
      });
      modalEl.onclose = () => { if (!done) res(null); };
      void close;
    });
  }
  let toastT;
  function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }

  // ───────── 서식 메뉴 ─────────
  function formatMenu(anchor) {
    const inTable = !!caretEl('td,th');
    openMenu(anchor, [
      row([
        { html: '<b style="font-size:17px">제목</b>', act: () => exec('formatBlock', '<h1>') },
        { html: '<b>머리말</b>', act: () => exec('formatBlock', '<h2>') },
        { html: '<b style="font-size:13px">부머리말</b>', act: () => exec('formatBlock', '<h3>') },
        { html: '본문', act: () => exec('formatBlock', '<p>') },
        { html: '<code>고정폭</code>', act: () => exec('formatBlock', '<pre>') },
      ]),
      row([
        { html: '<b>B</b>', title: '굵게 ⌘B', act: () => exec('bold'), keep: true },
        { html: '<i>I</i>', title: '기울임 ⌘I', act: () => exec('italic'), keep: true },
        { html: '<u>U</u>', title: '밑줄 ⌘U', act: () => exec('underline'), keep: true },
        { html: '<s>S</s>', title: '취소선', act: () => exec('strikeThrough'), keep: true },
      ]),
      row([
        { html: '• 목록', act: () => exec('insertUnorderedList') },
        { html: '1. 번호', act: () => exec('insertOrderedList') },
        { html: '→ 들여', act: () => exec('indent'), keep: true },
        { html: '← 내어', act: () => exec('outdent'), keep: true },
        { html: '❝ 인용', act: () => exec('formatBlock', '<blockquote>') },
      ]),
      { cap: '형광펜' },
      chips(HL, k => color('hiliteColor', HL[k]), null, () => unwrapIn('mark')),
      { cap: '글자색' },
      chips(TC, k => color('foreColor', TC[k]), null, () => unwrapIn('span[class^="tc-"]')),
      inTable && 'hr',
      inTable && { cap: '표' },
      inTable && row([
        { html: '+ 행', act: () => tableOp('row') }, { html: '+ 열', act: () => tableOp('col') },
        { html: '− 행', act: () => tableOp('delrow') }, { html: '− 열', act: () => tableOp('delcol') }, { html: '표 삭제', act: () => tableOp('deltable') },
      ]),
    ]);
  }

  // ───────── 더보기 메뉴 ─────────
  function moreMenu(anchor) {
    const n = cur(); if (!n) return;
    if (n.trashedAt) {
      openMenu(anchor, [
        { label: '복구', act: () => restore(n) },
        { label: '완전히 삭제', danger: true, act: async () => { if (await ask({ title: '완전히 삭제할까요?', desc: '되돌릴 수 없습니다.', ok: '삭제', danger: true })) purge(n); } },
      ]);
      return;
    }
    const open = !n.locked || unlocked.has(n.id);
    openMenu(anchor, [
      { label: n.pinned ? '고정 해제' : '맨 위에 고정', act: () => togglePin(n) },
      { label: '폴더로 이동…', act: () => moveDialog([n]) },
      { cap: '메모 색상' },
      chips(COLORS, k => setColor(n, k), n.color, () => setColor(n, null)),
      'hr',
      open && n.chk && { label: '체크 모두 해제', act: () => { editor.querySelectorAll('ul.checklist > li').forEach(li => li.dataset.checked = 'false'); scheduleSave(); } },
      open && n.chk && { label: '체크한 항목 삭제', act: () => { editor.querySelectorAll('ul.checklist > li[data-checked="true"]').forEach(li => li.remove()); scheduleSave(); } },
      !n.locked && { label: '메모 잠그기…', act: () => lockNote(n) },
      n.locked && unlocked.has(n.id) && { label: '잠금 해제 (암호 제거)', act: () => removeLock(n) },
      n.locked && lockPw && { label: '지금 모두 잠그기', act: lockAll },
      open && { label: '복제', act: () => duplicate(n) },
      open && { label: '마크다운으로 저장', act: () => download(fileName(n) + '.md', htmlToMd(editor.innerHTML), 'text/markdown') },
      open && { label: '인쇄 / PDF', act: () => (Native.available ? Native.call('print') : print()) },
      { label: '정보', act: () => infoDialog(n) },
      'hr',
      { label: '삭제', danger: true, act: () => trash(n) },
    ]);
  }
  async function togglePin(n) { n.pinned = !n.pinned; await persist(n); renderEditor(); renderList(); renderSide(); }
  async function setColor(n, c) { if (c) n.color = c; else delete n.color; await persist(n); renderEditor(); renderList(); }
  async function trash(n) {
    await saveNow();
    if (isBlank(n)) { await purge(n); }
    else { n.trashedAt = Date.now(); n.pinned = false; await persist(n); toast('최근 삭제됨으로 옮겼어요'); }
    if (curId === n.id) { curId = null; renderEditor(); if (isMobile() && app.dataset.pane === 'edit') history.back(); }
    renderList(); renderSide();
  }
  async function restore(n) { delete n.trashedAt; if (n.folderId && !recs.get('folder-' + n.folderId) || recs.get('folder-' + n.folderId)?.deleted) n.folderId = null; await persist(n); renderEditor(); renderList(); renderSide(); toast('복구했어요'); }
  async function duplicate(n) {
    await saveNow();
    const html = n.locked ? unlocked.get(n.id) : n.html;
    const rec = newNoteRec(html); rec.folderId = n.folderId; rec.color = n.color;
    derive(rec); if (rec.title) rec.html = rec.html.replace(esc(rec.title), esc(rec.title) + ' 사본');
    derive(rec);
    await persist(rec); openNote(rec.id); renderSide();
  }
  function infoDialog(n) {
    const t = n.id === curId ? editor.innerText : n.text || '';
    const chars = t.replace(/\s/g, '').length, words = (t.match(/\S+/g) || []).length;
    const fo = n.folderId && recs.get('folder-' + n.folderId);
    openModal(`<h3>메모 정보</h3>
      <div class="opt"><span>글자 수 (공백 제외)</span><b>${chars.toLocaleString()}</b></div>
      <div class="opt"><span>글자 수 (공백 포함)</span><b>${t.replace(/\n/g, '').length.toLocaleString()}</b></div>
      <div class="opt"><span>단어</span><b>${words.toLocaleString()}</b></div>
      <div class="opt"><span>폴더</span><span>${fo ? esc(fo.name) : '없음'}</span></div>
      <div class="opt"><span>만든 날</span><span>${fmtLong(n.createdAt)}</span></div>
      <div class="opt"><span>수정한 날</span><span>${fmtLong(n.updatedAt)}</span></div>
      <div class="opt"><span>동기화</span><span>${n._dirty ? "올릴 변경 있음" : n._base ? '드라이브와 같음' : '아직 안 올림'}</span></div>
      <div class="acts"><button class="primary" data-x>닫기</button></div>`, (s, close) => s.querySelector('[data-x]').onclick = close);
  }
  function moveDialog(list) {
    const fs = folders();
    openModal(`<h3>폴더로 이동</h3><div class="pick">
      <button data-f="">폴더 없음</button>
      ${fs.map(f => `<button data-f="${esc(f.id)}"><i class="sw" style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${COLORS[f.color] || COLORS.gray};margin-right:8px"></i>${esc(f.name)}</button>`).join('')}
      <button data-new>+ 새 폴더 만들기</button></div><div class="acts"><button data-x>취소</button></div>`, (s, close) => {
      s.querySelector('[data-x]').onclick = close;
      s.querySelectorAll('[data-f]').forEach(b => b.onclick = async () => {
        close();
        for (const n of list) { n.folderId = b.dataset.f || null; await persist(n); }
        renderList(); renderSide(); toast('이동했어요');
      });
      s.querySelector('[data-new]').onclick = async () => {
        close();
        const f = await folderDialog();
        if (f) { for (const n of list) { n.folderId = f.id; await persist(n); } renderList(); renderSide(); }
      };
    });
  }

  // ───────── 폴더 ─────────
  async function folderDialog(f) {
    let colorKey = f?.color || 'yellow';
    return new Promise(res => {
      let done = false;
      openModal(`<h3>${f ? '폴더 편집' : '새 폴더'}</h3><label>이름</label><input type="text" value="${esc(f?.name || '')}" placeholder="폴더 이름">
        <label>색상</label><div class="row" style="display:flex;gap:8px;flex-wrap:wrap">${Object.entries(COLORS).map(([k, v]) => `<button class="chip" data-c="${k}" style="width:30px;height:30px;border-radius:50%;background:${v};${k === colorKey ? 'outline:2px solid var(--accent);outline-offset:2px' : ''}"></button>`).join('')}</div>
        <div class="acts"><button data-x>취소</button><button class="primary" data-ok>${f ? '저장' : '만들기'}</button></div>`, (s, close) => {
        const inp = s.querySelector('input');
        s.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { colorKey = b.dataset.c; s.querySelectorAll('[data-c]').forEach(x => x.style.outline = x === b ? '2px solid var(--accent)' : ''); });
        const submit = async () => {
          const name = inp.value.trim(); if (!name) { inp.focus(); return; }
          done = true; close();
          const rec = f || { key: '', kind: 'folder', id: uid(), order: folders().length, createdAt: Date.now() };
          rec.key = 'folder-' + rec.id; rec.name = name; rec.color = colorKey;
          await persist(rec); renderSide(); renderList(); res(rec);
        };
        s.querySelector('[data-ok]').onclick = submit;
        inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
        s.querySelector('[data-x]').onclick = close;
      });
      modalEl.onclose = () => { if (!done) res(null); };
    });
  }
  function folderMenu(anchor, f) {
    openMenu(anchor, [
      { label: '폴더 편집…', act: () => folderDialog(f) },
      { label: '이 폴더에 새 메모', act: () => { setView({ type: 'folder', id: f.id }); newNote(); } },
      'hr',
      { label: '폴더 삭제…', danger: true, act: async () => {
        const n = notes().filter(x => x.folderId === f.id && !x.trashedAt);
        if (!await ask({ title: `"${f.name}" 폴더를 삭제할까요?`, desc: n.length ? `안의 메모 ${n.length}개는 최근 삭제됨으로 옮겨집니다.` : '', ok: '삭제', danger: true })) return;
        for (const x of n) { x.trashedAt = Date.now(); await persist(x); }
        f.deleted = true; await persist(f);
        if (view.type === 'folder' && view.id === f.id) setView({ type: 'all' }); else { renderSide(); renderList(); }
      } },
    ]);
  }

  // ───────── 잠금 ─────────
  async function askPw(title, confirm) {
    const v = await ask({ title, desc: confirm ? '잠긴 메모는 이 암호로 기기에서 암호화된 채 드라이브에 올라갑니다. <b>암호를 잊으면 복구할 수 없어요.</b> 모든 잠긴 메모에 같은 암호를 쓰세요.' : '', fields: confirm ? [{ label: '암호', type: 'password' }, { label: '암호 확인', type: 'password' }] : [{ label: '암호', type: 'password' }], ok: confirm ? '잠그기' : '열기' });
    if (!v) return null;
    if (!v[0]) { toast('암호를 입력하세요'); return null; }
    if (confirm && v[0] !== v[1]) { toast('암호가 서로 다릅니다'); return null; }
    return v[0];
  }
  async function lockNote(n) {
    await saveNow();
    const pw = lockPw || await askPw('메모 잠그기', true);
    if (!pw) return;
    lockPw = pw; touchLock();
    const html = n.html;
    n.enc = await encrypt(html, pw);
    unlocked.set(n.id, html);
    n.locked = true; n.html = ''; derive(n);
    await persist(n);
    toast('잠갔어요 — "지금 모두 잠그기"로 닫을 수 있어요');
    renderEditor(); renderList(); renderSide();
  }
  async function unlockNote(n) {
    const tryPw = async pw => { try { unlocked.set(n.id, await decrypt(n.enc, pw)); lockPw = pw; touchLock(); return true; } catch { return false; } };
    if (lockPw && await tryPw(lockPw)) return renderEditor();
    const pw = await askPw('잠긴 메모 열기');
    if (!pw) return;
    if (await tryPw(pw)) renderEditor(); else toast('암호가 틀렸어요');
  }
  async function removeLock(n) {
    await saveNow();
    n.html = unlocked.get(n.id); delete n.enc; n.locked = false; unlocked.delete(n.id);
    derive(n); await persist(n); renderEditor(); renderList(); renderSide();
  }

  // ───────── 메모 연결 ─────────
  function linkDialog() {
    const list = notes().filter(n => !n.trashedAt && n.id !== curId).sort((a, b) => b.updatedAt - a.updatedAt);
    openModal(`<h3>다른 메모 연결</h3><input type="search" placeholder="메모 제목 검색"><div class="pick"></div><div class="acts"><button data-x>취소</button></div>`, (s, close) => {
      const inp = s.querySelector('input'), pick = s.querySelector('.pick');
      const draw = () => {
        const t = inp.value.toLowerCase();
        pick.innerHTML = list.filter(n => (n.title || '').toLowerCase().includes(t)).slice(0, 50).map(n => `<button data-id="${n.id}">${esc(n.title || '새 메모')}</button>`).join('') || '<p>없음</p>';
        pick.querySelectorAll('button').forEach(b => b.onclick = () => {
          const n = recs.get('note-' + b.dataset.id); close();
          insertHTML(`<a href="#" data-note="${n.id}">${esc(n.title || '메모')}</a>&nbsp;`);
        });
      };
      inp.oninput = draw; draw();
      s.querySelector('[data-x]').onclick = close;
    });
  }

  // ───────── 녹음 ─────────
  async function recordDialog() {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('이 브라우저는 녹음을 지원하지 않아요');
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return toast('마이크 권한이 필요해요'); }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, audioBitsPerSecond: 32000 });
    const chunks = []; let t0 = Date.now(), tick, keep = false;
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      stream.getTracks().forEach(t => t.stop()); clearInterval(tick);
      if (!keep || !chunks.length) return;
      const secs = Math.round((Date.now() - t0) / 1000);
      const fr = new FileReader();
      fr.onload = () => insertHTML(`<div class="att" contenteditable="false"><audio controls src="${fr.result}"></audio><span class="lbl">음성 ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${new Date().toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</span></div><p><br></p>`);
      fr.readAsDataURL(new Blob(chunks, { type: rec.mimeType }));
    };
    rec.start(1000);
    openModal(`<h3>음성 녹음</h3><div class="big">0:00</div><p style="text-align:center">최대 20분 · 메모 안에 저장돼요</p><div class="acts"><button data-x>취소</button><button class="primary" data-ok>완료</button></div>`, (s, close) => {
      const big = s.querySelector('.big');
      tick = setInterval(() => { const d = Math.floor((Date.now() - t0) / 1000); big.textContent = `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}`; if (d >= 1200) s.querySelector('[data-ok]').click(); }, 250);
      s.querySelector('[data-ok]').onclick = () => { keep = true; close(); };
      s.querySelector('[data-x]').onclick = close;
    });
    modalEl.onclose = () => { if (rec.state !== 'inactive') rec.stop(); };
  }

  // ───────── 그리기 (손글씨) ─────────
  const Draw = (() => {
    const box = $('#draw'), cv = $('#canvas'), g = cv.getContext('2d');
    const PEN_COLORS = ['#1f1e1b', '#e5484d', '#f08c00', '#30a46c', '#2d7ff9', '#8e4ec6'];
    let strokes = [], tool = 'pen', col = PEN_COLORS[0], size = 3, curS = null, target = null, W = 0, H = 0, scale = 1, sawPen = false;
    const base = document.createElement('canvas'), bg = base.getContext('2d');
    $('#drawColors').innerHTML = PEN_COLORS.map((c, i) => `<button data-c="${c}" style="background:${c}" class="${i ? '' : 'on'}"></button>`).join('');
    $('#drawColors').onclick = e => { const b = e.target.closest('[data-c]'); if (!b) return; col = b.dataset.c; $('#drawColors').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); if (tool === 'eraser') setTool('pen'); };
    box.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $('#drawSize').oninput = e => size = +e.target.value;
    function setTool(t) { tool = t; box.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === t)); }
    function fit() {
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = cv.clientWidth, h = cv.clientHeight;
      cv.width = base.width = Math.round(w * dpr); cv.height = base.height = Math.round(h * dpr);
      scale = w / W;
      [g, bg].forEach(x => x.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0));
      redrawBase(); frame();
    }
    function paint(ctx, s) {
      const p = s.p; if (!p.length) return;
      ctx.save();
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.c;
      if (s.t === 'marker') { ctx.globalAlpha = 0.35; ctx.lineWidth = s.w * 4; ctx.lineCap = 'square'; }
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], (s.t === 'marker' ? s.w * 2 : s.w * (0.5 + p[0][2])) / 2 + .5, 0, 7); ctx.fillStyle = s.c; ctx.fill(); ctx.restore(); return; }
      if (s.t === 'marker') {
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]); ctx.stroke();
      } else {
        let mx = p[0][0], my = p[0][1];
        for (let i = 1; i < p.length; i++) {
          const nx = (p[i - 1][0] + p[i][0]) / 2, ny = (p[i - 1][1] + p[i][1]) / 2;
          ctx.beginPath(); ctx.moveTo(mx, my); ctx.quadraticCurveTo(p[i - 1][0], p[i - 1][1], nx, ny);
          ctx.lineWidth = s.w * (0.45 + (p[i][2] ?? 0.5) * 1.1); ctx.stroke();
          mx = nx; my = ny;
        }
        ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]); ctx.stroke();
      }
      ctx.restore();
    }
    function redrawBase() { bg.save(); bg.setTransform(1, 0, 0, 1, 0, 0); bg.clearRect(0, 0, base.width, base.height); bg.restore(); strokes.forEach(s => s !== curS && paint(bg, s)); }
    function frame() { g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, cv.width, cv.height); g.drawImage(base, 0, 0); g.restore(); if (curS) paint(g, curS); }
    const pt = e => { const r = cv.getBoundingClientRect(); return [Math.round((e.clientX - r.left) / scale * 10) / 10, Math.round((e.clientY - r.top) / scale * 10) / 10, e.pointerType === 'pen' ? Math.round((e.pressure || .5) * 100) / 100 : 0.5]; };
    function erase(p) {
      const r = (size * 3 + 8) / scale, before = strokes.length;
      strokes = strokes.filter(s => !s.p.some(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < r));
      if (strokes.length !== before) { redrawBase(); frame(); }
    }
    cv.addEventListener('pointerdown', e => {
      if (e.pointerType === 'pen') sawPen = true;
      if (sawPen && e.pointerType === 'touch') return; // 펜을 쓰면 손바닥 터치 무시 (S펜)
      cv.setPointerCapture(e.pointerId);
      const t = e.button === 5 || (e.buttons & 32) ? 'eraser' : tool; // 펜 지우개 버튼
      if (t === 'eraser') { curS = { erasing: true }; erase(pt(e)); return; }
      curS = { t, c: col, w: size, p: [pt(e)] }; strokes.push(curS); frame();
    });
    cv.addEventListener('pointermove', e => {
      if (!curS) return;
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      if (curS.erasing) { evs.forEach(x => erase(pt(x))); return; }
      evs.forEach(x => curS.p.push(pt(x))); frame();
    });
    const up = () => { if (!curS) return; const s = curS; curS = null; if (!s.erasing) paint(bg, s); frame(); };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    $('#drawUndo').onclick = () => { strokes.pop(); redrawBase(); frame(); };
    $('#drawClear').onclick = () => { strokes = []; redrawBase(); frame(); };
    $('#drawCancel').onclick = () => close();
    $('#drawDone').onclick = () => {
      if (!strokes.length) { if (target) { target.remove(); scheduleSave(); } close(); return; }
      let maxY = 0; strokes.forEach(s => s.p.forEach(q => maxY = Math.max(maxY, q[1])));
      const h = Math.min(H, Math.ceil(maxY + 24)), out = document.createElement('canvas'), k = 2;
      out.width = W * k; out.height = h * k;
      const o = out.getContext('2d'); o.scale(k, k); strokes.forEach(s => paint(o, s));
      const src = out.toDataURL('image/png');
      const data = esc(JSON.stringify(strokes));
      if (target) { target.src = src; target.dataset.strokes = JSON.stringify(strokes); target.dataset.h = H; scheduleSave(); }
      else insertHTML(`<img class="drawing" src="${src}" data-strokes="${data}" data-w="${W}" data-h="${H}" alt="손글씨"><p><br></p>`);
      close();
    };
    function close() { box.hidden = true; target = null; removeEventListener('resize', fit); }
    function open(img) {
      target = img || null;
      strokes = []; sawPen = false;
      box.hidden = false;
      if (img?.dataset.strokes) { try { strokes = JSON.parse(img.dataset.strokes); } catch {} W = +img.dataset.w || cv.clientWidth; H = Math.max(+img.dataset.h || 0, cv.clientHeight * W / cv.clientWidth); }
      else { W = cv.clientWidth; H = cv.clientHeight; }
      setTool('pen');
      fit();
      addEventListener('resize', fit);
    }
    return { open };
  })();

  // ───────── 마크다운·백업 ─────────
  function htmlToMd(html) {
    const d = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    const inl = n => [...n.childNodes].map(c => {
      if (c.nodeType === 3) return c.textContent;
      if (c.nodeType !== 1) return '';
      const t = c.tagName, x = inl(c);
      if (t === 'B' || t === 'STRONG') return x.trim() ? `**${x}**` : x;
      if (t === 'I' || t === 'EM') return x.trim() ? `*${x}*` : x;
      if (t === 'S' || t === 'STRIKE' || t === 'DEL') return `~~${x}~~`;
      if (t === 'MARK') return `==${x}==`;
      if (t === 'CODE') return '`' + x + '`';
      if (t === 'A') return c.dataset.note ? `[[${x}]]` : `[${x}](${c.getAttribute('href') || ''})`;
      if (t === 'BR') return '\n';
      if (t === 'IMG') return c.classList.contains('drawing') ? '[손글씨]' : '[사진]';
      if (t === 'AUDIO') return '[음성]';
      return x;
    }).join('');
    const blk = (n, depth = 0) => [...n.childNodes].map(c => {
      if (c.nodeType === 3) return c.textContent.trim() ? c.textContent : '';
      if (c.nodeType !== 1) return '';
      const t = c.tagName;
      if (t === 'H1') return `# ${inl(c)}\n`;
      if (t === 'H2') return `## ${inl(c)}\n`;
      if (t === 'H3') return `### ${inl(c)}\n`;
      if (t === 'PRE') return '```\n' + c.textContent + '\n```\n';
      if (t === 'BLOCKQUOTE') return inl(c).split('\n').map(l => '> ' + l).join('\n') + '\n';
      if (t === 'UL' || t === 'OL') return [...c.children].map((li, i) => {
        const pre = '  '.repeat(depth) + (c.classList.contains('checklist') ? `- [${li.dataset.checked === 'true' ? 'x' : ' '}] ` : t === 'OL' ? `${i + 1}. ` : '- ');
        const sub = [...li.children].filter(x => x.tagName === 'UL' || x.tagName === 'OL');
        sub.forEach(x => x.remove());
        return pre + inl(li).trim() + '\n' + sub.map(x => blk({ childNodes: [x] }, depth + 1)).join('');
      }).join('');
      if (t === 'TABLE') {
        const rows = [...c.querySelectorAll('tr')].map(r => '| ' + [...r.children].map(td => inl(td).replace(/\|/g, '\\|').trim()).join(' | ') + ' |');
        if (rows.length) rows.splice(1, 0, '|' + ' --- |'.repeat(c.querySelector('tr').children.length));
        return rows.join('\n') + '\n';
      }
      if (t === 'DIV' && c.classList.contains('att')) return '[음성 메모]\n';
      if (t === 'HR') return '---\n';
      return inl(c) + '\n';
    }).join('');
    return blk(d.body).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  const fileName = n => (n.title || '메모').replace(/[\\/:*?"<>|]/g, '').slice(0, 60);
  function download(name, content, type) {
    if (Native.available) { Native.call('saveFile', { name, text: content, mime: type }).then(r => r?.path && toast('저장했어요 — ' + r.path)).catch(e => toast('저장 실패: ' + e.message)); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  function exportBackup() {
    const strip = r => { const o = {}; for (const k in r) if (k[0] !== '_') o[k] = r[k]; return o; };
    const all = [...recs.values()].filter(r => !r.purged);
    const data = { format: 'sync-memo-backup', version: 1, exportedAt: Date.now(), folders: all.filter(r => r.kind === 'folder' && !r.deleted).map(strip), notes: all.filter(r => r.kind === 'note').map(strip) };
    download(`싱크메모-백업-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  }
  async function importData(data) {
    if (!data || !Array.isArray(data.notes)) throw new Error('알 수 없는 파일 형식');
    let added = 0;
    const byName = new Map(folders().map(f => [f.name, f]));
    const fmap = new Map();
    for (const f of data.folders || []) {
      let ex = recs.get('folder-' + f.id) || byName.get(f.name);
      if (!ex) { ex = { kind: 'folder', id: f.id || uid(), name: f.name, color: f.color || 'yellow', order: folders().length, createdAt: f.createdAt || Date.now() }; ex.key = 'folder-' + ex.id; await persist(ex); byName.set(ex.name, ex); }
      fmap.set(f.id || f.name, ex.id);
    }
    for (const n of data.notes) {
      if (n.purged) continue;
      const id = n.id || uid();
      const ex = recs.get('note-' + id);
      if (ex && !ex.purged && ex.updatedAt >= (n.updatedAt || 0)) continue;
      let folderId = n.folderId ? fmap.get(n.folderId) || (recs.get('folder-' + n.folderId) ? n.folderId : null) : null;
      if (!folderId && n.folderName) {
        let f = byName.get(n.folderName);
        if (!f) { f = { kind: 'folder', id: uid(), name: n.folderName, color: 'yellow', order: folders().length, createdAt: Date.now() }; f.key = 'folder-' + f.id; await persist(f); byName.set(f.name, f); }
        folderId = f.id;
      }
      const rec = { ...n, key: 'note-' + id, kind: 'note', id, folderId, html: n.locked ? '' : sanitize(n.html || ''), createdAt: n.createdAt || Date.now(), updatedAt: n.updatedAt || Date.now(), _fileId: ex?._fileId, _base: ex?._base };
      delete rec.folderName;
      derive(rec);
      if (n.locked) rec.title = n.title;
      await persist(rec);
      added++;
    }
    renderSide(); renderList();
    return added;
  }

  const openExt = url => (Native.available ? Native.call('openExternal', { url }) : open(url, '_blank', 'noopener'));

  // ───────── 공유 ─────────
  async function share() {
    const n = cur(); if (!n) return;
    await saveNow();
    const text = editor.innerText;
    if (Native.available) { Native.call('share', { title: n.title || '메모', text }).catch(() => {}); return; }
    if (navigator.share) { try { await navigator.share({ title: n.title || '메모', text }); } catch {} }
    else { await navigator.clipboard.writeText(text); toast('텍스트를 복사했어요'); }
  }

  // ───────── 설정 ─────────
  async function settings() {
    const c = await Sync.cfg(), a = await Sync.auth();
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const redirect = new URL('./', location.href).href;
    openModal(`<h3>설정</h3>
      <p><b>구글 드라이브 동기화</b> — 메모는 각 기기에 먼저 저장되고, 인터넷이 되면 내 드라이브의 앱 전용 숨김 폴더와 맞춰집니다.</p>
      <div class="opt"><span>상태</span><span>${a ? '연결됨 ✓' : c.clientId || Native.platform === 'android' ? '연결 필요' : '설정 필요'}</span></div>
      <div ${Native.platform === 'android' ? 'hidden' : ''}>
      <label>${Native.platform === 'mac' ? '데스크톱 앱' : '웹'} OAuth 클라이언트 ID</label><input type="text" id="sCid" value="${esc(c.clientId || '')}" placeholder="....apps.googleusercontent.com">
      <label>클라이언트 보안 비밀번호</label><input type="password" id="sSec" value="${esc(c.clientSecret || '')}" placeholder="GOCSPX-...">
      ${Native.available ? '' : `<p style="font-size:12px">승인된 리디렉션 URI로 등록할 주소: <code>${esc(redirect)}</code></p>`}
      </div>
      ${Native.platform === 'android' ? '<p>구글 계정을 한 번 고르면 계속 연결됩니다.</p>' : ''}
      <div class="acts" style="justify-content:flex-start">
        ${a ? '<button data-sync>지금 동기화</button><button data-out>연결 해제</button>' : '<button class="primary" data-in>구글 연결</button>'}
        ${c.clientId && !Native.available ? '<button data-link>다른 기기 연결 링크 복사</button>' : ''}
      </div>
      <label style="margin-top:20px">사용</label>
      <div class="opt"><span>글자 크기</span><button data-fs>${FSN[prefs.fontSize] || '보통'}</button></div>
      <div class="opt"><span>체크한 항목을 맨 아래로</span><button data-chk>${prefs.checkedToBottom ? '켜짐' : '꺼짐'}</button></div>
      <div class="opt"><span>화면 모드</span><button data-theme>${{ auto: '자동', light: '라이트', dark: '다크' }[prefs.theme]}</button></div>
      ${Native.platform === 'android' ? '<div class="opt"><span>알림창(빠른 설정)에 \'새 메모\' 버튼</span><button data-tile>추가</button></div>' : ''}
      <label style="margin-top:20px">백업</label>
      <div class="opt"><span>모든 메모를 파일로 저장</span><button data-exp>내보내기</button></div>
      <div class="opt"><span>백업·맥 메모 가져오기 (.json)</span><button data-imp>가져오기</button></div>
      <div class="opt"><span>이 기기 저장 공간</span><span>${est ? (est.usage / 1048576).toFixed(1) + 'MB 사용' : '-'}${persisted ? ' · 보호됨' : ''}</span></div>
      <p style="font-size:12px;margin-top:14px">싱크 메모 v${VERSION}${Native.available ? ' · ' + (Native.platform === 'mac' ? '맥 앱' : '안드로이드 앱') : ''}</p>
      <div class="acts"><button class="primary" data-x>닫기</button></div>`, (s, close) => {
      const saveCfg = async () => { const n = { clientId: s.querySelector('#sCid').value.trim(), clientSecret: s.querySelector('#sSec').value.trim() }; await DB.setMeta('gcfg', n); return n; };
      s.querySelector('[data-x]').onclick = async () => { await saveCfg(); close(); Sync.run(); };
      s.querySelector('[data-in]')?.addEventListener('click', async () => { await saveCfg(); try { await Sync.login(); } catch (e) { toast(e.message); } });
      s.querySelector('[data-out]')?.addEventListener('click', async () => { await Sync.logout(); close(); toast('연결을 해제했어요 (메모는 기기에 남아 있어요)'); });
      s.querySelector('[data-sync]')?.addEventListener('click', () => { close(); Sync.run(); });
      s.querySelector('[data-link]')?.addEventListener('click', async () => {
        const n = await saveCfg();
        const url = redirect + '#setup=' + btoa(unescape(encodeURIComponent(JSON.stringify(n))));
        try { await navigator.clipboard.writeText(url); toast('링크를 복사했어요 — 폰에서 열면 설정이 들어갑니다'); } catch { prompt('이 링크를 폰에서 여세요', url); }
      });
      s.querySelector('[data-tile]')?.addEventListener('click', () => Native.call('addTile').then(r => toast(r?.msg || '추가했어요')).catch(e => toast(e.message)));
      s.querySelector('[data-fs]').onclick = e => { prefs.fontSize = { s: 'm', m: 'l', l: 's' }[prefs.fontSize] || 'm'; savePrefs(); applyLayout(); e.target.textContent = FSN[prefs.fontSize]; };
      s.querySelector('[data-chk]').onclick = e => { prefs.checkedToBottom = !prefs.checkedToBottom; savePrefs(); e.target.textContent = prefs.checkedToBottom ? '켜짐' : '꺼짐'; };
      s.querySelector('[data-theme]').onclick = e => { prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme]; savePrefs(); applyTheme(); e.target.textContent = { auto: '자동', light: '라이트', dark: '다크' }[prefs.theme]; };
      s.querySelector('[data-exp]').onclick = exportBackup;
      s.querySelector('[data-imp]').onclick = () => $('#fileImport').click();
    });
  }
  function savePrefs() { try { localStorage.setItem('sm_prefs', JSON.stringify(prefs)); } catch {} }
  // 안드로이드 WebView 는 시스템 다크 모드를 화면에 넘겨주지 않아서 네이티브가 알려준다 (sysDark). 상태·내비게이션 바 색도 맞춘다.
  let sysDark = null;
  function applyTheme() {
    const root = document.documentElement;
    const autoDark = sysDark ?? matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = prefs.theme === 'dark' || (prefs.theme === 'auto' && autoDark);
    if (prefs.theme === 'auto' && sysDark === null) root.removeAttribute('data-theme');
    else root.dataset.theme = dark ? 'dark' : 'light';
    if (Native.platform === 'android') Native.call('bars', { dark }).catch(() => {});
  }
  function applyLayout() {
    app.classList.toggle('side-hidden', !!prefs.sideHidden);
    document.documentElement.style.setProperty('--fs', FS[prefs.fontSize] || FS.m);
  }
  function toggleSide() { prefs.sideHidden = !prefs.sideHidden; savePrefs(); applyLayout(); }
  // 화면 폭이 바뀔 때 (폴드 접기·펼치기, 회전, 창 크기) 보던 메모를 이어서 보여준다
  function onWidthChange() {
    if (isMobile()) {
      if (curId && app.dataset.pane !== 'edit') { history.pushState({ pane: 'edit' }, ''); app.dataset.pane = 'edit'; }
      else if (!curId) app.dataset.pane = 'list';
    } else if (!curId) { const first = filtered()[0]; if (first) openNote(first.id); }
  }
  function setSysDark(v) { sysDark = !!v; applyTheme(); }

  // ───────── 동기화 표시 ─────────
  function renderSync(st) {
    const dot = $('#syncBox .dot'), tx = $('#syncText');
    const ago = st.lastSync ? ((Date.now() - st.lastSync) < 60000 ? '방금' : fmtShort(st.lastSync)) : '';
    const m = {
      idle: ['', '대기'], syncing: ['busy', '동기화 중…'], synced: ['ok', `동기화됨 · ${ago}`],
      offline: ['warn', '오프라인 — 이 기기에 저장됨'], login: ['warn', '구글 연결 필요 — 눌러서 연결'],
      nosetup: ['', '이 기기에만 저장 중 — 눌러서 동기화 설정'], error: ['err', '동기화 오류 — ' + (st.error || '')],
    }[st.status] || ['', st.status];
    dot.className = 'dot ' + m[0]; tx.textContent = m[1];
  }

  // ───────── 이벤트 ─────────
  function bind() {
    $('#views').onclick = e => { const a = e.target.closest('a'); if (a) setView({ type: a.dataset.type }); };
    $('#folders').onclick = e => { const a = e.target.closest('a'); if (a) setView({ type: 'folder', id: a.dataset.id }); };
    $('#folders').oncontextmenu = e => { const a = e.target.closest('a'); if (!a) return; e.preventDefault(); folderMenu({ x: e.clientX, y: e.clientY }, recs.get('folder-' + a.dataset.id)); };
    $('#tags').onclick = e => { const a = e.target.closest('a'); if (a) setView({ type: 'tag', id: a.dataset.id }); };
    $('#btnAddFolder').onclick = () => folderDialog();
    $('#listTitle').onclick = e => { if (view.type === 'folder') folderMenu(e.target, recs.get('folder-' + view.id)); };
    $('#btnSettings').onclick = settings;
    $('#btnSideToggle').onclick = toggleSide;
    matchMedia('(max-width: 760px)').addEventListener('change', onWidthChange);
    $('#syncBox').onclick = () => { const s = Sync.state.status; s === 'synced' || s === 'syncing' ? Sync.run() : settings(); };
    $('#btnLayout').onclick = () => { prefs.layout = prefs.layout === 'grid' ? 'list' : 'grid'; savePrefs(); renderList(); };
    $('#btnSort').onclick = e => openMenu(e.currentTarget, [
      { cap: '정렬' },
      { label: '수정한 날', on: prefs.sort === 'updated', act: () => { prefs.sort = 'updated'; savePrefs(); renderList(); } },
      { label: '만든 날', on: prefs.sort === 'created', act: () => { prefs.sort = 'created'; savePrefs(); renderList(); } },
      { label: '제목', on: prefs.sort === 'title', act: () => { prefs.sort = 'title'; savePrefs(); renderList(); } },
      'hr', { cap: '템플릿으로 새 메모' },
      ...TEMPLATES.map(t => ({ label: t.name, act: () => newNote(t.html()) })),
    ]);
    const newBtn = $('#btnNew');
    newBtn.onclick = () => newNote();
    newBtn.oncontextmenu = e => { e.preventDefault(); templateMenu(newBtn); };
    const fab = $('#fab');
    fab.onclick = () => newNote();
    fab.oncontextmenu = e => { e.preventDefault(); templateMenu(fab); };
    $('#q').oninput = e => { q = e.target.value.trim(); renderList(); };
    $('#notes').onclick = e => { const c = e.target.closest('.card'); if (c) openNote(c.dataset.id); };
    $('#notes').ondblclick = e => {
      const c = e.target.closest('.card');
      if (c && Native.platform === 'mac') { saveNow(); Native.call('openWindow', { id: c.dataset.id, title: recs.get('note-' + c.dataset.id)?.title || '메모' }).catch(() => {}); }
    };
    $('#notes').oncontextmenu = e => {
      const c = e.target.closest('.card'); if (!c) return; e.preventDefault();
      const n = recs.get('note-' + c.dataset.id);
      openMenu({ x: e.clientX, y: e.clientY }, n.trashedAt ? [
        { label: '복구', act: () => restore(n) },
        { label: '완전히 삭제', danger: true, act: () => purge(n) },
      ] : [
        { label: n.pinned ? '고정 해제' : '맨 위에 고정', act: () => togglePin(n) },
        { label: '폴더로 이동…', act: () => moveDialog([n]) },
        { label: '삭제', danger: true, act: () => trash(n) },
      ]);
    };
    $('#btnEmptyTrash').onclick = async () => {
      const list = notes().filter(n => n.trashedAt);
      if (!await ask({ title: `메모 ${list.length}개를 완전히 삭제할까요?`, desc: '되돌릴 수 없습니다.', ok: '모두 삭제', danger: true })) return;
      for (const n of list) await purge(n, true);
      renderList(); renderSide();
    };
    $('#btnToSide').onclick = () => { history.pushState({ pane: 'side' }, ''); app.dataset.pane = 'side'; };
    $('#btnToList').onclick = () => { if (history.state?.pane === 'edit') history.back(); else { app.dataset.pane = 'list'; leaveNote().then(() => { renderList(); renderSide(); }); } };
    addEventListener('popstate', e => {
      const p = e.state?.pane || 'list';
      if (app.dataset.pane === 'edit' && p !== 'edit') {
        // 동기적으로 닫는다 — 뒤에 이어서 다른 메모를 여는 동작(공유받기 등)과 순서가 꼬이지 않게
        const leaving = leaveNote(); curId = null; renderEditor(); renderList();
        leaving.then(() => { renderList(); renderSide(); });
      }
      closeMenu(); if (!modalEl.hidden) { modalEl.hidden = true; modalEl.onclose && modalEl.onclose(); }
      app.dataset.pane = p;
    });
    $('#btnPin').onclick = () => cur() && togglePin(cur());
    $('#btnShare').onclick = share;
    $('#btnMore').onclick = e => moreMenu(e.currentTarget);
    $('#btnUnlock').onclick = () => cur() && unlockNote(cur());

    // 툴바: 포커스를 뺏지 않게
    const tb = $('#toolbar');
    tb.addEventListener('pointerdown', e => e.preventDefault());
    tb.onclick = e => {
      const b = e.target.closest('button'); if (!b || cur()?.trashedAt) return;
      ({
        format: () => formatMenu(b), checklist: toggleChecklist, table: () => insertTable(),
        image: () => $('#fileImage').click(), draw: () => Draw.open(), record: recordDialog, link: linkDialog,
      })[b.dataset.cmd]?.();
    };
    $('#fileImage').onchange = e => { insertImages([...e.target.files]); e.target.value = ''; };
    $('#fileImport').onchange = async e => {
      const f = e.target.files[0]; e.target.value = ''; if (!f) return;
      try { const n = await importData(JSON.parse(await f.text())); toast(`메모 ${n}개를 가져왔어요`); } catch (err) { toast('가져오기 실패: ' + err.message); }
    };

    editor.addEventListener('input', e => { normalizeChecklists(e.inputType === 'insertParagraph'); autoLink(e); scheduleSave(); touchLock(); });
    editor.addEventListener('blur', () => { saveNow(); if (deferReload) setTimeout(() => { if (document.activeElement !== editor) renderEditor(); }, 0); });
    editor.addEventListener('click', e => {
      const li = e.target.closest('ul.checklist > li');
      if (li && e.clientX - li.getBoundingClientRect().left < 28 && editor.isContentEditable) { e.preventDefault(); toggleCheck(li); return; }
      const a = e.target.closest('a');
      if (a) {
        e.preventDefault();
        if (a.dataset.note) { const n = recs.get('note-' + a.dataset.note); n && !n.purged ? openNote(n.id) : toast('연결된 메모가 없어요'); }
        else if (a.href) openExt(a.href); // 클릭 한 번에 바로 열기 (고치기는 오른쪽 클릭·길게 누르기)
        return;
      }
      const img = e.target.closest('img');
      if (img && editor.isContentEditable) {
        openMenu(img, [
          img.classList.contains('drawing') && { label: '그림 편집', act: () => Draw.open(img) },
          { label: '크게 보기', act: () => openModal(`<img src="${img.src}" alt="" style="width:100%;border-radius:10px;background:#fff"><div class="acts"><button class="primary" data-x>닫기</button></div>`, (s, close) => s.querySelector('[data-x]').onclick = close) },
          { label: '삭제', danger: true, act: () => { img.remove(); scheduleSave(); } },
        ]);
      }
    });
    editor.addEventListener('contextmenu', e => {
      const a = e.target.closest('a[href]:not([data-note])');
      if (!a) return;
      e.preventDefault();
      openMenu({ x: e.clientX, y: e.clientY }, [
        { label: '링크 열기', act: () => openExt(a.href) },
        { label: '링크 복사', act: () => navigator.clipboard.writeText(a.href).then(() => toast('복사했어요')) },
        { label: '링크 지우기 (글자만 남기기)', act: () => { a.replaceWith(...a.childNodes); scheduleSave(); } },
      ]);
    });
    editor.addEventListener('keydown', e => {
      const m = e.metaKey || e.ctrlKey;
      if (e.key === 'Tab') {
        const td = caretEl('td,th');
        if (td) {
          e.preventDefault();
          const cells = [...td.closest('table').querySelectorAll('td,th')];
          let nx = cells[cells.indexOf(td) + (e.shiftKey ? -1 : 1)];
          if (!nx && !e.shiftKey) { tableOp('row'); nx = td.closest('table').querySelectorAll('tr')[td.parentElement.rowIndex + 1]?.firstElementChild; }
          if (nx) { const r = document.createRange(); r.selectNodeContents(nx); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); }
          return;
        }
        if (caretEl('li')) { e.preventDefault(); exec(e.shiftKey ? 'outdent' : 'indent'); return; }
      }
      if (m && e.shiftKey && e.key.toLowerCase() === 'l') { e.preventDefault(); toggleChecklist(); }
      if (m && e.altKey) {
        const map = { Digit1: '<h1>', Digit2: '<h2>', Digit3: '<h3>', Digit0: '<p>' };
        if (map[e.code]) { e.preventDefault(); exec('formatBlock', map[e.code]); }
      }
    });
    editor.addEventListener('paste', e => {
      const dt = e.clipboardData; if (!dt) return;
      const imgs = [...dt.files].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); insertImages(imgs); return; }
      // 붙여넣기는 서식(글자 크기·굵기·색)을 버리고 글자·줄바꿈만 — 오너 지시 2026-11-05
      const txt = dt.getData('text/plain') || textOf(sanitize(dt.getData('text/html') || ''));
      if (txt) { e.preventDefault(); pastePlain(txt); }
    });
    editor.addEventListener('drop', e => {
      const imgs = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith('image/'));
      if (imgs.length) { e.preventDefault(); insertImages(imgs); }
    });

    document.addEventListener('keydown', e => {
      const m = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { if (!menuEl.hidden) closeMenu(); else if (!modalEl.hidden) { modalEl.hidden = true; modalEl.onclose && modalEl.onclose(); } }
      if (m && e.altKey && e.code === 'KeyF') { e.preventDefault(); $('#q').focus(); }
      if (m && e.code === 'KeyN' && (e.altKey || !e.shiftKey)) { e.preventDefault(); newNote(); }
      if (m && e.code === 'Backspace' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement !== editor && cur()) { e.preventDefault(); trash(cur()); }
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) { saveNow(); if (lockPw) { clearTimeout(lockTimer); lockTimer = setTimeout(lockAll, 5 * 60000); } } });
    addEventListener('pagehide', () => saveNow());
    // 창 전체가 밀리면 (커서 따라가기 등) 즉시 제자리 — 각 칸은 자기 안에서만 스크롤
    addEventListener('scroll', () => { if (scrollY || scrollX) scrollTo(0, 0); });
    app.addEventListener('scroll', () => { if (app.scrollTop) app.scrollTop = 0; });
  }

  const today = () => new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const CL = (n = 1) => '<ul class="checklist">' + '<li data-checked="false"><br></li>'.repeat(n) + '</ul>';
  const TEMPLATES = [
    { name: '할 일', html: () => `<h1>할 일</h1>${CL()}` },
    { name: '장보기', html: () => `<h1>장보기 ${new Date().getMonth() + 1}/${new Date().getDate()}</h1>${CL()}` },
    { name: '회의 메모', html: () => `<h1>회의 메모</h1><p>${today()}</p><h2>참석</h2><p><br></p><h2>안건</h2><ul><li><br></li></ul><h2>결정</h2><ul><li><br></li></ul><h2>할 일</h2>${CL()}` },
    { name: '설교 메모', html: () => `<h1>설교 메모</h1><p>${today()} · 설교자 </p><h2>본문</h2><p><br></p><h2>핵심 문장</h2><blockquote><br></blockquote><h2>내용</h2><ul><li><br></li></ul><h2>적용</h2>${CL()}` },
    { name: '일기', html: () => `<h1>${today()}</h1><p><br></p>` },
  ];
  const templateMenu = anchor => openMenu(anchor, [{ cap: '템플릿으로 새 메모' }, ...TEMPLATES.map(t => ({ label: t.name, act: () => newNote(t.html()) }))]);

  // 원격 변경 반영
  async function onRemoteChange(fromOtherWindow) {
    if (!fromOtherWindow) bc?.postMessage({ t: 'changed' }); // 드라이브에서 받은 변경 → 메모 창들에도
    await reload();
    renderSide(); renderList();
    const n = cur();
    if (curId && (!n || n.purged)) { curId = null; renderEditor(); return; }
    if (n && n.updatedAt !== loadedVer && !pendingSave) {
      if (n.locked && unlocked.has(n.id) && lockPw) { try { unlocked.set(n.id, await decrypt(n.enc, lockPw)); } catch { unlocked.delete(n.id); } }
      if (document.activeElement === editor) deferReload = true; else renderEditor();
    }
  }

  async function handleLaunchParams() {
    const u = new URL(location.href);
    const h = location.hash.match(/#setup=([^&]+)/);
    if (h) {
      try { const c = JSON.parse(decodeURIComponent(escape(atob(h[1])))); await DB.setMeta('gcfg', c); toast('동기화 설정을 받았어요 — 설정에서 "구글 연결"을 누르세요', 5000); } catch { toast('설정 링크가 올바르지 않아요'); }
      history.replaceState(null, '', location.pathname);
    }
    if (['new', 'title', 'text', 'url'].some(k => u.searchParams.has(k))) { history.replaceState(history.state, '', location.pathname); await launch(u.searchParams); }
  }
  // 새 메모·공유받기 — 주소(?new= / ?text=) 또는 네이티브 앱(이미 열린 상태)에서 호출
  async function launch(params) {
    if (typeof params === 'string') params = new URLSearchParams(params);
    const shared = ['title', 'text', 'url'].some(k => params.has(k));
    if (!params.has('new') && !shared) return;
    if (isMobile() && app.dataset.pane === 'edit') await new Promise(r => { addEventListener('popstate', () => r(), { once: true }); history.back(); });
    if (shared) {
      const title = params.get('title') || '', text = params.get('text') || '', link = params.get('url') || '';
      const body = (text + (link && !text.includes(link) ? '\n' + link : '')).split('\n').map(l => `<p>${/^https?:\/\/\S+$/.test(l.trim()) ? `<a href="${esc(l.trim())}">${esc(l.trim())}</a>` : esc(l) || '<br>'}</p>`).join('');
      const rec = newNoteRec(`<h1>${esc(title || '공유받은 메모')}</h1>${body}`);
      recs.set(rec.key, rec);
      await persist(rec); await openNote(rec.id); renderSide();
    } else {
      const t = TEMPLATES.find(x => x.name === params.get('new'));
      await newNote(t ? t.html() : undefined);
    }
  }

  async function purgeOld() {
    const lim = Date.now() - TRASH_DAYS * DAY;
    for (const n of notes()) if (n.trashedAt && n.trashedAt < lim) await purge(n, true);
  }

  async function init() {
    if (Native.platform === 'mac') prefs.sideHidden = false; // 맥은 폴더 칸 기본 표시 (오너 2026-11-05)
    try { Object.assign(prefs, JSON.parse(localStorage.getItem('sm_prefs') || '{}')); } catch {}
    try { if (Native.platform === 'mac' && !localStorage.getItem('sm_mac_side_v1')) { prefs.sideHidden = false; localStorage.setItem('sm_mac_side_v1', '1'); savePrefs(); } } catch {}
    if (SINGLE) app.classList.add('single');
    if (Native.platform === 'android') { try { sysDark = !!(await Native.call('sysDark')); } catch {} }
    applyTheme(); applyLayout();
    document.execCommand('defaultParagraphSeparator', false, 'p');
    history.replaceState({ pane: 'list' }, '');
    app.dataset.pane = 'list';
    await reload();
    await purgeOld();
    bind();
    renderSide(); renderList(); renderEditor();
    if (SINGLE) { const id = new URLSearchParams(location.search).get('note'); if (recs.get('note-' + id)) openNote(id); return; }
    if (!isMobile()) { const first = filtered()[0]; if (first) openNote(first.id); }
    Sync.on(st => { renderSync(st); if (st.status === 'synced') refreshMeta(); });
    await handleLaunchParams();
    Sync.init();
    navigator.storage?.persist?.().catch(() => {});
    if ('serviceWorker' in navigator && !Native.available && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
    setInterval(() => renderSync(Sync.state), 30000);
  }

  return { init, uid, onRemoteChange, launch, setSysDark, toggleSide, newNote: () => newNote(), openSettings: () => settings(), focusSearch: () => $('#q').focus(), _test: { recs: () => recs, htmlToMd, sanitize, importData, saveNow, lockAll } };
})();
App.init();
