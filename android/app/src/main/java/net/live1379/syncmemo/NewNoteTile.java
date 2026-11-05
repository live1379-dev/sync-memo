package net.live1379.syncmemo;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/** 알림창(빠른 설정)의 '새 메모' 버튼 — 누르면 알림창이 접히고 새 메모가 바로 열린다. */
public class NewNoteTile extends TileService {
    @Override
    public void onStartListening() {
        Tile t = getQsTile();
        if (t == null) return;
        t.setState(Tile.STATE_INACTIVE);
        t.setLabel("새 메모");
        t.updateTile();
    }

    @Override
    public void onClick() {
        Intent i = new Intent(this, MainActivity.class)
                .setAction("net.live1379.syncmemo.NEW")
                .putExtra("template", "1")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 1, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        } else {
            startActivityAndCollapse(i);
        }
    }
}
