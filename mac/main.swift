// 싱크 메모 맥 앱 — 앱 안에 내장한 화면(Resources/www = 저장소 docs/)을 WKWebView 로 띄우고,
// 구글 로그인(데스크톱 OAuth, 루프백 + PKCE)·HTTP·파일·인쇄·공유·메뉴는 네이티브가 처리한다.
import Cocoa
@preconcurrency import WebKit
import Network
import CryptoKit

let WWW = Bundle.main.resourceURL!.appendingPathComponent("www")
let SCHEME = "syncmemo"
let START = URL(string: "\(SCHEME)://app/index.html")!
let SCOPE = "https://www.googleapis.com/auth/drive.appdata"

// ───────── 내장 화면 파일 제공 (syncmemo://app/...) ─────────
final class Files: NSObject, WKURLSchemeHandler {
    static let mime = ["html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8", "css": "text/css; charset=utf-8",
                       "svg": "image/svg+xml", "png": "image/png", "json": "application/json", "webmanifest": "application/manifest+json"]
    func webView(_ w: WKWebView, start t: WKURLSchemeTask) {
        guard let url = t.request.url else { return }
        var path = url.path
        if path.isEmpty || path == "/" { path = "/index.html" }
        let root = WWW.standardizedFileURL
        let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
        guard file.path.hasPrefix(root.path), let data = try? Data(contentsOf: file) else {
            t.didReceive(HTTPURLResponse(url: url, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: nil)!)
            t.didFinish()
            return
        }
        let type = Files.mime[file.pathExtension] ?? "application/octet-stream"
        t.didReceive(HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1",
                                     headerFields: ["Content-Type": type, "Content-Length": "\(data.count)", "Cache-Control": "no-store"])!)
        t.didReceive(data)
        t.didFinish()
    }
    func webView(_ w: WKWebView, stop t: WKURLSchemeTask) {}
}

// ───────── 구글 로그인 (데스크톱 앱 클라이언트) ─────────
func b64url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
}
func randomString(_ n: Int) -> String {
    var b = [UInt8](repeating: 0, count: n)
    _ = SecRandomCopyBytes(kSecRandomDefault, n, &b)
    return b64url(Data(b))
}
struct AuthError: Error { let msg: String }

final class Auth {
    static let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("SyncMemo")
    static let file = dir.appendingPathComponent("auth.json")
    var refresh: String?
    var access: String?
    var exp = Date.distantPast
    var listener: NWListener?

    init() {
        if let d = try? Data(contentsOf: Auth.file), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] {
            refresh = j["refresh"] as? String
        }
    }
    var connected: Bool { refresh != nil }

    func save() {
        try? FileManager.default.createDirectory(at: Auth.dir, withIntermediateDirectories: true)
        if let r = refresh {
            let d = try! JSONSerialization.data(withJSONObject: ["refresh": r])
            try? d.write(to: Auth.file, options: .atomic)
            try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Auth.file.path)
        } else {
            try? FileManager.default.removeItem(at: Auth.file)
        }
    }

    func logout() { refresh = nil; access = nil; exp = .distantPast; save() }

    func post(_ params: [String: String], _ done: @escaping (Result<[String: Any], AuthError>) -> Void) {
        var req = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var c = URLComponents()
        c.queryItems = params.map { URLQueryItem(name: $0.key, value: $0.value) }
        req.httpBody = (c.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                guard let data = data, let j = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    return done(.failure(AuthError(msg: err?.localizedDescription ?? "네트워크 오류")))
                }
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                if code != 200 { return done(.failure(AuthError(msg: (j["error"] as? String) ?? "오류 \(code)"))) }
                done(.success(j))
            }
        }.resume()
    }

    /// 기본 브라우저로 구글 로그인 → 127.0.0.1 임시 포트로 돌아온 code 를 refresh token 으로 교환
    func login(clientId: String, secret: String, _ done: @escaping (Result<Void, AuthError>) -> Void) {
        listener?.cancel()
        let verifier = randomString(48)
        let challenge = b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
        let state = randomString(16)
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        guard let l = try? NWListener(using: params) else { return done(.failure(AuthError(msg: "로그인 포트를 열 수 없어요"))) }
        listener = l
        var redirect = ""
        var finished = false
        let finish: (Result<Void, AuthError>) -> Void = { r in
            if finished { return }
            finished = true
            l.cancel()
            NSApp.activate(ignoringOtherApps: true)
            done(r)
        }
        l.stateUpdateHandler = { st in
            if case .ready = st, let port = l.port {
                redirect = "http://127.0.0.1:\(port.rawValue)"
                var c = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
                c.queryItems = [
                    .init(name: "client_id", value: clientId), .init(name: "redirect_uri", value: redirect),
                    .init(name: "response_type", value: "code"), .init(name: "scope", value: SCOPE),
                    .init(name: "access_type", value: "offline"), .init(name: "prompt", value: "consent"),
                    .init(name: "code_challenge", value: challenge), .init(name: "code_challenge_method", value: "S256"),
                    .init(name: "state", value: state),
                ]
                NSWorkspace.shared.open(c.url!)
            } else if case .failed(let e) = st { finish(.failure(AuthError(msg: e.localizedDescription))) }
        }
        l.newConnectionHandler = { conn in
            conn.start(queue: .main)
            conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { data, _, _, _ in
                let line = String(decoding: data ?? Data(), as: UTF8.self).components(separatedBy: "\r\n").first ?? ""
                let path = line.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
                let q = URLComponents(string: "http://x" + path)?.queryItems ?? []
                let get = { (k: String) in q.first { $0.name == k }?.value }
                let ok = get("code") != nil && get("state") == state
                let body = ok || get("error") != nil
                    ? "<html><meta charset=utf-8><body style='font:16px -apple-system;text-align:center;padding:60px'><h2>\(ok ? "✓ 싱크 메모 연결 완료" : "연결 취소됨")</h2><p>이 창을 닫고 앱으로 돌아가세요.</p></body></html>"
                    : ""
                let resp = "HTTP/1.1 \(body.isEmpty ? "404 Not Found" : "200 OK")\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
                conn.send(content: resp.data(using: .utf8), completion: .contentProcessed { _ in conn.cancel() })
                if let e = get("error") { return finish(.failure(AuthError(msg: "구글 로그인 취소: \(e)"))) }
                guard ok, let code = get("code") else { return }
                self.post(["code": code, "client_id": clientId, "client_secret": secret, "redirect_uri": redirect,
                           "grant_type": "authorization_code", "code_verifier": verifier]) { r in
                    switch r {
                    case .failure(let e): finish(.failure(AuthError(msg: "토큰 교환 실패: \(e.msg)")))
                    case .success(let j):
                        guard let rt = j["refresh_token"] as? String else { return finish(.failure(AuthError(msg: "refresh token 없음"))) }
                        self.refresh = rt
                        self.access = j["access_token"] as? String
                        self.exp = Date().addingTimeInterval((j["expires_in"] as? Double) ?? 3600)
                        self.save()
                        finish(.success(()))
                    }
                }
            }
        }
        l.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 300) { finish(.failure(AuthError(msg: "로그인 시간이 지났어요"))) }
    }

    func token(clientId: String, secret: String, force: Bool, _ done: @escaping (Result<String, AuthError>) -> Void) {
        guard let rt = refresh else { return done(.failure(AuthError(msg: "login"))) }
        if !force, let a = access, exp.timeIntervalSinceNow > 60 { return done(.success(a)) }
        post(["client_id": clientId, "client_secret": secret, "refresh_token": rt, "grant_type": "refresh_token"]) { r in
            switch r {
            case .failure(let e):
                if e.msg == "invalid_grant" { self.logout(); done(.failure(AuthError(msg: "login"))) } else { done(.failure(e)) }
            case .success(let j):
                self.access = j["access_token"] as? String
                self.exp = Date().addingTimeInterval((j["expires_in"] as? Double) ?? 3600)
                if let a = self.access { done(.success(a)) } else { done(.failure(AuthError(msg: "토큰 없음"))) }
            }
        }
    }
}

// ───────── 앱 ─────────
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!
    let auth = Auth()
    var selftest: String?

    func applicationDidFinishLaunching(_ n: Notification) {
        selftest = CommandLine.arguments.first { $0.hasPrefix("--selftest=") }.map { String($0.dropFirst(11)) }
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(Files(), forURLScheme: SCHEME)
        cfg.userContentController.add(self, name: "native")
        cfg.websiteDataStore = .default()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = false
        web.setValue(false, forKey: "drawsBackground") // 로딩 중 흰 화면 대신 창 배경색
        if #available(macOS 13.3, *) { web.isInspectable = true }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 780),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = "싱크 메모"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = NSSize(width: 420, height: 480)
        window.backgroundColor = NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.137, green: 0.137, blue: 0.145, alpha: 1) : NSColor(srgbRed: 0.925, green: 0.922, blue: 0.902, alpha: 1)
        }
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("SyncMemoMain")
        window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: START))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func js(_ code: String) { web.evaluateJavaScript(code, completionHandler: nil) }

    // 메뉴 — 편집 단축키(⌘C/⌘V/⌘Z…)가 동작하려면 반드시 필요하다
    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ items: [NSMenuItem]) {
            let it = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            let m = NSMenu(title: title)
            items.forEach { m.addItem($0) }
            it.submenu = m
            main.addItem(it)
        }
        func item(_ t: String, _ a: Selector?, _ k: String = "", _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: a, keyEquivalent: k)
            i.keyEquivalentModifierMask = mods
            return i
        }
        menu("싱크 메모", [
            item("싱크 메모에 관하여", #selector(NSApplication.orderFrontStandardAboutPanel(_:))), .separator(),
            item("설정…", #selector(settings), ","), .separator(),
            item("싱크 메모 가리기", #selector(NSApplication.hide(_:)), "h"),
            item("기타 가리기", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
            item("모두 보기", #selector(NSApplication.unhideAllApplications(_:))), .separator(),
            item("싱크 메모 종료", #selector(NSApplication.terminate(_:)), "q"),
        ])
        menu("파일", [
            item("새 메모", #selector(newNote), "n"),
            item("메모 검색", #selector(search), "f", [.command, .option]), .separator(),
            item("인쇄…", #selector(printNote), "p"),
        ])
        menu("편집", [
            item("실행 취소", Selector(("undo:")), "z"),
            item("실행 복귀", Selector(("redo:")), "z", [.command, .shift]), .separator(),
            item("오려두기", #selector(NSText.cut(_:)), "x"),
            item("복사하기", #selector(NSText.copy(_:)), "c"),
            item("붙여넣기", #selector(NSText.paste(_:)), "v"),
            item("서식 없이 붙여넣기", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
            item("전체 선택", #selector(NSText.selectAll(_:)), "a"),
        ])
        menu("서식", [
            item("굵게", #selector(bold), "b"),
            item("기울임꼴", #selector(italic), "i"),
            item("밑줄", #selector(underline), "u"), .separator(),
            item("제목", #selector(h1), "1", [.command, .option]),
            item("머리말", #selector(h2), "2", [.command, .option]),
            item("부머리말", #selector(h3), "3", [.command, .option]),
            item("본문", #selector(body), "0", [.command, .option]),
            item("체크리스트", #selector(checklist), "l", [.command, .shift]),
        ])
        menu("보기", [item("전체 화면", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
        menu("윈도우", [
            item("최소화", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("확대/축소", #selector(NSWindow.performZoom(_:))), .separator(),
            item("닫기", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }
    @objc func settings() { js("App.openSettings()") }
    @objc func newNote() { js("App.newNote()") }
    @objc func search() { js("App.focusSearch()") }
    @objc func printNote() { doPrint() }
    @objc func bold() { js("document.execCommand('bold')") }
    @objc func italic() { js("document.execCommand('italic')") }
    @objc func underline() { js("document.execCommand('underline')") }
    @objc func h1() { js("document.execCommand('formatBlock',false,'<h1>')") }
    @objc func h2() { js("document.execCommand('formatBlock',false,'<h2>')") }
    @objc func h3() { js("document.execCommand('formatBlock',false,'<h3>')") }
    @objc func body() { js("document.execCommand('formatBlock',false,'<p>')") }
    @objc func checklist() { js("document.querySelector('[data-cmd=checklist]')?.click()") }

    func doPrint() {
        let op = web.printOperation(with: NSPrintInfo.shared)
        op.view?.frame = web.bounds
        op.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    // ───────── 화면 → 네이티브 ─────────
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let s = m.body as? String, let d = s.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let id = o["id"] as? Int,
              let method = o["method"] as? String else { return }
        let a = o["args"] as? [String: Any] ?? [:]
        let cid = a["clientId"] as? String ?? "", sec = a["clientSecret"] as? String ?? ""
        switch method {
        case "auth.status": reply(id, true, ["connected": auth.connected])
        case "auth.login":
            auth.login(clientId: cid, secret: sec) { r in
                switch r { case .success: self.reply(id, true, nil); case .failure(let e): self.reply(id, false, e.msg) }
            }
        case "auth.token":
            auth.token(clientId: cid, secret: sec, force: a["force"] as? Bool ?? false) { r in
                switch r { case .success(let t): self.reply(id, true, ["token": t]); case .failure(let e): self.reply(id, false, e.msg) }
            }
        case "auth.logout": auth.logout(); reply(id, true, nil)
        case "http": http(id, a)
        case "saveFile":
            let p = NSSavePanel()
            p.nameFieldStringValue = a["name"] as? String ?? "메모.txt"
            p.beginSheetModal(for: window) { r in
                guard r == .OK, let url = p.url else { return self.reply(id, true, nil) }
                do { try (a["text"] as? String ?? "").write(to: url, atomically: true, encoding: .utf8); self.reply(id, true, ["path": url.lastPathComponent]) }
                catch { self.reply(id, false, error.localizedDescription) }
            }
        case "print": doPrint(); reply(id, true, nil)
        case "share":
            let picker = NSSharingServicePicker(items: [a["text"] as? String ?? ""])
            picker.show(relativeTo: NSRect(x: web.bounds.maxX - 90, y: web.bounds.maxY - 60, width: 1, height: 1), of: web, preferredEdge: .minY)
            reply(id, true, nil)
        case "openExternal":
            if let u = URL(string: a["url"] as? String ?? "") { NSWorkspace.shared.open(u) }
            reply(id, true, nil)
        default: reply(id, false, "알 수 없는 요청 \(method)")
        }
    }

    /// 구글 API 호출 대행 (내장 화면의 syncmemo:// 출처는 구글 CORS 밖이라)
    func http(_ id: Int, _ a: [String: Any]) {
        guard let u = URL(string: a["url"] as? String ?? ""), ["oauth2.googleapis.com", "www.googleapis.com"].contains(u.host ?? "") else {
            return reply(id, false, "허용되지 않은 주소")
        }
        var req = URLRequest(url: u)
        req.httpMethod = a["method"] as? String ?? "GET"
        (a["headers"] as? [String: String])?.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
        if let b = a["body"] as? String { req.httpBody = b.data(using: .utf8) }
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                if let err = err { return self.reply(id, false, err.localizedDescription) }
                self.reply(id, true, ["status": (resp as? HTTPURLResponse)?.statusCode ?? 0, "body": String(decoding: data ?? Data(), as: UTF8.self)])
            }
        }.resume()
    }

    func reply(_ id: Int, _ ok: Bool, _ data: Any?) {
        let v = data ?? NSNull()
        let json = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        js("window.__native&&__native.resolve(\(id),\(ok),\(json))")
    }

    // ───────── 웹뷰 ─────────
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let u = a.request.url else { return decisionHandler(.cancel) }
        if u.scheme == SCHEME { return decisionHandler(.allow) }
        if ["http", "https", "mailto", "tel"].contains(u.scheme ?? "") { NSWorkspace.shared.open(u) }
        decisionHandler(.cancel)
    }
    func webView(_ w: WKWebView, didFinish n: WKNavigation!) { if let out = selftest { runSelftest(out) } }
    func webViewWebContentProcessDidTerminate(_ w: WKWebView) { w.reload() }
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { NSWorkspace.shared.open(u) }
        return nil
    }
    func webView(_ w: WKWebView, runOpenPanelWith p: WKOpenPanelParameters, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = p.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { r in completionHandler(r == .OK ? panel.urls : nil) }
    }
    @available(macOS 12.0, *)
    func webView(_ w: WKWebView, requestMediaCapturePermissionFor o: WKSecurityOrigin, initiatedByFrame f: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant) // 녹음 — macOS 마이크 허용 창은 시스템이 따로 띄운다
    }
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let al = NSAlert(); al.messageText = m; al.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptTextInputPanelWithPrompt p: String, defaultText d: String?, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let al = NSAlert(); al.messageText = p
        let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); tf.stringValue = d ?? ""
        al.accessoryView = tf; al.addButton(withTitle: "확인"); al.addButton(withTitle: "취소")
        completionHandler(al.runModal() == .alertFirstButtonReturn ? tf.stringValue : nil)
    }

    // ───────── 자가 검사 (--selftest=결과.json) ─────────
    func runSelftest(_ out: String) {
        let code = """
        const r = { secure: isSecureContext, subtle: !!(crypto && crypto.subtle), native: Native.platform, idb: !!indexedDB };
        r.status = await Native.call('auth.status');
        const count = () => [...App._test.recs().values()].filter(x => x.kind === 'note' && !x.purged).length;
        r.before = count();
        await App._test.importData({ notes: [{ id: 'mac-selftest-' + Date.now(), html: '<h1>맥 자가검사</h1><p>본문</p>' }] });
        r.after = count();
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']); r.pbkdf2 = !!k;
        try { const x = await Native.call('http', { url: 'https://www.googleapis.com/drive/v3/about?fields=user', method: 'GET', headers: {}, body: null }); r.http = x.status; } catch (e) { r.http = 'err ' + e.message; }
        r.theme = getComputedStyle(document.body).backgroundColor;
        return JSON.stringify(r);
        """
        web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { res in
            var text = ""
            switch res { case .success(let v): text = (v as? String) ?? "\(v)"; case .failure(let e): text = "{\"error\":\(String(reflecting: e.localizedDescription))}" }
            try? text.write(toFile: out, atomically: true, encoding: .utf8)
            // 앱 창 내용만 이미지로 (화면 전체가 아니라)
            self.web.takeSnapshot(with: nil) { img, _ in
                if let img = img, let t = img.tiffRepresentation, let rep = NSBitmapImageRep(data: t), let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: out + ".png"))
                }
                NSApp.terminate(nil)
            }
        }
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
