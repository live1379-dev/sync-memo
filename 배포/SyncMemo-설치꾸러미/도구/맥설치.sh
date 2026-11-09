#!/bin/zsh
# 싱크 메모 맥 앱 설치 — 꾸러미의 앱(애플 실리콘·인텔 겸용)을 /Applications 에 넣고 켠다.
# 쓰는 법: zsh 도구/맥설치.sh        (꾸러미 어디서 실행해도 된다)
# 끝 코드: 0 = 설치·실행 확인 / 1 = 실패
set -u
ROOT="${0:A:h:h}"
ZIP="$ROOT/맥/싱크 메모 (맥용).zip"
APP="/Applications/싱크 메모.app"
PROC="싱크 메모.app/Contents/MacOS/SyncMemo"

major=$(sw_vers -productVersion | cut -d. -f1)
if (( major < 12 )); then print "❌ macOS $(sw_vers -productVersion) — 12(Monterey) 이상이어야 합니다."; exit 1; fi
print "▶ macOS $(sw_vers -productVersion) · $(uname -m)"
[[ -f $ZIP ]] || { print "❌ $ZIP 가 없습니다."; exit 1; }

# 켜져 있으면 끈다 (쓰던 메모는 이미 기기에 저장돼 있다)
if pgrep -f "$PROC" >/dev/null; then
  print "▶ 켜져 있는 싱크 메모를 끕니다"
  osascript -e 'quit app "싱크 메모"' 2>/dev/null
  for i in {1..10}; do pgrep -f "$PROC" >/dev/null || break; sleep 0.5; done
  pkill -f "$PROC" 2>/dev/null; sleep 1
fi

# 설치 (메모·로그인 정보는 앱 밖에 있어서 다시 깔아도 그대로다)
tmp=$(mktemp -d)
ditto -x -k "$ZIP" "$tmp" || { print "❌ 압축 풀기 실패"; exit 1; }
rm -rf "$APP" && ditto "$tmp/싱크 메모.app" "$APP" && rm -rf "$tmp" || { print "❌ /Applications 에 복사 실패"; exit 1; }
# 인터넷에서 받은 앱 표시를 지운다 — 안 지우면 "확인되지 않은 개발자" 로 안 열린다
xattr -dr com.apple.quarantine "$APP" 2>/dev/null

open "$APP"
for i in {1..10}; do pgrep -f "$PROC" >/dev/null && break; sleep 0.5; done
pgrep -f "$PROC" >/dev/null || { print "❌ 앱이 켜지지 않았습니다. Finder > 응용 프로그램 > 싱크 메모 를 직접 열어 보세요."; exit 1; }
v=$(defaults read "$APP/Contents/Info" CFBundleShortVersionString)
print "✅ 싱크 메모 $v 설치·실행됨"
print "   다음: 앱에서 설정(⌘,) → 맥-구글연결값.txt 의 두 값 붙여넣기 → 구글 연결"
exit 0
