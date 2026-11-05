// 맥 메모(Apple Notes) → 싱크 메모 가져오기 파일(.json)
// 실행: osascript -l JavaScript export-apple-notes.js ~/Desktop/맥메모.json
// 처음 실행하면 "메모 제어 허용" 창이 뜬다 → 허용. 잠긴 메모는 본문을 읽을 수 없어 건너뛴다.
function run(argv) {
  const out = argv[0] || (Application.currentApplication().includeStandardAdditions = true, Path('/tmp/apple-notes.json').toString());
  const Notes = Application('Notes');
  const notes = [], folders = new Map();
  let skipped = 0;
  for (const acc of Notes.accounts()) {
    for (const f of acc.folders()) {
      const fname = f.name();
      if (/^(Recently Deleted|최근 삭제된 항목)$/.test(fname)) continue;
      // 메모를 하나씩 묻지 않고 속성별로 한 번에 받는다(1,900개 기준 수 시간 → 수십 초)
      const fn = f.notes;
      let ids, bodies, cds, mds, locks;
      try { ids = fn.id(); cds = fn.creationDate(); mds = fn.modificationDate(); locks = fn.passwordProtected(); }
      catch (e) { skipped += f.notes.length; continue; }
      // 본문은 사진이 들어 있으면 커서 한 번에 받다 시간 초과가 난다 → 그때는 하나씩
      try { bodies = fn.body(); } catch (e) { bodies = ids.map((_, i) => { try { return locks[i] ? null : fn[i].body(); } catch (x) { return null; } }); }
      ids.forEach((id, i) => {
        if (locks[i] || bodies[i] == null) { skipped++; return; }
        folders.set(fname, true);
        notes.push({ id: 'apple-' + id.split('/').pop().replace(/[^A-Za-z0-9]/g, ''), folderName: fname, html: bodies[i], createdAt: cds[i].getTime(), updatedAt: mds[i].getTime() });
      });
    }
  }
  const data = { format: 'apple-notes-export', version: 1, exportedAt: Date.now(), folders: [], notes };
  const app = Application.currentApplication(); app.includeStandardAdditions = true;
  const str = $.NSString.alloc.initWithUTF8String(JSON.stringify(data));
  str.writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  return `메모 ${notes.length}개 · 폴더 ${folders.size}개 내보냄 (건너뜀 ${skipped}) → ${out}`;
}
