#!/bin/zsh
# 배포 꾸러미 만들기 — APK·맥 앱(애플 실리콘+인텔)을 빌드해 배포/SyncMemo-설치꾸러미 에 넣고 zip 으로 묶는다.
# 쓰는 법: zsh tools/make-package.sh   (맥-구글연결값.txt 는 빈 양식 그대로 들어간다 — 값은 따로 보낸다)
set -e
ROOT="${0:A:h:h}"; cd "$ROOT"
PKG="배포/SyncMemo-설치꾸러미"

(cd android && JAVA_HOME=${JAVA_HOME:-~/.local/jdk17/Contents/Home} ./gradlew -q assembleRelease)
mkdir -p "$PKG/폰" "$PKG/맥"
cp android/app/build/outputs/apk/release/app-release.apk "$PKG/폰/SyncMemo.apk"

ARCHS="arm64 x86_64" zsh mac/build.sh
rm -f "$PKG/맥/싱크 메모 (맥용).zip"
ditto -c -k --keepParent "mac/build/싱크 메모.app" "$PKG/맥/싱크 메모 (맥용).zip"

cp tools/export-apple-notes.js "$PKG/도구/맥메모-내보내기.js"
rm -f "$PKG.zip"
(cd 배포 && ditto -c -k --keepParent --norsrc "SyncMemo-설치꾸러미" "SyncMemo-설치꾸러미.zip")
print "완료: $ROOT/$PKG.zip ($(du -h "$PKG.zip" | cut -f1)) · 버전 $(defaults read "$ROOT/mac/build/싱크 메모.app/Contents/Info" CFBundleShortVersionString)"
