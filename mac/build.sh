#!/bin/zsh
# 싱크 메모 맥 앱 빌드 → mac/build/싱크 메모.app  (Xcode 없이 커맨드라인 도구만으로)
set -e
cd "$(dirname "$0")"
APP="build/싱크 메모.app"
rm -rf build && mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/www"
# 커맨드라인 도구 16.x 결함 우회: usr/include/swift 에 SwiftBridging 모듈 정의가 두 번 있어 빌드가 깨진다
# → 이 빌드에서만 module.modulemap 을 빈 파일로 가린다 (시스템 파일은 건드리지 않음)
OV=""
CLT_MM=/Library/Developer/CommandLineTools/usr/include/swift/module.modulemap
if [[ -f $CLT_MM && -f ${CLT_MM:h}/bridging.modulemap ]]; then
  : > build/empty.modulemap
  print -r -- "{\"version\":0,\"case-sensitive\":\"false\",\"roots\":[{\"type\":\"file\",\"name\":\"$CLT_MM\",\"external-contents\":\"$PWD/build/empty.modulemap\"}]}" > build/overlay.yaml
  OV="-vfsoverlay $PWD/build/overlay.yaml"
fi
# ARCHS="arm64 x86_64" 로 부르면 애플 실리콘·인텔 겸용(유니버설) — 배포 꾸러미용. 기본은 이 맥 칩만.
BINS=()
for A in ${=${ARCHS:-$(uname -m)}}; do
  swiftc -O -swift-version 5 -target "$A-apple-macos12" ${=OV} -o "build/SyncMemo-$A" main.swift \
    -framework Cocoa -framework WebKit -framework Network -framework CryptoKit
  BINS+=("build/SyncMemo-$A")
done
lipo -create "${BINS[@]}" -output "$APP/Contents/MacOS/SyncMemo"
cp Info.plist "$APP/Contents/"
rsync -a --exclude sw.js ../docs/ "$APP/Contents/Resources/www/"
# 아이콘 (icon-1024.png → AppIcon.icns)
IS=build/AppIcon.iconset && mkdir -p $IS
for s in 16 32 128 256 512; do
  sips -z $s $s icon-1024.png --out $IS/icon_${s}x${s}.png >/dev/null
  sips -z $((s*2)) $((s*2)) icon-1024.png --out $IS/icon_${s}x${s}@2x.png >/dev/null
done
iconutil -c icns $IS -o "$APP/Contents/Resources/AppIcon.icns"
codesign --force --deep -s - "$APP"
echo "완료: $APP"
