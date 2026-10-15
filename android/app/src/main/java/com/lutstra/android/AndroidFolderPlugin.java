package com.lutstra.android;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.provider.DocumentsContract;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Library folders chosen through the Storage Access Framework. Each granted tree is walked for
 * sub-folders; the user ticks branches in the tree and only audio inside ticked branches is scanned.
 * A rule on a folder applies to its descendants until a deeper rule overrides it.
 */
@CapacitorPlugin(name = "AndroidFolders")
public final class AndroidFolderPlugin extends Plugin {
    private static final String PREFS = "android-music-folders";
    private static final String KEY_URIS = "uris";
    private static final String KEY_RULES = "rules";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    private static final class Node {
        String key, name, parentKey, treeUri, documentId;
        boolean available;
    }

    private static final class FileRow {
        Uri tree;
        String documentId, name, mime, folderKey;
        Long size, modified;
    }

    @PluginMethod
    public void choose(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "chosenFolder");
    }

    @ActivityCallback
    private void chosenFolder(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("FOLDER_SELECTION_CANCELLED", "FOLDER_SELECTION_CANCELLED");
            return;
        }
        Uri uri = result.getData().getData();
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            JSONArray saved = savedUris();
            boolean exists = false;
            for (int i = 0; i < saved.length(); i++) if (uri.toString().equals(saved.getString(i))) exists = true;
            if (!exists) { saved.put(uri.toString()); prefs().edit().putString(KEY_URIS, saved.toString()).apply(); }
            JSObject response = new JSObject();
            response.put("chosenUri", uri.toString());
            response.put("key", keyOf(uri.getAuthority(), DocumentsContract.getTreeDocumentId(uri)));
            call.resolve(response);
        } catch (Exception error) { call.reject("Could not retain folder access", error); }
    }

    @PluginMethod
    public void getSelection(PluginCall call) {
        try {
            JSObject response = new JSObject(); response.put("rules", new JSONArray(prefs().getString(KEY_RULES, "[]")));
            call.resolve(response);
        } catch (JSONException error) { call.reject("Could not read folder selection", error); }
    }

    @PluginMethod
    public void saveSelection(PluginCall call) {
        JSArray rules = call.getArray("rules");
        if (rules == null) { call.reject("Rules required"); return; }
        prefs().edit().putString(KEY_RULES, rules.toString()).apply();
        call.resolve();
    }

    @PluginMethod
    public void listTree(PluginCall call) {
        executor.execute(() -> {
            try {
                Map<String, Node> nodes = new LinkedHashMap<>();
                collect(nodes, null);
                JSONArray folders = new JSONArray();
                for (Node node : nodes.values()) {
                    JSObject row = new JSObject();
                    row.put("key", node.key); row.put("name", node.name); row.put("parentKey", node.parentKey);
                    row.put("treeUri", node.treeUri); row.put("documentId", node.documentId); row.put("available", node.available);
                    folders.put(row);
                }
                JSObject response = new JSObject(); response.put("folders", folders); call.resolve(response);
            } catch (Exception error) { call.reject("Could not list folders", error); }
        });
    }

    @PluginMethod
    public void scan(PluginCall call) {
        executor.execute(() -> {
            try {
                Map<String, Node> nodes = new LinkedHashMap<>();
                List<FileRow> files = new ArrayList<>();
                collect(nodes, files);
                Map<String, Boolean> rules = new HashMap<>();
                JSONArray savedRules = new JSONArray(prefs().getString(KEY_RULES, "[]"));
                for (int i = 0; i < savedRules.length(); i++) {
                    JSONObject rule = savedRules.getJSONObject(i);
                    rules.put(rule.getString("key"), rule.getBoolean("selected"));
                }
                Map<String, Boolean> folderSelected = new HashMap<>();
                Set<String> seen = new HashSet<>();
                JSONArray tracks = new JSONArray();
                for (FileRow file : files) {
                    Boolean selected = folderSelected.get(file.folderKey);
                    if (selected == null) { selected = isSelected(file.folderKey, nodes, rules); folderSelected.put(file.folderKey, selected); }
                    String key = keyOf(file.tree.getAuthority(), file.documentId);
                    if (!selected || !seen.add(key)) continue;
                    Uri uri = DocumentsContract.buildDocumentUriUsingTree(file.tree, file.documentId);
                    JSObject row = new JSObject();
                    row.put("id", "android:document:" + key); row.put("uri", uri.toString());
                    row.put("folderKey", file.folderKey); row.put("fileName", file.name);
                    row.put("mimeType", file.mime); row.put("fileSize", file.size);
                    row.put("lastModified", file.modified); row.put("relativePath", file.documentId);
                    readMetadata(uri, row);
                    tracks.put(row);
                }
                JSObject response = new JSObject(); response.put("tracks", tracks); call.resolve(response);
            } catch (SecurityException error) {
                call.reject("FOLDER_PERMISSION_REVOKED", "FOLDER_PERMISSION_REVOKED", error);
            } catch (Exception error) { call.reject("Folder scan failed", error); }
        });
    }

    /** Walks every granted tree. With files == null only folders are collected (no scan). */
    private void collect(Map<String, Node> nodes, List<FileRow> files) throws JSONException {
        JSONArray saved = savedUris();
        Set<String> walked = new HashSet<>();
        for (int i = 0; i < saved.length(); i++) {
            Uri tree = Uri.parse(saved.getString(i));
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            String rootKey = keyOf(tree.getAuthority(), rootId);
            boolean available = hasReadGrant(tree);
            if (!available && files != null) throw new SecurityException("FOLDER_PERMISSION_REVOKED: " + tree);
            String name = rootId.substring(Math.max(rootId.lastIndexOf('/'), rootId.lastIndexOf(':')) + 1);
            addNode(nodes, rootKey, name.isEmpty() ? rootId : name, null, tree, rootId, available);
            if (!available || !walked.add(rootKey)) continue;
            try { walk(tree, rootId, rootKey, nodes, files, walked); }
            catch (RuntimeException error) {
                // A granted tree can still vanish, e.g. an ejected SD card. Listing marks it; scanning refuses.
                if (files != null) throw new SecurityException("FOLDER_PERMISSION_REVOKED: " + tree, error);
                nodes.get(rootKey).available = false;
            }
        }
    }

    private void walk(Uri tree, String parentId, String parentKey, Map<String, Node> nodes, List<FileRow> files, Set<String> walked) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentId);
        String[] columns = {
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE,
            DocumentsContract.Document.COLUMN_SIZE,
            DocumentsContract.Document.COLUMN_LAST_MODIFIED
        };
        try (Cursor cursor = getContext().getContentResolver().query(children, columns, null, null, null)) {
            if (cursor == null) throw new SecurityException("Folder is no longer accessible");
            while (cursor.moveToNext()) {
                String documentId = cursor.getString(0);
                String name = cursor.getString(1);
                String mime = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mime)) {
                    String key = keyOf(tree.getAuthority(), documentId);
                    addNode(nodes, key, name, parentKey, tree, documentId, true);
                    if (walked.add(key)) walk(tree, documentId, key, nodes, files, walked);
                    continue;
                }
                if (files == null || !isAudio(name, mime)) continue;
                FileRow file = new FileRow();
                file.tree = tree; file.documentId = documentId; file.name = name; file.mime = mime; file.folderKey = parentKey;
                file.size = cursor.isNull(3) ? null : cursor.getLong(3);
                file.modified = cursor.isNull(4) ? null : cursor.getLong(4);
                files.add(file);
            }
        }
    }

    // A folder reached from a wider granted tree keeps that parent, so overlapping grants form one tree.
    private static void addNode(Map<String, Node> nodes, String key, String name, String parentKey, Uri tree, String documentId, boolean available) {
        Node existing = nodes.get(key);
        if (existing != null) {
            if (existing.parentKey == null && parentKey != null) existing.parentKey = parentKey;
            return;
        }
        Node node = new Node();
        node.key = key; node.name = name; node.parentKey = parentKey;
        node.treeUri = tree.toString(); node.documentId = documentId; node.available = available;
        nodes.put(key, node);
    }

    private static boolean isSelected(String key, Map<String, Node> nodes, Map<String, Boolean> rules) {
        Set<String> seen = new HashSet<>();
        while (key != null && seen.add(key)) {
            Boolean rule = rules.get(key);
            if (rule != null) return rule;
            Node node = nodes.get(key);
            key = node == null ? null : node.parentKey;
        }
        return false;
    }

    private static String keyOf(String authority, String documentId) {
        return authority.length() + ":" + authority + documentId;
    }

    private void readMetadata(Uri uri, JSObject row) {
        MediaMetadataRetriever reader = new MediaMetadataRetriever();
        try {
            reader.setDataSource(getContext(), uri);
            row.put("title", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            // With several ARTIST tags Android returns only one of them, so the album artist groups the library.
            row.put("artist", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            row.put("albumArtist", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            row.put("album", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            row.put("durationMs", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)));
            row.put("trackNumber", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)));
            row.put("year", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR)));
        } catch (RuntimeException ignored) {
            // A malformed file still appears in the library with its document name.
        } finally { try { reader.release(); } catch (Exception ignored) { } }
    }

    // Track numbers may arrive as "3/12".
    private static Long number(String value) {
        if (value == null) return null;
        try { return Long.parseLong(value.split("/")[0].trim()); } catch (NumberFormatException ignored) { return null; }
    }

    private static boolean isAudio(String name, String mime) {
        String lower = name == null ? "" : name.toLowerCase(java.util.Locale.ROOT);
        return (mime != null && mime.startsWith("audio/")) || lower.endsWith(".mp3")
            || lower.endsWith(".flac") || lower.endsWith(".wav") || lower.endsWith(".m4a")
            || lower.endsWith(".ogg") || lower.endsWith(".opus");
    }

    private boolean hasReadGrant(Uri tree) {
        for (android.content.UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.isReadPermission() && permission.getUri().equals(tree)) return true;
        }
        return false;
    }

    private JSONArray savedUris() throws JSONException {
        return new JSONArray(prefs().getString(KEY_URIS, "[]"));
    }

    private android.content.SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    @Override
    protected void handleOnDestroy() { executor.shutdown(); super.handleOnDestroy(); }
}
