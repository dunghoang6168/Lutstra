package com.lutstra.android;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.DocumentsContract;
import android.util.AtomicFile;
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
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

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
    private static final String CACHE_FILE = "library-metadata.json";
    private static final String LAST_SCAN_FILE = "last-scan.json";
    private static final String PATH_DOCUMENTS = "com.android.externalstorage.documents";
    // Tag reads wait on storage more than on the CPU, so a few run at once.
    private static final int READ_THREADS = 4;
    private static final String[] METADATA_FIELDS = { "title", "artist", "albumArtist", "album", "durationMs", "trackNumber", "year", "bitrate", "sampleRate", "bitDepth" };
    // Bumped when readMetadata gains fields, so older cache entries are read again.
    private static final int METADATA_VERSION = 5;
    private static final String ARTWORK_DIR = "artwork";
    // Covers are shown at most a phone width wide (about 1000 px), so larger pictures are scaled down once.
    private static final int ARTWORK_SIZE = 1024;
    private static final int ARTWORK_MEDIUM_SIZE = 512;
    private static final int ARTWORK_SMALL_SIZE = 256;
    private static final Set<String> FOLDER_COVERS = new HashSet<>(java.util.Arrays.asList(
        "cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.jpeg", "folder.png", "front.jpg", "front.png"));
    /** Folder key → its cover image, found while a scan walks the folders. */
    private final Map<String, FileRow> folderCovers = new HashMap<>();
    /** Folder key + "/" + lower-case name without ".lrc" → that lyrics file, found while a scan walks the folders. */
    private final Map<String, FileRow> folderLyrics = new HashMap<>();
    // The desktop reads up to 1 MB of lyrics too.
    private static final int MAX_LYRICS_BYTES = 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    // Listing must not queue behind a long first scan, or the folder picker waits for it.
    private final ExecutorService treeExecutor = Executors.newSingleThreadExecutor();

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
        treeExecutor.execute(() -> {
            try {
                Map<String, Node> nodes = new LinkedHashMap<>();
                collect(nodes, null, null);
                JSONArray folders = foldersJson(nodes);
                JSONArray grants = grantsJson();
                JSObject response = new JSObject(); response.put("folders", folders); response.put("grants", grants); call.resolve(response);
            } catch (Exception error) { call.reject("Could not list folders", error); }
        });
    }

    /** Forgets a granted tree. Rules under it stay saved and apply again if the tree is granted later. */
    @PluginMethod
    public void releaseGrant(PluginCall call) {
        String treeUri = call.getString("treeUri");
        if (treeUri == null) { call.reject("treeUri required"); return; }
        try {
            JSONArray saved = savedUris();
            JSONArray kept = new JSONArray();
            for (int i = 0; i < saved.length(); i++) if (!treeUri.equals(saved.getString(i))) kept.put(saved.getString(i));
            prefs().edit().putString(KEY_URIS, kept.toString()).apply();
            try { getContext().getContentResolver().releasePersistableUriPermission(Uri.parse(treeUri), Intent.FLAG_GRANT_READ_URI_PERMISSION); }
            catch (SecurityException ignored) { /* Already gone, e.g. revoked by the system. */ }
            call.resolve();
        } catch (JSONException error) { call.reject("Could not release folder access", error); }
    }

    /** The result of the last finished scan, so the app can show the library before rescanning. */
    @PluginMethod
    public void getLastScan(PluginCall call) {
        treeExecutor.execute(() -> {
            generateMissingThumbnails();
            AtomicFile file = new AtomicFile(new File(getContext().getFilesDir(), LAST_SCAN_FILE));
            try {
                JSObject response = new JSObject(new String(file.readFully(), StandardCharsets.UTF_8));
                JSONArray tracks = response.optJSONArray("tracks");
                if (tracks != null) {
                    for (int i = 0; i < tracks.length(); i++) {
                        JSONObject track = tracks.optJSONObject(i);
                        if (track != null && track.has("artwork") && !track.has("artworkSmall")) {
                            String artPath = track.getString("artwork");
                            String medPath = artPath.replace("-" + ARTWORK_SIZE + ".jpg", "-" + ARTWORK_MEDIUM_SIZE + ".jpg");
                            String smPath = artPath.replace("-" + ARTWORK_SIZE + ".jpg", "-" + ARTWORK_SMALL_SIZE + ".jpg");
                            if (new File(medPath).exists()) track.put("artworkMedium", medPath);
                            if (new File(smPath).exists()) track.put("artworkSmall", smPath);
                        }
                    }
                }
                call.resolve(response);
            }
            catch (IOException | JSONException error) { call.resolve(new JSObject()); }
        });
    }

    @PluginMethod
    public void scan(PluginCall call) {
        executor.execute(() -> {
            try {
                Map<String, Boolean> rules = new HashMap<>();
                JSONArray savedRules = new JSONArray(prefs().getString(KEY_RULES, "[]"));
                for (int i = 0; i < savedRules.length(); i++) {
                    JSONObject rule = savedRules.getJSONObject(i);
                    rules.put(rule.getString("key"), rule.getBoolean("selected"));
                }
                Map<String, Node> nodes = new LinkedHashMap<>();
                List<FileRow> files = new ArrayList<>();
                folderCovers.clear();
                folderLyrics.clear();
                collect(nodes, files, rules);
                Map<String, Boolean> folderSelected = new HashMap<>();
                Set<String> seen = new HashSet<>();
                List<JSObject> rows = new ArrayList<>();
                List<JSONObject> metas = new ArrayList<>();
                List<Integer> unread = new ArrayList<>();
                List<Uri> unreadUris = new ArrayList<>();
                JSONObject cache = readCache();
                JSONObject nextCache = new JSONObject();
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
                    // A "<same name>.lrc" next to the file holds its lyrics, as on the desktop.
                    FileRow lyrics = folderLyrics.get(file.folderKey + "/" + baseName(file.name));
                    if (lyrics != null) row.put("lyricsUri", DocumentsContract.buildDocumentUriUsingTree(lyrics.tree, lyrics.documentId).toString());
                    JSONObject meta = cache.optJSONObject(key);
                    if (meta == null || meta.optInt("v") != METADATA_VERSION || meta.optLong("size", -1) != orMinus(file.size) || meta.optLong("modified", -1) != orMinus(file.modified)) {
                        meta = new JSONObject();
                        meta.put("v", METADATA_VERSION); meta.put("size", orMinus(file.size)); meta.put("modified", orMinus(file.modified));
                        unread.add(rows.size()); unreadUris.add(uri);
                    }
                    nextCache.put(key, meta);
                    rows.add(row); metas.add(meta);
                }
                readAll(unread, unreadUris, metas, rows.size() - unread.size());
                JSONArray tracks = new JSONArray();
                for (int i = 0; i < rows.size(); i++) {
                    JSObject row = rows.get(i); JSONObject meta = metas.get(i);
                    for (String field : METADATA_FIELDS) if (meta.has(field)) row.put(field, meta.get(field));
                    String art = meta.has("art") ? meta.getString("art") : folderCover(row.getString("folderKey"));
                    if (art != null) {
                        row.put("artwork", artworkFile(art, ARTWORK_SIZE).getAbsolutePath());
                        File med = artworkFile(art, ARTWORK_MEDIUM_SIZE);
                        if (med.exists()) row.put("artworkMedium", med.getAbsolutePath());
                        File sm = artworkFile(art, ARTWORK_SMALL_SIZE);
                        if (sm.exists()) row.put("artworkSmall", sm.getAbsolutePath());
                    }
                    tracks.put(row);
                }
                writeCache(nextCache);
                JSObject response = new JSObject();
                response.put("tracks", tracks); response.put("folders", foldersJson(nodes)); response.put("grants", grantsJson());
                writeFile(LAST_SCAN_FILE, response.toString());
                call.resolve(response);
            } catch (SecurityException error) {
                call.reject("FOLDER_PERMISSION_REVOKED", "FOLDER_PERMISSION_REVOKED", error);
            } catch (Exception error) { call.reject("Folder scan failed", error); }
        });
    }

    /**
     * Walks every granted tree. With files == null only folders are collected (no scan). With rules, a scan
     * skips folders that are neither ticked nor above a ticked folder.
     */
    private void collect(Map<String, Node> nodes, List<FileRow> files, Map<String, Boolean> rules) throws JSONException {
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
            if (!available || skip(tree, rootKey, nodes, rules) || !walked.add(rootKey)) continue;
            try { walk(tree, rootId, rootKey, nodes, files, walked, rules); }
            catch (RuntimeException error) {
                // A granted tree can still vanish, e.g. an ejected SD card. Listing marks it; scanning refuses.
                if (files != null) throw new SecurityException("FOLDER_PERMISSION_REVOKED: " + tree, error);
                nodes.get(rootKey).available = false;
            }
        }
    }

    private void walk(Uri tree, String parentId, String parentKey, Map<String, Node> nodes, List<FileRow> files, Set<String> walked, Map<String, Boolean> rules) {
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
                    if (!skip(tree, key, nodes, rules) && walked.add(key)) walk(tree, documentId, key, nodes, files, walked, rules);
                    continue;
                }
                if (files != null && name != null && FOLDER_COVERS.contains(name.toLowerCase(java.util.Locale.ROOT))) {
                    FileRow cover = new FileRow();
                    cover.tree = tree; cover.documentId = documentId; cover.name = name; cover.folderKey = parentKey;
                    cover.modified = cursor.isNull(4) ? null : cursor.getLong(4);
                    folderCovers.putIfAbsent(parentKey, cover);
                    continue;
                }
                if (files != null && name != null && name.toLowerCase(java.util.Locale.ROOT).endsWith(".lrc")) {
                    FileRow lyrics = new FileRow();
                    lyrics.tree = tree; lyrics.documentId = documentId; lyrics.name = name; lyrics.folderKey = parentKey;
                    folderLyrics.putIfAbsent(parentKey + "/" + baseName(name), lyrics);
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

    /**
     * Tag reads cost ~90 ms per file over SAF, so unchanged files (same size and modified time)
     * reuse the last result. Rewritten after every scan, so removed files drop out.
     * ponytail: one JSON file read whole; move to SQLite if libraries reach tens of thousands of tracks.
     */
    private JSONObject readCache() {
        AtomicFile file = new AtomicFile(new File(getContext().getFilesDir(), CACHE_FILE));
        try { return new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)); }
        catch (IOException | JSONException error) { return new JSONObject(); }
    }

    private void writeCache(JSONObject cache) { writeFile(CACHE_FILE, cache.toString()); }

    private void writeFile(String name, String text) {
        AtomicFile file = new AtomicFile(new File(getContext().getFilesDir(), name));
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(text.getBytes(StandardCharsets.UTF_8));
            file.finishWrite(output);
        } catch (IOException error) {
            // Both files only save time: the next scan reads the tags again, the next start waits for a scan.
            if (output != null) file.failWrite(output);
        }
    }

    private static long orMinus(Long value) { return value == null ? -1 : value; }

    /** Path-like document IDs ("3066-6139:Music/VN") let a scan tell whether a ticked folder lies below. */
    private boolean skip(Uri tree, String key, Map<String, Node> nodes, Map<String, Boolean> rules) {
        if (rules == null || !PATH_DOCUMENTS.equals(tree.getAuthority()) || isSelected(key, nodes, rules)) return false;
        // A volume root ("3066-6139:") is followed directly by its children ("3066-6139:Music").
        String below = key.endsWith(":") ? key : key + "/";
        for (Map.Entry<String, Boolean> rule : rules.entrySet()) if (rule.getValue() && rule.getKey().startsWith(below)) return false;
        return true;
    }

    /** Reads tags for the rows at the given indexes on a few threads, reporting progress every 25 tracks. */
    private void readAll(List<Integer> indexes, List<Uri> uris, List<JSONObject> metas, int alreadyRead) throws Exception {
        AtomicInteger done = new AtomicInteger(alreadyRead);
        ExecutorService readers = Executors.newFixedThreadPool(READ_THREADS);
        try {
            List<Future<?>> reads = new ArrayList<>();
            for (int i = 0; i < indexes.size(); i++) {
                JSONObject meta = metas.get(indexes.get(i)); Uri uri = uris.get(i);
                reads.add(readers.submit(() -> {
                    try { readMetadata(uri, meta); } catch (JSONException ignored) { /* Listed with its file name. */ }
                    int count = done.incrementAndGet();
                    if (count % 25 == 0) {
                        JSObject progress = new JSObject(); progress.put("tracks", count);
                        notifyListeners("scanProgress", progress);
                    }
                }));
            }
            for (Future<?> read : reads) read.get();
        } finally { readers.shutdown(); }
    }

    private JSONArray foldersJson(Map<String, Node> nodes) {
        JSONArray folders = new JSONArray();
        for (Node node : nodes.values()) {
            JSObject row = new JSObject();
            row.put("key", node.key); row.put("name", node.name); row.put("parentKey", node.parentKey);
            row.put("treeUri", node.treeUri); row.put("documentId", node.documentId); row.put("available", node.available);
            folders.put(row);
        }
        return folders;
    }

    private JSONArray grantsJson() throws JSONException {
        JSONArray grants = new JSONArray();
        JSONArray saved = savedUris();
        for (int i = 0; i < saved.length(); i++) {
            Uri tree = Uri.parse(saved.getString(i));
            String rootId = DocumentsContract.getTreeDocumentId(tree);
            JSObject grant = new JSObject();
            grant.put("treeUri", tree.toString()); grant.put("key", keyOf(tree.getAuthority(), rootId));
            grant.put("volumeLabel", volumeLabel(rootId));
            grants.put(grant);
        }
        return grants;
    }

    /** "primary:Music" or "3066-6139:Music" names its volume before the colon; the system describes it ("SanDisk SD card"). */
    private String volumeLabel(String documentId) {
        int colon = documentId.indexOf(':');
        String uuid = colon < 0 ? documentId : documentId.substring(0, colon);
        StorageManager storage = (StorageManager) getContext().getSystemService(android.content.Context.STORAGE_SERVICE);
        for (StorageVolume volume : storage.getStorageVolumes()) {
            if ("primary".equals(uuid) ? volume.isPrimary() : uuid.equalsIgnoreCase(volume.getUuid())) return volume.getDescription(getContext());
        }
        return uuid;
    }

    /** A folder's cover.jpg (or similar), scaled once and named by its key and modified time so a rescan reuses it. */
    private String folderCover(String folderKey) {
        FileRow cover = folderKey == null ? null : folderCovers.get(folderKey);
        if (cover == null) return null;
        Uri uri = DocumentsContract.buildDocumentUriUsingTree(cover.tree, cover.documentId);
        return saveArtwork(hash((keyOf(cover.tree.getAuthority(), cover.documentId) + "@" + cover.modified).getBytes(StandardCharsets.UTF_8)),
            () -> getContext().getContentResolver().openInputStream(uri));
    }

    private interface ImageSource { InputStream open() throws IOException; }

    /**
     * Writes the image as files/artwork/<name>-<size>.jpg in 1024, 512, and 256 sizes.
     * Returns the name, or null when the image cannot be decoded.
     * ponytail: covers no longer used stay on disk; prune the folder if it grows large.
     */
    private String saveArtwork(String name, ImageSource source) {
        File target1024 = artworkFile(name, ARTWORK_SIZE);
        File target512 = artworkFile(name, ARTWORK_MEDIUM_SIZE);
        File target256 = artworkFile(name, ARTWORK_SMALL_SIZE);
        if (target1024.exists() && target512.exists() && target256.exists()) return name;
        try {
            if (target1024.exists()) {
                Bitmap bitmap = BitmapFactory.decodeFile(target1024.getAbsolutePath());
                if (bitmap != null) {
                    if (!target512.exists()) saveScaled(bitmap, target512, ARTWORK_MEDIUM_SIZE);
                    if (!target256.exists()) saveScaled(bitmap, target256, ARTWORK_SMALL_SIZE);
                    bitmap.recycle();
                }
                return name;
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = source.open()) { BitmapFactory.decodeStream(in, null, bounds); }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            BitmapFactory.Options options = new BitmapFactory.Options();
            int longer = Math.max(bounds.outWidth, bounds.outHeight);
            options.inSampleSize = 1;
            while (longer / (options.inSampleSize * 2) >= ARTWORK_SIZE) options.inSampleSize *= 2;
            Bitmap bitmap;
            try (InputStream in = source.open()) { bitmap = BitmapFactory.decodeStream(in, null, options); }
            if (bitmap == null) return null;
            File parent = target1024.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) return null;
            saveScaled(bitmap, target1024, ARTWORK_SIZE);
            saveScaled(bitmap, target512, ARTWORK_MEDIUM_SIZE);
            saveScaled(bitmap, target256, ARTWORK_SMALL_SIZE);
            bitmap.recycle();
            return target1024.exists() ? name : null;
        } catch (IOException | RuntimeException error) {
            return null;
        }
    }

    private void saveScaled(Bitmap source, File target, int maxSize) {
        try {
            float scale = Math.min(1f, (float) maxSize / Math.max(source.getWidth(), source.getHeight()));
            Bitmap sized = scale < 1f ? Bitmap.createScaledBitmap(source, Math.round(source.getWidth() * scale), Math.round(source.getHeight() * scale), true) : source;
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs() && !parent.exists()) return;
            File temp = new File(parent, target.getName() + "." + Thread.currentThread().getId() + ".tmp");
            try (FileOutputStream out = new FileOutputStream(temp)) { sized.compress(Bitmap.CompressFormat.JPEG, 85, out); }
            if (sized != source) sized.recycle();
            if (!temp.renameTo(target)) temp.delete();
        } catch (IOException | RuntimeException ignored) {}
    }

    private void generateMissingThumbnails() {
        executor.execute(() -> {
            try {
                File dir = new File(getContext().getFilesDir(), ARTWORK_DIR);
                File[] files = dir.listFiles((d, name) -> name.endsWith("-" + ARTWORK_SIZE + ".jpg"));
                if (files == null) return;
                for (File file : files) {
                    String base = file.getName().substring(0, file.getName().length() - ("-" + ARTWORK_SIZE + ".jpg").length());
                    File target512 = artworkFile(base, ARTWORK_MEDIUM_SIZE);
                    File target256 = artworkFile(base, ARTWORK_SMALL_SIZE);
                    if (target512.exists() && target256.exists()) continue;
                    Bitmap bitmap = BitmapFactory.decodeFile(file.getAbsolutePath());
                    if (bitmap == null) continue;
                    if (!target512.exists()) saveScaled(bitmap, target512, ARTWORK_MEDIUM_SIZE);
                    if (!target256.exists()) saveScaled(bitmap, target256, ARTWORK_SMALL_SIZE);
                    bitmap.recycle();
                }
            } catch (Exception ignored) {}
        });
    }

    private File artworkFile(String name) {
        return artworkFile(name, ARTWORK_SIZE);
    }

    private File artworkFile(String name, int size) {
        return new File(new File(getContext().getFilesDir(), ARTWORK_DIR), name + "-" + size + ".jpg");
    }

    private static String hash(byte[] bytes) {
        try {
            StringBuilder hex = new StringBuilder();
            for (byte b : MessageDigest.getInstance("SHA-1").digest(bytes)) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            return Integer.toHexString(java.util.Arrays.hashCode(bytes));
        }
    }

    private static String keyOf(String authority, String documentId) {
        return authority.length() + ":" + authority + documentId;
    }

    private void readMetadata(Uri uri, JSONObject row) throws JSONException {
        MediaMetadataRetriever reader = new MediaMetadataRetriever();
        try {
            reader.setDataSource(getContext(), uri);
            row.put("title", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_TITLE));
            // With several ARTIST tags Android returns only one of them; a FLAC's are read from its Vorbis comment.
            String artists = null;
            try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
                if (stream != null) artists = FlacArtists.read(stream);
            } catch (IOException ignored) { }
            row.put("artist", artists != null ? artists : reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST));
            row.put("albumArtist", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUMARTIST));
            row.put("album", reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ALBUM));
            row.put("durationMs", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)));
            row.put("trackNumber", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_CD_TRACK_NUMBER)));
            row.put("year", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_YEAR)));
            row.put("bitrate", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITRATE)));
            byte[] picture = reader.getEmbeddedPicture();
            if (picture != null) row.put("art", saveArtwork(hash(picture), () -> new java.io.ByteArrayInputStream(picture)));
            if (android.os.Build.VERSION.SDK_INT >= 31) {
                row.put("sampleRate", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_SAMPLERATE)));
                row.put("bitDepth", number(reader.extractMetadata(MediaMetadataRetriever.METADATA_KEY_BITS_PER_SAMPLE)));
            }
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

    /** "Song.FLAC" → "song": the name lyrics files are matched on. */
    private static String baseName(String name) {
        int dot = name.lastIndexOf('.');
        return (dot > 0 ? name.substring(0, dot) : name).toLowerCase(java.util.Locale.ROOT);
    }

    /**
     * The text of a lyrics file the last scan found (a `lyricsUri`). Only documents inside a granted tree are read, at
     * most 1 MB, decoded as UTF-8 or, with a byte-order mark, UTF-16 (as the desktop's LyricsService does).
     */
    @PluginMethod
    public void readLyrics(PluginCall call) {
        String value = call.getString("uri");
        // Not behind a scan, which can take a minute the first time.
        treeExecutor.execute(() -> {
            try {
                Uri uri = Uri.parse(value == null ? "" : value);
                if (!DocumentsContract.isDocumentUri(getContext(), uri) || !insideGrantedTree(uri)) { call.reject("Not a lyrics file in a music folder"); return; }
                byte[] bytes;
                try (InputStream input = getContext().getContentResolver().openInputStream(uri)) {
                    if (input == null) { call.reject("Lyrics file is not readable"); return; }
                    java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
                    byte[] chunk = new byte[16384];
                    for (int read; (read = input.read(chunk)) > 0; ) {
                        buffer.write(chunk, 0, read);
                        if (buffer.size() > MAX_LYRICS_BYTES) { call.reject("Lyrics file is too large"); return; }
                    }
                    bytes = buffer.toByteArray();
                }
                JSObject response = new JSObject();
                response.put("text", decodeLyrics(bytes));
                call.resolve(response);
            } catch (java.io.FileNotFoundException error) {
                call.resolve(new JSObject());
            } catch (Exception error) { call.reject("Lyrics read failed", error); }
        });
    }

    private boolean insideGrantedTree(Uri document) throws JSONException {
        if (!DocumentsContract.isTreeUri(document)) return false;
        String treeId = DocumentsContract.getTreeDocumentId(document);
        JSONArray saved = savedUris();
        for (int i = 0; i < saved.length(); i++) {
            Uri tree = Uri.parse(saved.getString(i));
            if (tree.getAuthority() != null && tree.getAuthority().equals(document.getAuthority())
                && DocumentsContract.getTreeDocumentId(tree).equals(treeId) && hasReadGrant(tree)) return true;
        }
        return false;
    }

    private static String decodeLyrics(byte[] bytes) throws java.nio.charset.CharacterCodingException {
        java.nio.charset.Charset charset = StandardCharsets.UTF_8;
        int skip = 0;
        if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xff && (bytes[1] & 0xff) == 0xfe) { charset = StandardCharsets.UTF_16LE; skip = 2; }
        else if (bytes.length >= 2 && (bytes[0] & 0xff) == 0xfe && (bytes[1] & 0xff) == 0xff) { charset = StandardCharsets.UTF_16BE; skip = 2; }
        else if (bytes.length >= 3 && (bytes[0] & 0xff) == 0xef && (bytes[1] & 0xff) == 0xbb && (bytes[2] & 0xff) == 0xbf) skip = 3;
        return charset.newDecoder()
            .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT)
            .decode(java.nio.ByteBuffer.wrap(bytes, skip, bytes.length - skip)).toString();
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
    protected void handleOnDestroy() { executor.shutdown(); treeExecutor.shutdown(); super.handleOnDestroy(); }
}
