package net.live1379.syncmemo;

import android.Manifest;
import android.app.Activity;
import android.app.StatusBarManager;
import android.content.ComponentName;
import android.content.ContentValues;
import android.database.Cursor;
import android.provider.OpenableColumns;
import android.graphics.drawable.Icon;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.os.Build;
import android.view.Window;
import android.view.WindowInsetsController;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebSettingsCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewFeature;

import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.util.ArrayList;
import java.util.List;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 싱크 메모 안드로이드 앱.
 * 화면은 앱 안에 내장한 웹 화면(assets/www, 저장소의 docs/)을 쓰고,
 * 구글 로그인·마이크·파일·공유·인쇄·저장은 네이티브가 처리한다.
 * 내장 화면은 https://appassets.androidplatform.net 출처로 열려서 IndexedDB·암호화(보안 컨텍스트)가 그대로 동작한다.
 */
public class MainActivity extends Activity {
    static final String HOST = "appassets.androidplatform.net";
    static final String BASE = "https://" + HOST + "/assets/www/index.html";
    static final String SCOPE = "https://www.googleapis.com/auth/drive.appdata";
    // 첨부·Claude 요청은 오너 드라이브의 보이는 폴더에 올린다 — 앱이 만든 파일만 다루는 drive.file (첨부할 때 처음 한 번 허용)
    static final String FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";
    static final String ATTACH_FOLDER = "싱크 메모 첨부", REQUEST_FOLDER = "싱크 메모 Claude 요청";
    static final int REQ_FILE = 1, REQ_AUTH = 2, REQ_MIC = 3, REQ_PICK = 4, REQ_AUTH2 = 5;

    WebView web;
    WebViewAssetLoader loader;
    SharedPreferences prefs;
    ValueCallback<Uri[]> fileCb;
    PermissionRequest micReq;
    int authCallId = -1;
    String token;
    long tokenAt;
    boolean loaded;
    int shownDisplay = -1;
    @SuppressWarnings("deprecation")
    int displayId() { return Build.VERSION.SDK_INT >= 30 ? getDisplay().getDisplayId() : getWindowManager().getDefaultDisplay().getDisplayId(); }
    final ExecutorService bg = Executors.newSingleThreadExecutor();
    final ExecutorService up = Executors.newSingleThreadExecutor(); // 큰 녹음 올리기가 동기화 토큰 작업을 막지 않게 따로
    final List<Uri> pending = new ArrayList<>(); // 공유받았거나 고른 파일 — 화면이 붙일 메모를 고르면 올린다
    int pickCallId = -1, fileAuthId = -1;
    Tok fileAuthThen;
    interface Tok { void got(String token) throws Exception; }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        shownDisplay = displayId();
        prefs = getSharedPreferences("sync", MODE_PRIVATE);
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.bg)); // 로딩 중 흰 화면 번쩍임 방지
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100); // 시스템 글자 크기가 화면을 깨지 않게
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setAllowFileAccess(false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING))
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false); // 다크 모드는 화면이 직접 처리

        loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                return loader.shouldInterceptRequest(r.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                if (HOST.equals(r.getUrl().getHost())) return false;
                openExternal(r.getUrl().toString());
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) { loaded = true; }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (fileCb != null) fileCb.onReceiveValue(null);
                fileCb = cb;
                boolean image = false;
                for (String t : p.getAcceptTypes()) if (t != null && t.contains("image")) image = true;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(image ? "image/*" : "*/*");
                if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, null), REQ_FILE);
                    return true;
                } catch (Exception e) {
                    fileCb = null;
                    return false;
                }
            }

            @Override
            public void onPermissionRequest(PermissionRequest r) {
                runOnUiThread(() -> {
                    if (!Arrays.asList(r.getResources()).contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) { r.deny(); return; }
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        r.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        micReq = r;
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                    }
                });
            }
        });
        web.addJavascriptInterface(new Bridge(), "SyncMemoAndroid");
        setContentView(web);
        String q = state == null ? launchQuery(getIntent()) : null; // 화면을 새로 만들 때(덱스 이동) 같은 공유를 두 번 받지 않게
        web.loadUrl(q == null ? BASE : BASE + "?" + q);
    }

    /** 공유받기·바로가기 → 화면에 넘길 쿼리 (?text= / ?new= / ?files=) */
    String launchQuery(Intent it) {
        if (it == null) return null;
        if (Intent.ACTION_SEND.equals(it.getAction()) || Intent.ACTION_SEND_MULTIPLE.equals(it.getAction())) {
            List<Uri> uris = streams(it);
            if (!uris.isEmpty()) { // 녹음(m4a)·전사(txt) 같은 파일 → 화면이 붙일 메모를 묻는다
                pending.clear();
                pending.addAll(uris);
                return "files=" + uris.size();
            }
        }
        if (Intent.ACTION_SEND.equals(it.getAction())) {
            String text = it.getStringExtra(Intent.EXTRA_TEXT), title = it.getStringExtra(Intent.EXTRA_SUBJECT);
            return "text=" + Uri.encode(text == null ? "" : text) + (title != null ? "&title=" + Uri.encode(title) : "");
        }
        if ("net.live1379.syncmemo.NEW".equals(it.getAction())) {
            String t = it.getStringExtra("template");
            return "new=" + Uri.encode(t == null ? "1" : t);
        }
        return null;
    }

    @SuppressWarnings("deprecation")
    List<Uri> streams(Intent it) {
        List<Uri> out = new ArrayList<>();
        try {
            if (Intent.ACTION_SEND_MULTIPLE.equals(it.getAction())) {
                ArrayList<Uri> l = it.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
                if (l != null) for (Uri u : l) if (u != null) out.add(u);
            } else {
                Uri u = it.getParcelableExtra(Intent.EXTRA_STREAM);
                if (u != null) out.add(u);
            }
        } catch (Exception ignored) { }
        if (out.isEmpty() && it.getClipData() != null && it.getStringExtra(Intent.EXTRA_TEXT) == null)
            for (int i = 0; i < it.getClipData().getItemCount(); i++) {
                Uri u = it.getClipData().getItemAt(i).getUri();
                if (u != null) out.add(u);
            }
        return out;
    }

    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        setIntent(it);
        String q = launchQuery(it);
        if (q == null) return;
        if (loaded) web.evaluateJavascript("App.launch(" + JSONObject.quote(q) + ")", null); // 페이지를 다시 불러오지 않는다
        else web.loadUrl(BASE + "?" + q);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); // 편집 → 목록 → 폴더 (화면 안의 뒤로가기 기록)
        else moveTaskToBack(true);          // 앱을 끄지 않고 뒤로 보내서 다시 열 때 즉시 뜬다
    }

    @Override
    protected void onPause() { super.onPause(); web.onPause(); }

    @Override
    protected void onResume() { super.onResume(); web.onResume(); }

    @Override
    protected void onDestroy() { web.destroy(); bg.shutdown(); up.shutdown(); super.onDestroy(); }

    @Override
    protected void onActivityResult(int req, int code, Intent data) {
        super.onActivityResult(req, code, data);
        if (req == REQ_FILE) {
            Uri[] res = null;
            if (code == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    res = new Uri[data.getClipData().getItemCount()];
                    for (int i = 0; i < res.length; i++) res[i] = data.getClipData().getItemAt(i).getUri();
                } else if (data.getData() != null) res = new Uri[]{data.getData()};
            }
            if (fileCb != null) fileCb.onReceiveValue(res);
            fileCb = null;
        } else if (req == REQ_PICK) {
            int id = pickCallId;
            pickCallId = -1;
            pending.clear();
            if (code == RESULT_OK && data != null) {
                if (data.getClipData() != null)
                    for (int i = 0; i < data.getClipData().getItemCount(); i++) pending.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) pending.add(data.getData());
            }
            resolve(id, pendingInfo());
        } else if (req == REQ_AUTH2) {
            int id = fileAuthId;
            Tok then = fileAuthThen;
            fileAuthId = -1;
            fileAuthThen = null;
            try {
                runTok(id, then, Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(data).getAccessToken());
            } catch (ApiException e) {
                reject(id, explain(e));
            } catch (Exception e) {
                reject(id, "드라이브 권한을 받지 못했어요");
            }
        } else if (req == REQ_AUTH) {
            int id = authCallId;
            authCallId = -1;
            // 취소로 닫혀도 구글이 실제 이유(상태 코드)를 담아 보내는 경우가 많다 → 그대로 보여준다
            try {
                AuthorizationResult r = Identity.getAuthorizationClient(this).getAuthorizationResultFromIntent(data);
                if (r.getAccessToken() != null) { gotToken(id, r.getAccessToken()); return; }
            } catch (ApiException e) {
                reject(id, explain(e));
                return;
            } catch (Exception ignored) { }
            reject(id, code == RESULT_OK ? "토큰을 받지 못했어요"
                    : "구글 연결이 끝나지 않았어요 — 직접 취소한 게 아니라면 구글 클라우드에 Android 클라이언트(패키지 net.live1379.syncmemo + SHA-1)와 Drive API 사용 설정이 되어 있는지 확인하세요");
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] results) {
        if (req == REQ_MIC && micReq != null) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED)
                micReq.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            else micReq.deny();
            micReq = null;
        }
    }

    // ───────── 화면 ↔ 네이티브 ─────────
    class Bridge {
        @JavascriptInterface
        public void call(String json) {
            runOnUiThread(() -> {
                int id = -1;
                try {
                    JSONObject o = new JSONObject(json);
                    id = o.getInt("id");
                    handle(id, o.getString("method"), o.optJSONObject("args"));
                } catch (Exception e) {
                    reject(id, String.valueOf(e.getMessage()));
                }
            });
        }
    }

    void handle(int id, String method, JSONObject a) throws Exception {
        if (a == null) a = new JSONObject();
        switch (method) {
            case "auth.status":
                resolve(id, new JSONObject().put("connected", prefs.getBoolean("authed", false)));
                break;
            case "auth.login":
                authorize(id, true);
                break;
            case "auth.token":
                if (!prefs.getBoolean("authed", false)) { reject(id, "login"); break; }
                if (a.optBoolean("force") && token != null) {
                    String old = token;
                    token = null;
                    bg.execute(() -> {
                        try { GoogleAuthUtil.clearToken(this, old); } catch (Exception ignored) { }
                        runOnUiThread(() -> authorize(id, false));
                    });
                    break;
                }
                if (token != null && System.currentTimeMillis() - tokenAt < 45 * 60 * 1000L) {
                    resolve(id, new JSONObject().put("token", token));
                    break;
                }
                authorize(id, false);
                break;
            case "auth.logout":
                prefs.edit().putBoolean("authed", false).apply();
                if (token != null) {
                    String old = token;
                    bg.execute(() -> { try { GoogleAuthUtil.clearToken(this, old); } catch (Exception ignored) { } });
                }
                token = null;
                resolve(id, JSONObject.NULL);
                break;
            case "saveFile":
                saveFile(id, a.getString("name"), a.getString("text"));
                break;
            case "print":
                PrintManager pm = (PrintManager) getSystemService(PRINT_SERVICE);
                pm.print("싱크 메모", web.createPrintDocumentAdapter("싱크 메모"), null);
                resolve(id, JSONObject.NULL);
                break;
            case "share":
                Intent s = new Intent(Intent.ACTION_SEND).setType("text/plain")
                        .putExtra(Intent.EXTRA_SUBJECT, a.optString("title"))
                        .putExtra(Intent.EXTRA_TEXT, a.optString("text"));
                startActivity(Intent.createChooser(s, "공유"));
                resolve(id, JSONObject.NULL);
                break;
            case "sysDark":
                resolve(id, isNight() ? "true" : "false");
                break;
            case "bars":
                setBars(a.optBoolean("dark"));
                resolve(id, JSONObject.NULL);
                break;
            case "addTile":
                if (Build.VERSION.SDK_INT >= 33) {
                    StatusBarManager sbm = getSystemService(StatusBarManager.class);
                    sbm.requestAddTileService(new ComponentName(this, NewNoteTile.class), "새 메모",
                            Icon.createWithResource(this, R.drawable.ic_tile), getMainExecutor(), result -> {
                                try {
                                    String msg = result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ADDED ? "알림창에 추가했어요"
                                            : result == StatusBarManager.TILE_ADD_REQUEST_RESULT_TILE_ALREADY_ADDED ? "이미 알림창에 있어요"
                                            : "추가하지 않았어요 — 알림창 편집(연필)에서 '새 메모'를 끌어다 놓아도 됩니다";
                                    resolve(id, new JSONObject().put("msg", msg));
                                } catch (Exception ignored) { }
                            });
                } else {
                    resolve(id, new JSONObject().put("msg", "알림창을 내려 편집(연필) → '새 메모'를 끌어다 놓으세요"));
                }
                break;
            case "files.pick": {
                pickCallId = id;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
                        .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                startActivityForResult(Intent.createChooser(i, "첨부할 파일"), REQ_PICK);
                break;
            }
            case "files.pending":
                resolve(id, pendingInfo());
                break;
            case "files.upload": {
                final List<Uri> list = new ArrayList<>(pending);
                if (list.isEmpty()) { resolve(id, new JSONArray()); break; }
                fileToken(id, t -> {
                    JSONArray out = new JSONArray();
                    for (int i = 0; i < list.size(); i++) out.put(uploadUri(t, list.get(i), (i + 1) + "/" + list.size()));
                    runOnUiThread(() -> pending.removeAll(list));
                    resolve(id, out);
                });
                break;
            }
            case "claude.request": { // 길게 누르기 → Claude 에게 회의록: 메모 내용·첨부 목록을 요청 파일로 올린다 (맥이 받아 처리)
                final String name = a.getString("name");
                final byte[] b = a.getString("json").getBytes(StandardCharsets.UTF_8);
                fileToken(id, t -> resolve(id, upload(t, REQUEST_FOLDER, name, "application/json", new ByteArrayInputStream(b), b.length, null)));
                break;
            }
            case "openExternal":
                openExternal(a.getString("url"));
                resolve(id, JSONObject.NULL);
                break;
            default:
                reject(id, "알 수 없는 요청 " + method);
        }
    }

    /** 구글 Authorization API — 폰에 로그인된 계정으로 drive.appdata 권한. 처음 한 번만 고르면 이후엔 조용히 토큰이 나온다. */
    void authorize(int id, boolean interactive) {
        AuthorizationRequest req = AuthorizationRequest.builder()
                .setRequestedScopes(Collections.singletonList(new Scope(SCOPE))).build();
        Identity.getAuthorizationClient(this).authorize(req)
                .addOnSuccessListener(r -> {
                    if (r.hasResolution()) {
                        if (!interactive) { reject(id, "login"); return; }
                        try {
                            authCallId = id;
                            startIntentSenderForResult(r.getPendingIntent().getIntentSender(), REQ_AUTH, null, 0, 0, 0);
                        } catch (Exception e) {
                            reject(id, "구글 연결 실패: " + e.getMessage());
                        }
                    } else gotToken(id, r.getAccessToken());
                })
                .addOnFailureListener(e -> reject(id, e instanceof ApiException ? explain((ApiException) e) : "구글 연결 실패: " + e.getMessage()));
    }

    /** drive.file 까지 받은 토큰으로 작업. 처음엔 구글 허용 창이 한 번 뜬다. 동기화(appdata)는 이 권한 없이 그대로 돈다. */
    void fileToken(int id, Tok then) {
        AuthorizationRequest req = AuthorizationRequest.builder()
                .setRequestedScopes(Arrays.asList(new Scope(SCOPE), new Scope(FILE_SCOPE))).build();
        Identity.getAuthorizationClient(this).authorize(req)
                .addOnSuccessListener(r -> {
                    if (r.hasResolution()) {
                        try {
                            fileAuthId = id;
                            fileAuthThen = then;
                            startIntentSenderForResult(r.getPendingIntent().getIntentSender(), REQ_AUTH2, null, 0, 0, 0);
                        } catch (Exception e) {
                            reject(id, "구글 연결 실패: " + e.getMessage());
                        }
                    } else runTok(id, then, r.getAccessToken());
                })
                .addOnFailureListener(e -> reject(id, e instanceof ApiException ? explain((ApiException) e) : "구글 연결 실패: " + e.getMessage()));
    }

    void runTok(int id, Tok then, String t) {
        if (t == null) { reject(id, "토큰을 받지 못했어요"); return; }
        up.execute(() -> {
            try { then.got(t); } catch (Exception e) { reject(id, "드라이브에 올리지 못했어요: " + e.getMessage()); }
        });
    }

    JSONArray pendingInfo() {
        JSONArray a = new JSONArray();
        for (Uri u : pending) {
            try { String[] m = meta(u); a.put(new JSONObject().put("name", m[0]).put("size", Long.parseLong(m[1]))); } catch (Exception ignored) { }
        }
        return a;
    }

    /** [이름, 크기(-1 = 모름)] */
    String[] meta(Uri u) {
        String name = u.getLastPathSegment() == null ? "파일" : u.getLastPathSegment();
        long size = -1;
        try (Cursor c = getContentResolver().query(u, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME), j = c.getColumnIndex(OpenableColumns.SIZE);
                if (i >= 0 && !c.isNull(i)) name = c.getString(i);
                if (j >= 0 && !c.isNull(j)) size = c.getLong(j);
            }
        } catch (Exception ignored) { }
        return new String[]{name, String.valueOf(size)};
    }

    JSONObject uploadUri(String t, Uri u, String step) throws Exception {
        String[] m = meta(u);
        String mime = getContentResolver().getType(u);
        if (mime == null || mime.equals("application/octet-stream")) mime = guessMime(m[0]);
        long size = Long.parseLong(m[1]);
        File tmp = null;
        try {
            if (size < 0) { // 크기를 모르면 잠깐 복사해서 잰다 (드라이브 이어올리기는 길이가 필요)
                tmp = File.createTempFile("up", null, getCacheDir());
                try (InputStream in = getContentResolver().openInputStream(u); OutputStream os = new FileOutputStream(tmp)) { copy(in, os, -1, null); }
                size = tmp.length();
            }
            try (InputStream in = tmp != null ? new FileInputStream(tmp) : getContentResolver().openInputStream(u)) {
                if (in == null) throw new Exception("파일을 열 수 없어요");
                return upload(t, ATTACH_FOLDER, m[0], mime, in, size, step);
            }
        } finally {
            if (tmp != null) tmp.delete();
        }
    }

    static String guessMime(String name) {
        String n = name.toLowerCase();
        return n.endsWith(".m4a") ? "audio/mp4" : n.endsWith(".mp3") ? "audio/mpeg" : n.endsWith(".wav") ? "audio/wav"
                : n.endsWith(".txt") ? "text/plain" : n.endsWith(".pdf") ? "application/pdf" : "application/octet-stream";
    }

    /** 드라이브 이어올리기(resumable) — 큰 녹음도 메모리에 다 올리지 않고 흘려 보낸다 */
    JSONObject upload(String t, String folderName, String name, String mime, InputStream in, long size, String step) throws Exception {
        String folder = folder(t, folderName);
        HttpURLConnection c = http("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", "POST", t);
        c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
        c.setRequestProperty("X-Upload-Content-Type", mime);
        c.setRequestProperty("X-Upload-Content-Length", String.valueOf(size));
        body(c, new JSONObject().put("name", name).put("parents", new JSONArray().put(folder)).toString());
        text(c);
        String loc = c.getHeaderField("Location");
        if (loc == null) throw new Exception("올릴 주소를 받지 못했어요");
        HttpURLConnection p = (HttpURLConnection) new URL(loc).openConnection();
        p.setRequestMethod("PUT");
        p.setDoOutput(true);
        p.setConnectTimeout(30000);
        p.setReadTimeout(300000);
        p.setRequestProperty("Content-Type", mime);
        p.setFixedLengthStreamingMode(size);
        try (OutputStream os = p.getOutputStream()) { copy(in, os, size, step); }
        JSONObject r = new JSONObject(text(p));
        return new JSONObject().put("id", r.getString("id")).put("name", name).put("size", size).put("mime", mime);
    }

    /** 이름으로 폴더를 찾고(앱이 만든 것만 보인다) 없으면 만든다. 오너가 지웠으면 다시 만든다. */
    String folder(String t, String name) throws Exception {
        String key = "folder:" + name, id = prefs.getString(key, null);
        if (id != null) {
            try {
                if (!new JSONObject(text(http("https://www.googleapis.com/drive/v3/files/" + id + "?fields=trashed", "GET", t))).optBoolean("trashed")) return id;
            } catch (Exception ignored) { }
        }
        String q = "name='" + name.replace("'", "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
        JSONArray f = new JSONObject(text(http("https://www.googleapis.com/drive/v3/files?fields=files(id)&q=" + URLEncoder.encode(q, "UTF-8"), "GET", t))).optJSONArray("files");
        if (f != null && f.length() > 0) id = f.getJSONObject(0).getString("id");
        else {
            HttpURLConnection c = http("https://www.googleapis.com/drive/v3/files?fields=id", "POST", t);
            c.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            body(c, new JSONObject().put("name", name).put("mimeType", "application/vnd.google-apps.folder").toString());
            id = new JSONObject(text(c)).getString("id");
        }
        prefs.edit().putString(key, id).apply();
        return id;
    }

    static HttpURLConnection http(String url, String method, String t) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(30000);
        c.setReadTimeout(60000);
        c.setRequestProperty("Authorization", "Bearer " + t);
        return c;
    }

    static void body(HttpURLConnection c, String s) throws Exception {
        byte[] b = s.getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(b.length);
        try (OutputStream os = c.getOutputStream()) { os.write(b); }
    }

    static String text(HttpURLConnection c) throws Exception {
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        if (in != null) try (InputStream i = in) { byte[] b = new byte[8192]; int n; while ((n = i.read(b)) > 0) bo.write(b, 0, n); }
        String s = bo.toString("UTF-8");
        if (code >= 400) throw new Exception("드라이브 " + code + (code == 403 ? " (권한)" : code == 401 ? " (로그인)" : ""));
        return s;
    }

    /** 복사하면서 1초마다 화면에 진행률을 알린다 */
    void copy(InputStream in, OutputStream os, long size, String step) throws Exception {
        byte[] b = new byte[256 * 1024];
        long done = 0, last = 0;
        int n;
        while ((n = in.read(b)) > 0) {
            os.write(b, 0, n);
            done += n;
            long now = System.currentTimeMillis();
            if (step != null && size > 0 && now - last > 1000) {
                last = now;
                String msg = "드라이브에 올리는 중 " + step + " · " + (done * 100 / size) + "%";
                runOnUiThread(() -> web.evaluateJavascript("window.App&&App.progress&&App.progress(" + JSONObject.quote(msg) + ")", null));
            }
        }
    }

    String explain(ApiException e) {
        int c = e.getStatusCode();
        String hint = c == CommonStatusCodes.DEVELOPER_ERROR ? " — 구글 클라우드에 Android 클라이언트가 없거나 패키지·SHA-1 이 다릅니다"
                : c == CommonStatusCodes.CANCELED || c == 16 ? " — 취소됨"
                : c == CommonStatusCodes.NETWORK_ERROR ? " — 인터넷 연결 확인"
                : c == CommonStatusCodes.SIGN_IN_REQUIRED ? " — 폰에 구글 계정 로그인 필요" : "";
        return "구글 연결 실패 (코드 " + c + " " + CommonStatusCodes.getStatusCodeString(c) + ")" + hint;
    }

    void gotToken(int id, String t) {
        if (t == null) { reject(id, "토큰을 받지 못했어요"); return; }
        token = t;
        tokenAt = System.currentTimeMillis();
        prefs.edit().putBoolean("authed", true).apply();
        try { resolve(id, new JSONObject().put("token", t)); } catch (Exception ignored) { }
    }

    /** 다운로드/싱크메모 폴더에 저장 (백업·마크다운) */
    void saveFile(int id, String name, String text) throws Exception {
        ContentValues v = new ContentValues();
        v.put(MediaStore.Downloads.DISPLAY_NAME, name);
        v.put(MediaStore.Downloads.MIME_TYPE, name.endsWith(".json") ? "application/json" : "application/octet-stream");
        v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/싱크메모");
        Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
        if (uri == null) throw new Exception("저장 위치를 만들 수 없어요");
        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
            os.write(text.getBytes(StandardCharsets.UTF_8));
        }
        resolve(id, new JSONObject().put("path", "다운로드/싱크메모/" + name));
    }

    void openExternal(String url) {
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) { }
    }

    boolean isNight() {
        return (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    /** 상태 표시줄·내비게이션 바를 화면 색과 맞춘다 */
    void setBars(boolean dark) {
        int bg = dark ? 0xFF1C1C1E : 0xFFF6F5F1;
        Window w = getWindow();
        w.setStatusBarColor(bg);
        w.setNavigationBarColor(bg);
        web.setBackgroundColor(bg);
        w.getDecorView().setBackgroundColor(bg);
        if (Build.VERSION.SDK_INT >= 30) {
            int light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            w.getInsetsController().setSystemBarsAppearance(dark ? 0 : light, light);
        } else {
            int f = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            View d = w.getDecorView();
            d.setSystemUiVisibility(dark ? d.getSystemUiVisibility() & ~f : d.getSystemUiVisibility() | f);
        }
    }

    /** 덱스: 앱이 다른 화면(모니터)으로 옮겨지면 웹뷰가 옛 화면 배율(폰 2.6배)을 그대로 써서 전부 크게 나온다
     *  (에뮬레이터 보조 화면 1920×1080·160dpi 실측: 배율 2.625, 화면 폭 732px). 쓰던 메모를 저장하고 화면을 새로 만든다. */
    @Override
    public void onConfigurationChanged(Configuration c) {
        super.onConfigurationChanged(c);
        // 덱스: 앱이 다른 화면(모니터)으로 옮겨지면 웹뷰가 옛 화면 배율(폰 2.6배)을 그대로 써서 전부 크게 나온다
        // (에뮬레이터 보조 화면 1920×1080·160dpi 실측: 배율 2.625, 화면 폭 732px). 쓰던 메모를 저장하고 화면을 새로 만든다.
        int disp = displayId();
        if (shownDisplay >= 0 && disp != shownDisplay) {
            shownDisplay = disp;
            if (!loaded) { recreate(); return; }
            web.evaluateJavascript("window.App&&App.flush&&App.flush()", v -> web.postDelayed(this::recreate, 400));
            return;
        }
        shownDisplay = disp;
        if (loaded) web.evaluateJavascript("App.setSysDark(" + isNight() + ")", null); // 다시 시작하지 않고 바로 반영
    }

    void resolve(int id, Object data) {
        send(id, true, data == JSONObject.NULL || data == null ? "null" : data instanceof String ? (data.equals("true") || data.equals("false") ? (String) data : JSONObject.quote((String) data)) : data.toString());
    }

    void reject(int id, String msg) {
        send(id, false, JSONObject.quote(msg == null ? "오류" : msg));
    }

    void send(int id, boolean ok, String js) {
        runOnUiThread(() -> web.evaluateJavascript("window.__native&&__native.resolve(" + id + "," + ok + "," + js + ")", null));
    }
}
