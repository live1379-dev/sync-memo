// 싱크 메모 맥 앱 — 앱 안에 내장한 화면(Resources/www = 저장소 docs/)을 WKWebView 로 띄우고,
// 구글 로그인(데스크톱 OAuth, 루프백 + PKCE)·HTTP·파일·인쇄·공유·메뉴는 네이티브가 처리한다.
import Cocoa
@preconcurrency import WebKit
import Network
import CryptoKit
import UniformTypeIdentifiers

let WWW = Bundle.main.resourceURL!.appendingPathComponent("www")
let SCHEME = "syncmemo"
let START = URL(string: "\(SCHEME)://app/index.html")!
// 동기화는 숨김 폴더(appdata), 첨부는 보이는 '싱크 메모 첨부' 폴더(drive.file — 앱이 만든 파일만). v1.4.14 전 로그인은 appdata 만 있어 첫 첨부 때 한 번 다시 허용
let SCOPE = "https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.file"
let ATTACH_FOLDER = "싱크 메모 첨부"

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
final class DragStrip: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func mouseDown(with e: NSEvent) {
        if e.clickCount == 2 { window?.performZoom(nil) } else { window?.performDrag(with: e) }
    }
}

/// 마지막 마우스 누름을 기억하는 웹뷰 — 화면(JS)이 머리글 빈 곳을 눌렀다고 알려 오면 그 누름으로 창을 끈다
final class Web: WKWebView {
    var lastDown: NSEvent?
    override func mouseDown(with e: NSEvent) { lastDown = e; super.mouseDown(with: e) }
    // 본문 우클릭(맥 기본 메뉴: 복사·붙여넣기…) 맨 밑에 회의록·콘티를 덧붙인다 (오너 2026-11-19)
    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        menu.addItem(.separator())
        for (t, k) in [("회의록 만들기 (Claude)", "회의록"), ("콘티 준비하기 (Claude)", "콘티")] {
            let i = NSMenuItem(title: t, action: #selector(claudeItem(_:)), keyEquivalent: "")
            i.target = self; i.representedObject = k; menu.addItem(i)
        }
    }
    @objc func claudeItem(_ s: NSMenuItem) { if let k = s.representedObject as? String { evaluateJavaScript("App.claudeCur('\(k)')", completionHandler: nil) } }
    // 파일 끌어 놓기: 그림만이면 화면(JS)이 본문에 넣고, 그 밖의 파일은 드라이브에 올려 📎 칩으로 (오너 2026-11-19)
    static let imageExt: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff", "tif", "bmp"]
    func droppedFiles(_ s: NSDraggingInfo) -> [URL] {
        (s.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    func attachDrop(_ s: NSDraggingInfo) -> Bool { let u = droppedFiles(s); return !u.isEmpty && !u.allSatisfy { Web.imageExt.contains($0.pathExtension.lowercased()) } }
    override func draggingEntered(_ s: NSDraggingInfo) -> NSDragOperation { let o = super.draggingEntered(s); return attachDrop(s) ? .copy : o }
    override func draggingUpdated(_ s: NSDraggingInfo) -> NSDragOperation { let o = super.draggingUpdated(s); return attachDrop(s) ? .copy : o }
    override func performDragOperation(_ s: NSDraggingInfo) -> Bool {
        guard attachDrop(s), let d = NSApp.delegate as? AppDelegate else { return super.performDragOperation(s) }
        d.pendingFiles += droppedFiles(s)
        evaluateJavaScript("App.dropFiles()", completionHandler: nil)
        return true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var cfg: WKWebViewConfiguration!
    var noteWindows: [String: NSWindow] = [:]
    var web: WKWebView!
    var pendingFiles: [URL] = [] // 끌어 놓거나 📎 로 고른, 아직 드라이브에 안 올린 파일
    let auth = Auth()
    var selftest: String?

    func applicationDidFinishLaunching(_ n: Notification) {
        selftest = CommandLine.arguments.first { $0.hasPrefix("--selftest=") }.map { String($0.dropFirst(11)) }
        buildMenu()
        cfg = WKWebViewConfiguration()
        cfg.setURLSchemeHandler(Files(), forURLScheme: SCHEME)
        cfg.userContentController.add(self, name: "native")
        cfg.websiteDataStore = selftest == nil ? .default() : .nonPersistent() // 자가검사는 실제 메모·드라이브를 건드리지 않는다
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")
        web = makeWeb()
        window = makeWindow(width: 1200, height: 780, web: web)
        window.title = "싱크 메모"
        window.center()
        window.setFrameAutosaveName("SyncMemoMain")
        window.makeKeyAndOrderFront(nil)
        web.load(URLRequest(url: START))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { true }

    func makeWeb() -> WKWebView {
        let w = Web(frame: .zero, configuration: cfg)
        w.navigationDelegate = self
        w.uiDelegate = self
        w.allowsBackForwardNavigationGestures = false
        w.setValue(false, forKey: "drawsBackground") // 로딩 중 흰 화면 대신 창 배경색
        if #available(macOS 13.3, *) { w.isInspectable = true }
        return w
    }

    /// 화면이 제목 표시줄까지 이어지는 창 + 맨 위 28px 끌기 띠 (끌면 창 이동, 두 번 클릭하면 확대)
    func makeWindow(width: CGFloat, height: CGFloat, web wv: WKWebView) -> NSWindow {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: height),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                         backing: .buffered, defer: false)
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.minSize = NSSize(width: 380, height: 420)
        w.backgroundColor = NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.137, green: 0.137, blue: 0.145, alpha: 1) : NSColor(srgbRed: 0.925, green: 0.922, blue: 0.902, alpha: 1)
        }
        let box = NSView()
        let strip = DragStrip()
        for v in [wv, strip] as [NSView] { v.translatesAutoresizingMaskIntoConstraints = false; box.addSubview(v) }
        NSLayoutConstraint.activate([
            wv.leadingAnchor.constraint(equalTo: box.leadingAnchor), wv.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            wv.topAnchor.constraint(equalTo: box.topAnchor), wv.bottomAnchor.constraint(equalTo: box.bottomAnchor),
            strip.leadingAnchor.constraint(equalTo: box.leadingAnchor), strip.trailingAnchor.constraint(equalTo: box.trailingAnchor),
            strip.topAnchor.constraint(equalTo: box.topAnchor), strip.heightAnchor.constraint(equalToConstant: 28),
        ])
        w.contentView = box
        w.isReleasedWhenClosed = false
        w.delegate = self
        return w
    }

    /// 목록에서 메모를 더블클릭 → 그 메모만 새 창 (애플 메모처럼). 같은 메모는 창 하나.
    func openNoteWindow(_ id: String, _ title: String) {
        guard !id.isEmpty else { return }
        if let w = noteWindows[id] { w.makeKeyAndOrderFront(nil); return }
        let wv = makeWeb()
        let w = makeWindow(width: 560, height: 680, web: wv)
        w.title = title
        let f = window.frame, k = CGFloat(noteWindows.count % 8) * 26
        w.setFrameTopLeftPoint(NSPoint(x: f.minX + 80 + k, y: f.maxY - 50 - k))
        noteWindows[id] = w
        var c = URLComponents(url: START, resolvingAgainstBaseURL: false)!
        c.queryItems = [URLQueryItem(name: "note", value: id), URLQueryItem(name: "single", value: "1")]
        wv.load(URLRequest(url: c.url!))
        w.makeKeyAndOrderFront(nil)
    }
    func windowWillClose(_ n: Notification) {
        guard let w = n.object as? NSWindow else { return }
        noteWindows = noteWindows.filter { $0.value !== w }
    }

    /// 지금 앞에 있는 창의 화면 (메모 창이면 그 창)
    var activeWeb: WKWebView {
        for w in [NSApp.keyWindow, NSApp.mainWindow].compactMap({ $0 }) {
            if let v = w.contentView?.subviews.first(where: { $0 is WKWebView }) as? WKWebView { return v }
        }
        return web
    }
    func js(_ code: String) { activeWeb.evaluateJavaScript(code, completionHandler: nil) }
    func jsMain(_ code: String) { window.makeKeyAndOrderFront(nil); web.evaluateJavaScript(code, completionHandler: nil) }

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
        func fmtItem(_ t: String, _ cmd: String, _ k: String, _ mods: NSEvent.ModifierFlags = .command) -> NSMenuItem {
            let i = NSMenuItem(title: t, action: #selector(fmtAction(_:)), keyEquivalent: k)
            i.keyEquivalentModifierMask = mods
            i.representedObject = cmd
            return i
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
            fmtItem("제목", "h1", "t", [.command, .shift]),
            fmtItem("머리말", "h2", "h", [.command, .shift]),
            fmtItem("부머리말", "h3", "j", [.command, .shift]),
            fmtItem("본문", "p", "b", [.command, .shift]),
            fmtItem("고정폭", "pre", "m", [.command, .shift]), .separator(),
            fmtItem("글머리 기호 목록", "ul", "7", [.command, .shift]),
            fmtItem("번호 목록", "ol", "9", [.command, .shift]),
            fmtItem("체크리스트", "check", "l", [.command, .shift]),
            fmtItem("체크 표시", "checkmark", "u", [.command, .shift]), .separator(),
            fmtItem("굵게", "bold", "b"),
            fmtItem("기울임꼴", "italic", "i"),
            fmtItem("밑줄", "underline", "u"),
            fmtItem("취소선", "strike", "x", [.command, .shift]), .separator(),
            fmtItem("글자 크게", "bigger", "+"),
            fmtItem("글자 작게", "smaller", "-"),
            fmtItem("들여쓰기", "indent", "]"),
            fmtItem("내어쓰기", "outdent", "["),
        ])
        menu("보기", [item("폴더 칸 보기/숨기기", #selector(toggleSide), "s", [.command, .option]), .separator(), item("전체 화면", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])])
        menu("윈도우", [
            item("최소화", #selector(NSWindow.performMiniaturize(_:)), "m"),
            item("확대/축소", #selector(NSWindow.performZoom(_:))), .separator(),
            item("닫기", #selector(NSWindow.performClose(_:)), "w"),
        ])
        NSApp.mainMenu = main
    }
    @objc func settings() { jsMain("App.openSettings()") }
    @objc func fmtAction(_ sender: NSMenuItem) { if let c = sender.representedObject as? String { js("App.fmt('\(c)')") } }
    @objc func toggleSide() { jsMain("App.toggleSide()") }
    @objc func newNote() { jsMain("App.newNote()") }
    @objc func search() { jsMain("App.focusSearch()") }
    @objc func printNote() { doPrint() }

    func doPrint(_ target: WKWebView? = nil) {
        let t = target ?? activeWeb
        let op = t.printOperation(with: NSPrintInfo.shared)
        op.view?.frame = t.bounds
        op.runModal(for: t.window ?? window, delegate: nil, didRun: nil, contextInfo: nil)
    }

    // ───────── 화면 → 네이티브 ─────────
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let s = m.body as? String, let d = s.data(using: .utf8),
              let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any], let id = o["id"] as? Int,
              let method = o["method"] as? String else { return }
        let a = o["args"] as? [String: Any] ?? [:]
        let wv = m.webView ?? web!
        let cid = a["clientId"] as? String ?? "", sec = a["clientSecret"] as? String ?? ""
        switch method {
        case "auth.status": reply(wv, id, true, ["connected": selftest == nil && auth.connected])
        case "auth.login":
            auth.login(clientId: cid, secret: sec) { r in
                switch r { case .success: self.reply(wv, id, true, nil); case .failure(let e): self.reply(wv, id, false, e.msg) }
            }
        case "auth.token":
            auth.token(clientId: cid, secret: sec, force: a["force"] as? Bool ?? false) { r in
                switch r { case .success(let t): self.reply(wv, id, true, ["token": t]); case .failure(let e): self.reply(wv, id, false, e.msg) }
            }
        case "auth.logout": auth.logout(); reply(wv, id, true, nil)
        case "http": http(wv, id, a)
        case "openWindow": openNoteWindow(a["id"] as? String ?? "", a["title"] as? String ?? "메모"); reply(wv, id, true, nil)
        case "dragWindow": // 머리글 빈 곳 끌기 → 창 이동
            if let e = (wv as? Web)?.lastDown, NSEvent.pressedMouseButtons & 1 == 1 { wv.window?.performDrag(with: e) }
            reply(wv, id, true, nil)
        case "zoomWindow": wv.window?.performZoom(nil); reply(wv, id, true, nil)
        case "setTitle": wv.window?.title = a["title"] as? String ?? "메모"; reply(wv, id, true, nil)
        case "saveFile":
            let p = NSSavePanel()
            p.nameFieldStringValue = a["name"] as? String ?? "메모.txt"
            p.beginSheetModal(for: wv.window ?? window) { r in
                guard r == .OK, let url = p.url else { return self.reply(wv, id, true, nil) }
                do { try (a["text"] as? String ?? "").write(to: url, atomically: true, encoding: .utf8); self.reply(wv, id, true, ["path": url.lastPathComponent]) }
                catch { self.reply(wv, id, false, error.localizedDescription) }
            }
        case "print": doPrint(wv); reply(wv, id, true, nil)
        case "share":
            let picker = NSSharingServicePicker(items: [a["text"] as? String ?? ""])
            picker.show(relativeTo: NSRect(x: wv.bounds.maxX - 90, y: wv.bounds.maxY - 60, width: 1, height: 1), of: wv, preferredEdge: .minY)
            reply(wv, id, true, nil)
        case "openExternal":
            if let u = URL(string: a["url"] as? String ?? "") { NSWorkspace.shared.open(u) }
            reply(wv, id, true, nil)
        case "inbox.take": reply(wv, id, true, selftest != nil ? [] : takeInbox())
        case "claude.request": // 우클릭 → 회의록 만들기/콘티 준비하기: 같은 맥의 처리기(watch.py)가 읽는 로컬 폴더에 요청 파일을 둔다
            do {
                // 자가검사는 진짜 처리기를 깨우지 않게 시험 폴더에만 쓴다
                let dir = selftest.map { URL(fileURLWithPath: $0 + ".claude") } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/SyncMemo/claude-requests")
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                let name = (a["name"] as? String ?? "요청.json").replacingOccurrences(of: "/", with: " ")
                try (a["json"] as? String ?? "{}").write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
                // 1분 주기를 기다리지 않게 처리기를 바로 깨운다 (등록 안 돼 있으면 조용히 실패 → 다음 주기에 처리)
                if selftest == nil { let p = Process(); p.executableURL = URL(fileURLWithPath: "/bin/launchctl")
                p.arguments = ["kickstart", "gui/\(getuid())/com.caleb.syncmemo-claude"]; try? p.run() }
                reply(wv, id, true, nil)
            } catch { reply(wv, id, false, error.localizedDescription) }
        case "files.pick": // 📎 버튼
            let p = NSOpenPanel(); p.allowsMultipleSelection = true; p.canChooseDirectories = false
            p.beginSheetModal(for: wv.window ?? window) { r in
                if r == .OK { self.pendingFiles += p.urls }
                self.reply(wv, id, true, r == .OK ? p.urls.map { ["name": $0.lastPathComponent] } : [])
            }
        case "files.clear": pendingFiles = []; reply(wv, id, true, nil)
        case "files.upload":
            let list = pendingFiles
            if list.isEmpty { return reply(wv, id, true, []) }
            if selftest != nil { pendingFiles = []; return reply(wv, id, true, list.map { ["id": "selftest", "name": $0.lastPathComponent, "size": fileSize($0)] }) }
            Task { @MainActor in
                do {
                    let out = try await self.uploadAll(list, wv, cid, sec)
                    self.pendingFiles.removeAll { list.contains($0) }
                    self.reply(wv, id, true, out)
                } catch { self.reply(wv, id, false, (error as? AuthError)?.msg ?? error.localizedDescription) }
            }
        default: reply(wv, id, false, "알 수 없는 요청 \(method)")
        }
    }

    // ───────── 첨부 → 드라이브 '싱크 메모 첨부' (안드로이드와 같은 방식: 이어올리기, 파일을 메모리에 다 올리지 않음) ─────────
    func fileSize(_ u: URL) -> Int64 { ((try? FileManager.default.attributesOfItem(atPath: u.path))?[.size] as? NSNumber)?.int64Value ?? 0 }
    struct ScopeError: Error {}
    func driveToken(_ cid: String, _ sec: String, force: Bool = false) async throws -> String {
        try await withCheckedThrowingContinuation { c in auth.token(clientId: cid, secret: sec, force: force) { r in c.resume(with: r.mapError { $0 as Error }) } }
    }
    func driveLogin(_ cid: String, _ sec: String) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in auth.login(clientId: cid, secret: sec) { r in c.resume(with: r.mapError { $0 as Error }) } }
    }
    func driveReq(_ r: URLRequest, file: URL? = nil) async throws -> (Data, HTTPURLResponse) {
        let (d, resp): (Data, URLResponse)
        if let f = file { (d, resp) = try await URLSession.shared.upload(for: r, fromFile: f) } else { (d, resp) = try await URLSession.shared.data(for: r) }
        let h = resp as! HTTPURLResponse
        if h.statusCode == 403 || h.statusCode == 401 { throw ScopeError() }
        if !(200..<300).contains(h.statusCode) { throw AuthError(msg: "드라이브 오류 \(h.statusCode)") }
        return (d, h)
    }
    func req(_ url: String, _ t: String, _ method: String = "GET", json: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: URL(string: url)!); r.httpMethod = method; r.timeoutInterval = 600
        r.setValue("Bearer " + t, forHTTPHeaderField: "Authorization")
        if let j = json { r.setValue("application/json; charset=UTF-8", forHTTPHeaderField: "Content-Type"); r.httpBody = try? JSONSerialization.data(withJSONObject: j) }
        return r
    }
    /// 이름으로 폴더를 찾고(앱이 만든 것만 보인다) 없으면 만든다
    func attachFolder(_ t: String) async throws -> String {
        let key = "folder:" + ATTACH_FOLDER
        if let id = UserDefaults.standard.string(forKey: key),
           let (d, _) = try? await driveReq(req("https://www.googleapis.com/drive/v3/files/\(id)?fields=trashed", t)),
           (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["trashed"] as? Bool == false { return id }
        var c = URLComponents(string: "https://www.googleapis.com/drive/v3/files")!
        c.queryItems = [.init(name: "fields", value: "files(id)"), .init(name: "q", value: "name='\(ATTACH_FOLDER)' and mimeType='application/vnd.google-apps.folder' and trashed=false")]
        let (d, _) = try await driveReq(req(c.url!.absoluteString, t))
        var id = ((try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["files"] as? [[String: Any]])?.first?["id"] as? String
        if id == nil {
            let (d2, _) = try await driveReq(req("https://www.googleapis.com/drive/v3/files?fields=id", t, "POST", json: ["name": ATTACH_FOLDER, "mimeType": "application/vnd.google-apps.folder"]))
            id = (try? JSONSerialization.jsonObject(with: d2) as? [String: Any])?["id"] as? String
        }
        guard let f = id else { throw AuthError(msg: "첨부 폴더를 만들지 못했어요") }
        UserDefaults.standard.set(f, forKey: key)
        return f
    }
    func uploadOne(_ u: URL, _ t: String, _ folder: String) async throws -> [String: Any] {
        let mime = UTType(filenameExtension: u.pathExtension)?.preferredMIMEType ?? "application/octet-stream", size = fileSize(u)
        var r = req("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", t, "POST", json: ["name": u.lastPathComponent, "parents": [folder]])
        r.setValue(mime, forHTTPHeaderField: "X-Upload-Content-Type"); r.setValue(String(size), forHTTPHeaderField: "X-Upload-Content-Length")
        let (_, h) = try await driveReq(r)
        guard let loc = h.value(forHTTPHeaderField: "Location") else { throw AuthError(msg: "올릴 주소를 받지 못했어요") }
        var p = req(loc, t, "PUT"); p.setValue(mime, forHTTPHeaderField: "Content-Type")
        let (d, _) = try await driveReq(p, file: u)
        guard let fid = (try? JSONSerialization.jsonObject(with: d) as? [String: Any])?["id"] as? String else { throw AuthError(msg: "올린 파일 id 없음") }
        return ["id": fid, "name": u.lastPathComponent, "size": size, "mime": mime]
    }
    func uploadAll(_ list: [URL], _ wv: WKWebView, _ cid: String, _ sec: String) async throws -> [[String: Any]] {
        func run(_ force: Bool) async throws -> [[String: Any]] {
            let t = try await driveToken(cid, sec, force: force), folder = try await attachFolder(t)
            var out: [[String: Any]] = []
            for (i, u) in list.enumerated() {
                _ = try? await wv.evaluateJavaScript("App.progress('드라이브에 올리는 중… \(i + 1)/\(list.count)')")
                out.append(try await uploadOne(u, t, folder))
            }
            return out
        }
        do { return try await run(false) } catch is ScopeError {} // 토큰 만료일 수도 → 새 토큰으로 한 번 더
        do { return try await run(true) } catch is ScopeError {
            // v1.4.14 전 로그인은 첨부 권한(drive.file)이 없다 → 한 번 다시 허용받고 이어서 올린다
            _ = try? await wv.evaluateJavaScript("App.progress('브라우저에서 구글 ‘파일 첨부’ 권한을 허용해 주세요…')")
            try await driveLogin(cid, sec)
            do { return try await run(true) } catch is ScopeError { throw AuthError(msg: "드라이브 첨부 권한이 없어요") }
        }
    }

    /// 받은 txt → 메모 (오너 2026-11-05). ~/Library/Application Support/SyncMemo/inbox/[폴더/]제목.txt
    /// 읽은 파일은 inbox/가져옴/ 으로 옮긴다(지우지 않음). 하위 폴더 이름 = 메모 폴더 이름.
    func takeInbox() -> [[String: Any]] {
        let fm = FileManager.default
        let root = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/SyncMemo/inbox")
        let done = root.appendingPathComponent("가져옴")
        try? fm.createDirectory(at: done, withIntermediateDirectories: true)
        var out: [[String: Any]] = []
        guard let en = fm.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return out }
        for case let u as URL in en {
            if u.path.hasPrefix(done.path) { en.skipDescendants(); continue }
            guard u.pathExtension.lowercased() == "txt", let text = try? String(contentsOf: u, encoding: .utf8) else { continue }
            let rel = u.deletingLastPathComponent().path.dropFirst(root.path.count).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let t = (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
            var dst = done.appendingPathComponent(u.lastPathComponent), i = 2
            while fm.fileExists(atPath: dst.path) { dst = done.appendingPathComponent("\(u.deletingPathExtension().lastPathComponent)_\(i).txt"); i += 1 }
            guard (try? fm.moveItem(at: u, to: dst)) != nil else { continue }   // 못 옮기면 다음에 다시(중복 방지)
            out.append(["name": u.deletingPathExtension().lastPathComponent, "folder": rel, "text": text, "mtime": t.timeIntervalSince1970 * 1000])
        }
        return out
    }

    /// 구글 API 호출 대행 (내장 화면의 syncmemo:// 출처는 구글 CORS 밖이라)
    func http(_ wv: WKWebView, _ id: Int, _ a: [String: Any]) {
        if selftest != nil { return reply(wv, id, true, ["status": 0, "body": "selftest"]) }
        guard let u = URL(string: a["url"] as? String ?? ""), ["oauth2.googleapis.com", "www.googleapis.com"].contains(u.host ?? "") else {
            return reply(wv, id, false, "허용되지 않은 주소")
        }
        var req = URLRequest(url: u)
        req.httpMethod = a["method"] as? String ?? "GET"
        (a["headers"] as? [String: String])?.forEach { req.setValue($0.value, forHTTPHeaderField: $0.key) }
        if let b = a["body"] as? String { req.httpBody = b.data(using: .utf8) }
        URLSession.shared.dataTask(with: req) { data, resp, err in
            DispatchQueue.main.async {
                if let err = err { return self.reply(wv, id, false, err.localizedDescription) }
                self.reply(wv, id, true, ["status": (resp as? HTTPURLResponse)?.statusCode ?? 0, "body": String(decoding: data ?? Data(), as: UTF8.self)])
            }
        }.resume()
    }

    func reply(_ wv: WKWebView, _ id: Int, _ ok: Bool, _ data: Any?) {
        let v = data ?? NSNull()
        let json = (try? JSONSerialization.data(withJSONObject: v, options: [.fragmentsAllowed])).map { String(decoding: $0, as: UTF8.self) } ?? "null"
        wv.evaluateJavaScript("window.__native&&__native.resolve(\(id),\(ok),\(json))", completionHandler: nil)
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
        panel.beginSheetModal(for: w.window ?? window) { r in completionHandler(r == .OK ? panel.urls : nil) }
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
        await new Promise(res => setTimeout(res, 400));
        App.newNote();
        await new Promise(res => setTimeout(res, 200));
        const long = Array.from({ length: 60 }, (_, i) => i % 2 ? '- ' + i + '번째 줄 설명' : 'https://www.youtube.com/watch?v=abc' + i).join('\\n');
        const dt = new DataTransfer(); dt.setData('text/plain', long); dt.setData('text/html', '<h1><b>' + long.split('\\n').join('</b></h1><h1><b>') + '</b></h1>');
        document.getElementById('editor').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        await new Promise(res => setTimeout(res, 300));
        const e = document.getElementById('editor');
        r.paste = { h1: e.querySelectorAll('h1').length, bold: e.querySelectorAll('b,strong').length, p: e.querySelectorAll('p').length, links: e.querySelectorAll('a[href]').length };
        r.layout = { scroll: document.scrollingElement.scrollTop + document.getElementById('app').scrollTop, headTop: Math.round(document.querySelector('.list-head').getBoundingClientRect().top), editH: Math.round(document.getElementById('edit').getBoundingClientRect().height), vh: innerHeight };
        await App._test.saveNow();
        r.saved = [...App._test.recs().values()].some(x => x.kind === 'note' && (x.text || '').includes('59번째'));
        const k = await crypto.subtle.importKey('raw', new TextEncoder().encode('pw'), 'PBKDF2', false, ['deriveKey']); r.pbkdf2 = !!k;
        const card = document.querySelector('.card.on'); const cr = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: cr.left + 20, clientY: cr.top + 10 }));
        await new Promise(res => setTimeout(res, 100));
        r.editBtns = ['btnMinutes', 'btnConti'].map(i => { const b = document.getElementById(i); return b.textContent + ':' + (b.offsetWidth > 0); });
        r.menu = [...document.querySelectorAll('.mi')].map(b => b.textContent).filter(t => t.includes('Claude'));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        r.claudeReq = await Native.call('claude.request', { name: '검사 콘티.json', json: JSON.stringify({ v: 1, kind: '콘티', title: '검사' }) }).then(() => true, e => String(e));
        r.noteId = document.querySelector('.card.on')?.dataset.id; r.sideW = Math.round(document.getElementById('side').getBoundingClientRect().width); r.fs = getComputedStyle(document.getElementById('editor')).fontSize;
        return JSON.stringify(r);
        """
        web.callAsyncJavaScript(code, arguments: [:], in: nil, in: .page) { res in
            var text = ""
            switch res { case .success(let v): text = (v as? String) ?? "\(v)"; case .failure(let e): text = "{\"error\":\(String(reflecting: e.localizedDescription))}" }
            // 끌기 띠: 창 맨 위를 누르면 화면이 아니라 띠가 받는지
            let box = self.window.contentView!
            let hit = box.hitTest(NSPoint(x: box.bounds.midX, y: box.bounds.height - 10))
            text = String(text.trimmingCharacters(in: .whitespacesAndNewlines).dropLast()) + ",\"dragStrip\":\(hit is DragStrip),\"belowIsWeb\":\(box.hitTest(NSPoint(x: box.bounds.midX, y: box.bounds.height - 60)) is WKWebView)}"
            try? text.write(toFile: out, atomically: true, encoding: .utf8)
            // 본문 우클릭 메뉴: 회의록·콘티가 붙는지 → 콘티를 누르면 확인창이 뜨는지
            if let w = self.web as? Web, let ev = NSEvent.mouseEvent(with: .rightMouseDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: self.window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                let m = NSMenu(); m.addItem(withTitle: "복사", action: nil, keyEquivalent: "")
                w.willOpenMenu(m, with: ev)
                let titles = m.items.map { $0.title }.filter { !$0.isEmpty }
                if let it = m.items.last { w.claudeItem(it) }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                    w.evaluateJavaScript("(document.querySelector('.modal h3, #modal h3, h3')||{}).textContent||''") { r, _ in
                        let j = try? JSONSerialization.data(withJSONObject: ["menu": titles, "dialog": (r as? String) ?? ""])
                        try? j?.write(to: URL(fileURLWithPath: out + ".menu"))
                    }
                }
            }
            // 더블클릭 새 창
            if let d = text.data(using: .utf8), let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any], let id = j["noteId"] as? String {
                self.openNoteWindow(id, "검사")
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                    let w = self.noteWindows[id]
                    let v = w?.contentView?.subviews.first { $0 is WKWebView } as? WKWebView
                    v?.evaluateJavaScript("JSON.stringify({single: document.getElementById('app').classList.contains('single'), len: document.getElementById('editor').innerText.length, listShown: getComputedStyle(document.getElementById('list')).display !== 'none'})") { r, _ in
                        try? ((r as? String) ?? "null").write(toFile: out + ".win", atomically: true, encoding: .utf8)
                        w?.close()
                        // 새 창 검사가 끝난 뒤에 (동시에 돌면 열린 메모가 바뀌는 경합)
                        if let mw = self.web as? Web { self.selftestAttach(mw, out) { self.finishSelftest(out) } } else { self.finishSelftest(out) }
                    }
                }
                return
            }
            self.finishSelftest(out)
        }
    }
    /// 자가검사: 클립보드 그림 붙여넣기 → 본문 <img>, 그림 아닌 파일 끌어 놓기 → 📎 칩. 오너 클립보드는 검사 뒤 되돌린다
    func selftestAttach(_ w: Web, _ out: String, _ done: @escaping () -> Void) {
        w.evaluateJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); document.querySelector('#modal [data-x], .modal [data-x]')?.click(); const e=document.getElementById('editor'); e.addEventListener('paste', ev => { window.__p = [...ev.clipboardData.types].join(',') + ' files=' + ev.clipboardData.files.length + ' items=' + [...ev.clipboardData.items].map(i => i.kind + ':' + i.type).join(','); }, { capture: true }); e.focus(); const s=getSelection(); s.selectAllChildren(e); s.collapseToEnd(); e.querySelectorAll('img').length") { before, _ in
            let pb = NSPasteboard.general
            let saved = (pb.pasteboardItems ?? []).map { it -> NSPasteboardItem in let n = NSPasteboardItem(); for t in it.types { if let d = it.data(forType: t) { n.setData(d, forType: t) } }; return n }
            let img = NSImage(size: NSSize(width: 40, height: 40)); img.lockFocus(); NSColor.systemRed.setFill(); NSRect(x: 0, y: 0, width: 40, height: 40).fill(); img.unlockFocus()
            let png = NSBitmapImageRep(data: img.tiffRepresentation!)!.representation(using: .png, properties: [:])!
            pb.clearContents(); pb.setData(png, forType: .png)
            self.window.makeFirstResponder(w)
            w.perform(NSSelectorFromString("paste:"), with: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                pb.clearContents(); if !saved.isEmpty { pb.writeObjects(saved) }
                let tmp = URL(fileURLWithPath: out + ".녹음.m4a"); try? Data(repeating: 1, count: 2048).write(to: tmp)
                self.pendingFiles = [tmp]
                w.evaluateJavaScript("App.dropFiles(); 0") { _, _ in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
                        w.evaluateJavaScript("JSON.stringify({paste: window.__p || '', img: document.querySelectorAll('#editor img').length, chips: [...document.querySelectorAll('#editor a.file')].map(a => a.textContent), toast: document.getElementById('toast').textContent})") { r, _ in
                            let s = (r as? String) ?? "{}"
                            try? (String(s.dropLast()) + ",\"imgBefore\":\(before ?? -1),\"clipRestored\":\(saved.isEmpty || pb.pasteboardItems?.count == saved.count)}").write(toFile: out + ".attach", atomically: true, encoding: .utf8)
                            try? FileManager.default.removeItem(at: tmp)
                            done()
                        }
                    }
                }
            }
        }
    }
    func finishSelftest(_ out: String) {
        do {
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
