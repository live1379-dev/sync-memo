// IndexedDB 저장소 — 모든 메모·폴더는 먼저 이 기기에 저장된다 (오프라인 우선).
// 레코드 key = `${kind}-${id}` (드라이브 파일 이름과 같다).
// 로컬 전용 필드: _dirty(올려야 함), _fileId(드라이브 파일 id), _base(마지막으로 맞춘 원격 버전)
const DB = (() => {
  let dbp;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('sync-memo', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('rec', { keyPath: 'key' });
        d.createObjectStore('meta');
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(store, mode, fn) {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then(v => { out = v; });
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  return {
    all: () => tx('rec', 'readonly', s => req(s.getAll())),
    get: key => tx('rec', 'readonly', s => req(s.get(key))),
    put: rec => tx('rec', 'readwrite', s => { s.put(rec); }),
    putMany: recs => tx('rec', 'readwrite', s => { recs.forEach(r => s.put(r)); }),
    del: key => tx('rec', 'readwrite', s => { s.delete(key); }),
    getMeta: k => tx('meta', 'readonly', s => req(s.get(k))),
    setMeta: (k, v) => tx('meta', 'readwrite', s => { s.put(v, k); }),
    delMeta: k => tx('meta', 'readwrite', s => { s.delete(k); }),
  };
})();
