#!/bin/zsh
# 폰 앱을 "내 키"로 다시 서명한다 → 내 구글 클라우드에 등록할 SHA-1 지문이 생긴다.
# 왜: 구글은 같은 (패키지 이름 + SHA-1) 을 한 프로젝트에만 등록하게 한다. 원본 APK 의 지문은 만든 사람 프로젝트에 이미 쓰였으니,
#     각자 자기 키로 서명해야 자기 프로젝트(= 자기 드라이브)로 로그인된다.
# 키는 ~/Library/Application Support/SyncMemo-서명키/ 에 한 번 만들어 계속 쓴다 → 새 꾸러미가 와도 이 스크립트만 다시 돌리면
#     같은 지문 그대로라 구글 설정을 다시 안 해도 되고, 폰에 덮어 설치(업데이트)된다. ★이 폴더를 지우지 말 것.
# 쓰는 법: zsh 도구/폰앱-내키로-서명.sh
# 끝 코드: 0 = 완료 / 2 = 사람이 할 일 있음 / 1 = 실패
set -u
ROOT="${0:A:h:h}"
SRC="$ROOT/폰/SyncMemo-원본.apk"
OUT="$ROOT/폰/SyncMemo-내폰용.apk"
SIGNER="$ROOT/도구/apksigner.jar"
KD="$HOME/Library/Application Support/SyncMemo-서명키"
KS="$KD/내키.jks"; PW="$KD/암호.txt"

# 1. Java 찾기 (맥에는 기본으로 없다)
JAVA=""
for j in "$(command -v java)" "$(/usr/libexec/java_home 2>/dev/null)/bin/java" /opt/homebrew/opt/openjdk/bin/java /usr/local/opt/openjdk/bin/java; do
  [[ -x $j ]] && "$j" -version >/dev/null 2>&1 && { JAVA=$j; break; }
done
if [[ -z $JAVA ]]; then
  if command -v brew >/dev/null; then
    print "▶ Java 설치(brew install openjdk) — 몇 분 걸립니다"
    brew install openjdk || exit 1
    JAVA=$(brew --prefix openjdk)/bin/java
  else
    print "⏸ Java 가 필요합니다. https://adoptium.net 에서 'macOS .pkg' (Temurin 21 LTS) 를 받아 두 번 눌러 설치한 뒤 다시 실행하세요."
    exit 2
  fi
fi
KEYTOOL="${JAVA:h}/keytool"

# 2. 내 키 (없을 때만 만든다)
if [[ ! -f $KS ]]; then
  mkdir -p "$KD" && chmod 700 "$KD"
  head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$PW"; chmod 600 "$PW"
  "$KEYTOOL" -genkeypair -keystore "$KS" -storepass "$(cat "$PW")" -alias me -keyalg RSA -keysize 2048 \
    -validity 20000 -dname "CN=SyncMemo $(whoami)" >/dev/null 2>&1 || { print "❌ 키 만들기 실패"; exit 1; }
  chmod 600 "$KS"
  print "▶ 내 서명 키를 만들었습니다: $KD  (지우지 마세요 — 지우면 구글 설정을 다시 해야 합니다)"
fi

# 3. 서명
"$JAVA" -jar "$SIGNER" sign --ks "$KS" --ks-pass "file:$PW" --ks-key-alias me --out "$OUT" "$SRC" || { print "❌ 서명 실패"; exit 1; }
rm -f "$OUT.idsig"
SHA1=$("$JAVA" -jar "$SIGNER" verify --print-certs "$OUT" | awk -F': ' '/SHA-1/{print toupper($2); exit}' | sed 's/../&:/g; s/:$//')
[[ -n $SHA1 ]] || { print "❌ 서명 확인 실패"; exit 1; }
print -r -- "$SHA1" > "$ROOT/내-폰앱-지문.txt"
print "✅ 내 폰용 앱: 폰/SyncMemo-내폰용.apk"
print "   구글 클라우드 Android 클라이언트에 넣을 값"
print "   패키지 이름: net.live1379.syncmemo"
print "   SHA-1      : $SHA1   (내-폰앱-지문.txt 에도 저장)"
