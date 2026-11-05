// 네이티브 앱(안드로이드 APK · 맥 .app) 안에서 실행될 때의 연결부. 일반 브라우저에서는 Native.available = false.
// JS → 네이티브: 안드로이드 window.SyncMemoAndroid.call(json) / 맥 webkit.messageHandlers.native.postMessage(json)
// 네이티브 → JS: window.__native.resolve(id, ok, data)
const Native = (() => {
  const and = window.SyncMemoAndroid;
  const mac = window.webkit?.messageHandlers?.native;
  const platform = and ? 'android' : mac ? 'mac' : null;
  const pending = new Map();
  let seq = 0;
  window.__native = {
    resolve(id, ok, data) {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      if (ok) p.res(data);
      else p.rej(Object.assign(new Error(String(data || '네이티브 오류')), { code: data === 'login' ? 'login' : undefined }));
    },
  };
  function call(method, args = {}) {
    if (!platform) return Promise.reject(new Error('네이티브 앱이 아닙니다'));
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      const msg = JSON.stringify({ id, method, args });
      and ? and.call(msg) : mac.postMessage(msg);
    });
  }
  if (platform) document.documentElement.classList.add('native', 'native-' + platform);
  return { available: !!platform, platform, call };
})();
