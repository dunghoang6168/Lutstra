package com.lutstra.android;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The listening history (play_events) in an app-private SQLite database, with the desktop's schema and queries
 * (electron/services/database.service.ts), so Smart Shuffle keeps what it learned across launches.
 */
@CapacitorPlugin(name = "AndroidHistory")
public final class AndroidHistoryPlugin extends Plugin {
    private static final List<String> STARTS = Arrays.asList("user", "auto", "next", "previous", "resume");
    private static final List<String> ENDS = Arrays.asList("ended", "skip_next", "skip_previous", "picked_other", "app_closed", "other", "removed");
    private static final List<String> SOURCES = Arrays.asList("queue", "roulette", "smart-shuffle");
    private static final double DAY_SECONDS = 60 * 60 * 24;
    private static final int PAGE_LIMIT = 200;
    /** What the History page lists (shownInHistory); the rest stays for the analysis. */
    private static final String SHOWN = "source <> 'roulette' AND end_reason <> 'removed'";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private HistoryDatabase helper;

    @Override
    public void load() {
        helper = new HistoryDatabase(getContext());
    }

    @PluginMethod
    public void record(PluginCall call) {
        ContentValues values;
        try { values = validEvent(call.getData()); } catch (IllegalArgumentException error) { call.reject(error.getMessage()); return; }
        executor.execute(() -> {
            try {
                helper.getWritableDatabase().insertOrThrow("play_events", null, values);
                call.resolve();
            } catch (Exception error) { call.reject("Could not record the listen", error); }
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        Integer limit = call.getInt("limit");
        Long beforeStartedAt = call.getLong("beforeStartedAt");
        Long beforeId = call.getLong("beforeId");
        if (limit == null || limit < 1 || limit > PAGE_LIMIT) { call.reject("Invalid history limit"); return; }
        if ((beforeStartedAt == null) != (beforeId == null)) { call.reject("Invalid history cursor"); return; }
        executor.execute(() -> {
            String where = beforeStartedAt == null ? SHOWN : SHOWN + " AND (started_at < ? OR (started_at = ? AND id < ?))";
            String[] args = beforeStartedAt == null ? null
                : new String[]{ String.valueOf(beforeStartedAt), String.valueOf(beforeStartedAt), String.valueOf(beforeId) };
            JSONArray entries = new JSONArray();
            try (Cursor cursor = helper.getReadableDatabase().query("play_events", new String[]{ "id", "track_id", "started_at" },
                where, args, null, null, "started_at DESC, id DESC", String.valueOf(limit))) {
                while (cursor.moveToNext()) {
                    JSObject entry = new JSObject();
                    entry.put("id", cursor.getLong(0)); entry.put("trackId", cursor.getString(1)); entry.put("startedAt", cursor.getLong(2));
                    entries.put(entry);
                }
                JSObject result = new JSObject(); result.put("entries", entries); call.resolve(result);
            } catch (Exception error) { call.reject("Could not read the history", error); }
        });
    }

    /** Every listen, oldest first, for the listener analysis. */
    @PluginMethod
    public void events(PluginCall call) {
        executor.execute(() -> {
            JSONArray events = new JSONArray();
            try (Cursor cursor = helper.getReadableDatabase().query("play_events", null, null, null, null, null, "started_at, id")) {
                while (cursor.moveToNext()) {
                    JSObject event = new JSObject();
                    event.put("trackId", cursor.getString(cursor.getColumnIndexOrThrow("track_id")));
                    event.put("startedAt", cursor.getLong(cursor.getColumnIndexOrThrow("started_at")));
                    event.put("playedSeconds", cursor.getDouble(cursor.getColumnIndexOrThrow("played_seconds")));
                    event.put("endPosition", cursor.getDouble(cursor.getColumnIndexOrThrow("end_position")));
                    event.put("duration", cursor.getDouble(cursor.getColumnIndexOrThrow("duration")));
                    event.put("seekForwardSeconds", cursor.getDouble(cursor.getColumnIndexOrThrow("seek_forward_seconds")));
                    event.put("startedBy", cursor.getString(cursor.getColumnIndexOrThrow("started_by")));
                    event.put("endReason", cursor.getString(cursor.getColumnIndexOrThrow("end_reason")));
                    event.put("source", cursor.getString(cursor.getColumnIndexOrThrow("source")));
                    events.put(event);
                }
                JSObject result = new JSObject(); result.put("events", events); call.resolve(result);
            } catch (Exception error) { call.reject("Could not read the history", error); }
        });
    }

    @PluginMethod
    public void clear(PluginCall call) {
        executor.execute(() -> {
            try {
                helper.getWritableDatabase().delete("play_events", null, null);
                call.resolve();
            } catch (Exception error) { call.reject("Could not clear the history", error); }
        });
    }

    /** The same checks as the desktop's validPlayEvent (electron/ipc/ipc-validation.ts). */
    private static ContentValues validEvent(JSObject event) {
        String trackId = event.getString("trackId");
        if (trackId == null || trackId.trim().isEmpty() || trackId.length() > 4096) throw new IllegalArgumentException("Invalid listen trackId");
        long startedAt = event.optLong("startedAt", -1);
        if (startedAt <= 0) throw new IllegalArgumentException("Invalid listen startedAt");
        ContentValues values = new ContentValues();
        values.put("track_id", trackId);
        values.put("started_at", startedAt);
        values.put("played_seconds", seconds(event, "playedSeconds"));
        values.put("end_position", seconds(event, "endPosition"));
        values.put("duration", seconds(event, "duration"));
        values.put("seek_forward_seconds", seconds(event, "seekForwardSeconds"));
        values.put("started_by", oneOf(event, "startedBy", STARTS));
        values.put("end_reason", oneOf(event, "endReason", ENDS));
        values.put("source", oneOf(event, "source", SOURCES));
        return values;
    }

    private static double seconds(JSObject event, String name) {
        double value = event.optDouble(name, Double.NaN);
        if (Double.isNaN(value) || Double.isInfinite(value) || value < 0 || value > DAY_SECONDS) throw new IllegalArgumentException("Invalid listen " + name);
        return value;
    }

    private static String oneOf(JSObject event, String name, List<String> values) {
        String value = event.getString(name);
        if (!values.contains(value)) throw new IllegalArgumentException("Invalid listen " + name);
        return value;
    }

    @Override
    protected void handleOnDestroy() { executor.shutdown(); super.handleOnDestroy(); }

    private static final class HistoryDatabase extends SQLiteOpenHelper {
        HistoryDatabase(Context context) { super(context, "lutstra-history.db", null, 1); }

        @Override
        public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE play_events (id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, started_at INTEGER NOT NULL,"
                + " played_seconds REAL NOT NULL, end_position REAL NOT NULL, duration REAL NOT NULL, seek_forward_seconds REAL NOT NULL,"
                + " started_by TEXT NOT NULL, end_reason TEXT NOT NULL, source TEXT NOT NULL)");
            db.execSQL("CREATE INDEX play_events_started_at ON play_events(started_at, id)");
            db.execSQL("CREATE INDEX play_events_track_id ON play_events(track_id)");
        }

        @Override
        public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) { }
    }
}
