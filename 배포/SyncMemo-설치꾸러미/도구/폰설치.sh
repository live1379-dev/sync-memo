#!/bin/zsh
# 폰에 싱크 메모 APK 설치 — USB 로 연결된 안드로이드 폰 한 대에 adb 로 넣는다.
# 쓰는 법: zsh 도구/폰설치.sh [기기시리얼]
# 끝 코드: 0 = 설치됨 / 2 = 사람이 할 일이 있음 / 1 = 실패
ROOT="${0:A:h:h}"
APK="$ROOT/폰/SyncMemo-내폰용.apk"
[[ -f $APK ]] || { print "⏸ 내 폰용 앱이 아직 없습니다. 먼저: zsh 도구/폰앱-내키로-서명.sh"; exit 2; }
ADB=$(command -v adb || ls /opt/homebrew/bin/adb /usr/local/bin/adb ~/Library/Android/sdk/platform-tools/adb 2>/dev/null | head -1)
if [[ -z $ADB ]]; then
  print "⏸ adb 가 없습니다. 둘 중 하나:"
  print "  ① brew install android-platform-tools 후 다시 실행"
  print "  ② $APK 를 폰으로 옮겨(카카오톡·구글 드라이브·USB 복사) 폰에서 눌러 설치 — '출처를 알 수 없는 앱' 허용"
  exit 2
fi
if [[ -n ${1:-} ]]; then S=$1
else
  devs=("${(@f)$("$ADB" devices | awk 'NR>1 && $2=="device" && $1 !~ /^emulator-/ {print $1}')}")
  devs=(${devs:#})
  if (( ${#devs} == 0 )); then
    "$ADB" devices | awk 'NR>1 && $2=="unauthorized"' | grep -q . \
      && print "⏸ 폰 화면에 뜬 'USB 디버깅 허용'을 누른 뒤 다시 실행하세요." \
      || print "⏸ 연결된 폰이 없습니다. 폰 설정 > 개발자 옵션 > USB 디버깅을 켜고 케이블로 연결하세요.\n  (개발자 옵션: 설정 > 휴대전화 정보 > 소프트웨어 정보 > 빌드번호 7번 탭)"
    exit 2
  fi
  (( ${#devs} > 1 )) && { print "⏸ 폰이 여러 대입니다: ${devs[*]} — 시리얼을 붙여 다시 실행하세요."; exit 2; }
  S=${devs[1]}
fi
print "▶ $S 에 설치합니다"
if ! out=$("$ADB" -s "$S" install -r "$APK" 2>&1); then
  print -r -- "$out"
  [[ $out == *UPDATE_INCOMPATIBLE* ]] && { print "⏸ 다른 곳에서 받은 싱크 메모가 깔려 있습니다. 폰에서 그 앱을 지운 뒤 다시 실행하세요(그 폰의 메모가 드라이브에 올라가 있는지 먼저 확인)."; exit 2; }
  exit 1
fi
v=$("$ADB" -s "$S" shell dumpsys package net.live1379.syncmemo | grep -m1 versionName | tr -d ' ')
print "✅ 폰 설치 완료 ($v) — 앱을 열고 '구글 연결 필요 — 눌러서 연결' → 계정 고르기"
