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
      for (const n of f.notes()) {
        try {
          if (n.passwordProtected()) { skipped++; continue; }
          folders.set(fname, true);
          notes.push({
            id: 'apple-' + n.id().split('/').pop().replace(/[^A-Za-z0-9]/g, ''),
            folderName: fname,
            html: n.body(),
            createdAt: n.creationDate().getTime(),
            updatedAt: n.modificationDate().getTime(),
          });
        } catch (e) { skipped++; }
      }
    }
  }
  const data = { format: 'apple-notes-export', version: 1, exportedAt: Date.now(), folders: [], notes };
  const app = Application.currentApplication(); app.includeStandardAdditions = true;
  const str = $.NSString.alloc.initWithUTF8String(JSON.stringify(data));
  str.writeToFileAtomicallyEncodingError(out, true, $.NSUTF8StringEncoding, null);
  return `메모 ${notes.length}개 · 폴더 ${folders.size}개 내보냄 (건너뜀 ${skipped}) → ${out}`;
}
