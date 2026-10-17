# Android development status

The Android app lives in `main` beside the desktop app (merged from `android/development`, itself forked from the passed `android/spike` checkpoint `e34254e`). It is not a numbered roadmap phase. The app ID is `com.lutstra.android`; the spike naming was dropped on 2026-10-15. `npm run build:android` builds the main Lutstra app for the phone; `npm run build:android:diagnostics` builds the diagnostic screen (`src/app/android-diagnostics/`) instead. Both write `dist/android` and run `cap sync`; then run `android\gradlew.bat assembleDebug`. See `docs/ANDROID_SPIKE.md` for the toolchain.

## Gate B

Passed on two physical devices: Motorola moto g stylus 5G (2024), Android 15, and Nothing A065, Android 16. The user heard MP3, FLAC, and WAV and confirmed play/pause and track switching through Bluetooth and wired headset controls on both. The native Media3 service owns the playback queue. See `docs/ANDROID_SPIKE.md` for the APK and test details.

## Stage C: library folders and playlists

- A MediaStore bridge can enumerate all indexed audio after `READ_MEDIA_AUDIO` permission. The Motorola scan returned 448 tracks, 129 albums, and 83 artists. This was a technical check, not the chosen library policy.
- The user chose **only selected folders**. `AndroidFolderPlugin` grants trees through the system Storage Access Framework picker and persists each read grant. `listTree` returns every sub-folder of the granted trees; overlapping grants merge into one tree. The user ticks branches in the folder tree (`android-folder-selection.ts`); a rule on a folder applies to its descendants until a deeper rule overrides it. `scan` reads metadata only for audio in ticked branches. Folder and track keys are `<authority length>:<authority><document ID>`.
- Android's `MediaMetadataRetriever` returns only one of several ARTIST tags, so the library groups artists by album artist first, as the desktop library does.
- A tree that cannot be read (revoked grant, ejected SD card) is listed with `available: false`, and `scan` rejects with `FOLDER_PERMISSION_REVOKED` instead of returning a partial or substituted library.
- The Angular `LibraryGateway` adapter maps document IDs/URIs into tracks, albums, artists, folder records, and basic track details. It does not share the Windows database or path based track IDs.
- The Android `PlaylistGateway` adapter stores playlists and entries in an app private SQLite database. Duplicate tracks within a playlist have distinct entry IDs. Entries reference Android document IDs. The native Media3 queue remains independent of Angular state.
- The folder-tree build installed on 2026-09-27 was never committed; its TypeScript was recovered from the APK source map on 2026-10-15 and the native plugin was rewritten to match.

### Device results (Motorola, 2026-10-15)

| Check | Result |
| --- | --- |
| Tick `Music/VN/MCK` on the SD card | 46 tracks (46 audio files on disk; `.lrc` and `cover.jpg` ignored), 2 albums, 1 artist |
| Rescan three times | 46 rows, 46 unique IDs each time |
| Add a copied FLAC, rescan; delete it, rescan | 47, then 46 |
| Eject the SD card | `listTree` marks every node unavailable; `scan` rejects with `FOLDER_PERMISSION_REVOKED` |
| Remount and rescan | One `VN` tree, 46 tracks, 1 artist |
| Playlist create, duplicate entry, reorder, remove entry, rename, app restart | All persisted; test playlist deleted |

The checks were driven through the debug WebView with Chrome DevTools Protocol, which only answers while the app is in the foreground.

### Re-check after the rename (`com.lutstra.android`, 2026-10-15)

Fresh install, `Music` granted, `Music/VN/MCK` ticked: 65 folders listed, 46 tracks and 1 artist on five rescans with identical IDs, a copied FLAC added then removed (47, then 46), unticking `HVL` left the 16 tracks of `99%`, and the selection and a test playlist survived a force-stop. Listing the tree takes about 0.9 s; a scan takes 4–6 s because metadata is read at roughly 90 ms per file on every scan. Metadata is now cached in the app's `files/library-metadata.json` by document key, size and last-modified time, and rewritten after every scan so removed files drop out: a rescan of the 46 tracks went from about 3.8 s to 1.1 s with identical results, and a file replaced in place was read again.

## Library playback (start of stage D)

`AndroidPlayback.playQueue({ items, startIndex })` replaces the Media3 service queue with library document URIs and their title, artist and album. The diagnostic screen's **Phát thư viện đã quét** button queues the scanned library album by album in disc/track order (`libraryQueue`). On the Motorola the 46 MCK tracks played from the SD card through the tree grant; next, seek and previous worked; the media notification and foreground service appeared; playback kept going on the home screen and the play/pause media key paused it there. The notification shows the track's own ARTIST tag (one of several, see above). The diagnostic screen keeps this button for raw Media3 checks.

## Main app on Android (stage D)

`npm run build:android` ships the regular Angular app. On Android, `app.config.ts` provides the Android library and playlist gateways, `AndroidPlaybackEngine` (`src/app/core/android/android-playback.engine.ts`) and `AndroidSettingsGateway`, which keeps settings and the playback session in the WebView's localStorage (app-private data) and starts with crossfade off. The listening history is stored by `AndroidHistoryPlugin` in `lutstra-history.db` (app-private SQLite) with the desktop's `play_events` table, checks and queries, through `AndroidListeningHistoryGateway`. On the Motorola (2026-10-17) a listen recorded through the plugin was still there after a force-stop and relaunch, an invalid one (negative seconds) was rejected, and the open listen left by the previous build was recorded as `app_closed` on the first launch. Lyrics, artist metadata and popularity still use the browser mocks.

### Choosing folders

Every "Add folder" entry point on Android (Settings' **Choose folders**, onboarding and the empty states) calls `selectAndAddMusicFolders()`, which opens `app-android-folder-picker` (`shared/components/android-folder-picker`) through `openFolderPicker()` in `android-folder-selection.ts`; the app root renders it while `folderPickerRequest` is set. Modelled on Poweramp's **Thư mục nhạc** dialog: the tree of granted folders with tri-state ticks, each grant labelled with its volume (`listTree` returns `grants` with `StorageVolume.getDescription`, e.g. "Thẻ SD SanDisk"), **Add folder or storage** (system picker; the new grant is ticked in the draft), **Save & scan** and **Cancel**. Ticks are a draft until Save & scan. The ✕ on a granted folder calls `releaseGrant` at once (releases the persisted permission and drops the URI; its rules stay saved), so closing the dialog afterwards still rescans. Folder records use a readable path (`readablePath`: "Thẻ SD SanDisk/Music/VN/MCK") instead of the document URI. The diagnostic screen uses the same dialog.

On the Motorola (2026-10-16): Cancel left the saved rules unchanged; ticking `Music` and Save & scan replaced the `MCK` and `US-UK` rules with one `Music` rule and scanned 459 tracks; releasing the nested `Music/US-UK` grant left one grant, kept US-UK in the tree under `Music` and 459 tracks. The original selection was restored afterwards. The Android back button closes it through the phone shell (below).

### Scans while the app is in use

`listTree` runs on its own thread, so the folder picker opens while a long scan is running (it used to queue behind the scan, and the picker sat on a disabled Cancel until the scan ended). `scan` emits `scanProgress` every 25 tracks, which the gateway passes on as `scanProgress# Android development status

The Android app lives in `main` beside the desktop app (merged from `android/development`, itself forked from the passed `android/spike` checkpoint `e34254e`). It is not a numbered roadmap phase. The app ID is `com.lutstra.android`; the spike naming was dropped on 2026-10-15. `npm run build:android` builds the main Lutstra app for the phone; `npm run build:android:diagnostics` builds the diagnostic screen (`src/app/android-diagnostics/`) instead. Both write `dist/android` and run `cap sync`; then run `android\gradlew.bat assembleDebug`. See `docs/ANDROID_SPIKE.md` for the toolchain.

## Gate B

Passed on two physical devices: Motorola moto g stylus 5G (2024), Android 15, and Nothing A065, Android 16. The user heard MP3, FLAC, and WAV and confirmed play/pause and track switching through Bluetooth and wired headset controls on both. The native Media3 service owns the playback queue. See `docs/ANDROID_SPIKE.md` for the APK and test details.

## Stage C: library folders and playlists

- A MediaStore bridge can enumerate all indexed audio after `READ_MEDIA_AUDIO` permission. The Motorola scan returned 448 tracks, 129 albums, and 83 artists. This was a technical check, not the chosen library policy.
- The user chose **only selected folders**. `AndroidFolderPlugin` grants trees through the system Storage Access Framework picker and persists each read grant. `listTree` returns every sub-folder of the granted trees; overlapping grants merge into one tree. The user ticks branches in the folder tree (`android-folder-selection.ts`); a rule on a folder applies to its descendants until a deeper rule overrides it. `scan` reads metadata only for audio in ticked branches. Folder and track keys are `<authority length>:<authority><document ID>`.
- Android's `MediaMetadataRetriever` returns only one of several ARTIST tags, so the library groups artists by album artist first, as the desktop library does.
- A tree that cannot be read (revoked grant, ejected SD card) is listed with `available: false`, and `scan` rejects with `FOLDER_PERMISSION_REVOKED` instead of returning a partial or substituted library.
- The Angular `LibraryGateway` adapter maps document IDs/URIs into tracks, albums, artists, folder records, and basic track details. It does not share the Windows database or path based track IDs.
- The Android `PlaylistGateway` adapter stores playlists and entries in an app private SQLite database. Duplicate tracks within a playlist have distinct entry IDs. Entries reference Android document IDs. The native Media3 queue remains independent of Angular state.
- The folder-tree build installed on 2026-09-27 was never committed; its TypeScript was recovered from the APK source map on 2026-10-15 and the native plugin was rewritten to match.

### Device results (Motorola, 2026-10-15)

| Check | Result |
| --- | --- |
| Tick `Music/VN/MCK` on the SD card | 46 tracks (46 audio files on disk; `.lrc` and `cover.jpg` ignored), 2 albums, 1 artist |
| Rescan three times | 46 rows, 46 unique IDs each time |
| Add a copied FLAC, rescan; delete it, rescan | 47, then 46 |
| Eject the SD card | `listTree` marks every node unavailable; `scan` rejects with `FOLDER_PERMISSION_REVOKED` |
| Remount and rescan | One `VN` tree, 46 tracks, 1 artist |
| Playlist create, duplicate entry, reorder, remove entry, rename, app restart | All persisted; test playlist deleted |

The checks were driven through the debug WebView with Chrome DevTools Protocol, which only answers while the app is in the foreground.

### Re-check after the rename (`com.lutstra.android`, 2026-10-15)

Fresh install, `Music` granted, `Music/VN/MCK` ticked: 65 folders listed, 46 tracks and 1 artist on five rescans with identical IDs, a copied FLAC added then removed (47, then 46), unticking `HVL` left the 16 tracks of `99%`, and the selection and a test playlist survived a force-stop. Listing the tree takes about 0.9 s; a scan takes 4–6 s because metadata is read at roughly 90 ms per file on every scan. Metadata is now cached in the app's `files/library-metadata.json` by document key, size and last-modified time, and rewritten after every scan so removed files drop out: a rescan of the 46 tracks went from about 3.8 s to 1.1 s with identical results, and a file replaced in place was read again.

## Library playback (start of stage D)

`AndroidPlayback.playQueue({ items, startIndex })` replaces the Media3 service queue with library document URIs and their title, artist and album. The diagnostic screen's **Phát thư viện đã quét** button queues the scanned library album by album in disc/track order (`libraryQueue`). On the Motorola the 46 MCK tracks played from the SD card through the tree grant; next, seek and previous worked; the media notification and foreground service appeared; playback kept going on the home screen and the play/pause media key paused it there. The notification shows the track's own ARTIST tag (one of several, see above). The diagnostic screen keeps this button for raw Media3 checks.

## Main app on Android (stage D)

`npm run build:android` ships the regular Angular app. On Android, `app.config.ts` provides the Android library and playlist gateways, `AndroidPlaybackEngine` (`src/app/core/android/android-playback.engine.ts`) and `AndroidSettingsGateway`, which keeps settings and the playback session in the WebView's localStorage (app-private data) and starts with crossfade off. Lyrics, artist metadata and popularity still use the browser mocks.

### Choosing folders

Every "Add folder" entry point on Android (Settings' **Choose folders**, onboarding and the empty states) calls `selectAndAddMusicFolders()`, which opens `app-android-folder-picker` (`shared/components/android-folder-picker`) through `openFolderPicker()` in `android-folder-selection.ts`; the app root renders it while `folderPickerRequest` is set. Modelled on Poweramp's **Thư mục nhạc** dialog: the tree of granted folders with tri-state ticks, each grant labelled with its volume (`listTree` returns `grants` with `StorageVolume.getDescription`, e.g. "Thẻ SD SanDisk"), **Add folder or storage** (system picker; the new grant is ticked in the draft), **Save & scan** and **Cancel**. Ticks are a draft until Save & scan. The ✕ on a granted folder calls `releaseGrant` at once (releases the persisted permission and drops the URI; its rules stay saved), so closing the dialog afterwards still rescans. Folder records use a readable path (`readablePath`: "Thẻ SD SanDisk/Music/VN/MCK") instead of the document URI. The diagnostic screen uses the same dialog.

On the Motorola (2026-10-16): Cancel left the saved rules unchanged; ticking `Music` and Save & scan replaced the `MCK` and `US-UK` rules with one `Music` rule and scanned 459 tracks; releasing the nested `Music/US-UK` grant left one grant, kept US-UK in the tree under `Music` and 459 tracks. The original selection was restored afterwards. The Android back button does not close the dialog yet (no `@capacitor/app`).

 (the "Scanning · 125" banner). `AndroidLibraryGateway.requestScan()` queues one more pass when called during a scan, so a selection saved mid-scan is scanned instead of dropped; `getLibrary()` callers that arrive before the first scan finishes wait for that pass instead of getting an empty library (`tests/android-library-scan.spec.mts`). On the Motorola, a cold scan of `Music` (459 tracks, metadata cache deleted) took 47 s; the picker listed its folders 1.0 s after opening mid-scan, the longest frame gap was 67 ms, and Settings showed the new folder when it finished.

### Scan speed

- **Start-up:** each scan also writes its result to `files/last-scan.json` (tracks, visited folders, grants). On start, `getLibrary()` shows that result (`getLastScan`, 84 ms for 459 tracks) and rescans in the background; `libraryChanged# Android development status

The Android app lives in `main` beside the desktop app (merged from `android/development`, itself forked from the passed `android/spike` checkpoint `e34254e`). It is not a numbered roadmap phase. The app ID is `com.lutstra.android`; the spike naming was dropped on 2026-10-15. `npm run build:android` builds the main Lutstra app for the phone; `npm run build:android:diagnostics` builds the diagnostic screen (`src/app/android-diagnostics/`) instead. Both write `dist/android` and run `cap sync`; then run `android\gradlew.bat assembleDebug`. See `docs/ANDROID_SPIKE.md` for the toolchain.

## Gate B

Passed on two physical devices: Motorola moto g stylus 5G (2024), Android 15, and Nothing A065, Android 16. The user heard MP3, FLAC, and WAV and confirmed play/pause and track switching through Bluetooth and wired headset controls on both. The native Media3 service owns the playback queue. See `docs/ANDROID_SPIKE.md` for the APK and test details.

## Stage C: library folders and playlists

- A MediaStore bridge can enumerate all indexed audio after `READ_MEDIA_AUDIO` permission. The Motorola scan returned 448 tracks, 129 albums, and 83 artists. This was a technical check, not the chosen library policy.
- The user chose **only selected folders**. `AndroidFolderPlugin` grants trees through the system Storage Access Framework picker and persists each read grant. `listTree` returns every sub-folder of the granted trees; overlapping grants merge into one tree. The user ticks branches in the folder tree (`android-folder-selection.ts`); a rule on a folder applies to its descendants until a deeper rule overrides it. `scan` reads metadata only for audio in ticked branches. Folder and track keys are `<authority length>:<authority><document ID>`.
- Android's `MediaMetadataRetriever` returns only one of several ARTIST tags, so the library groups artists by album artist first, as the desktop library does.
- A tree that cannot be read (revoked grant, ejected SD card) is listed with `available: false`, and `scan` rejects with `FOLDER_PERMISSION_REVOKED` instead of returning a partial or substituted library.
- The Angular `LibraryGateway` adapter maps document IDs/URIs into tracks, albums, artists, folder records, and basic track details. It does not share the Windows database or path based track IDs.
- The Android `PlaylistGateway` adapter stores playlists and entries in an app private SQLite database. Duplicate tracks within a playlist have distinct entry IDs. Entries reference Android document IDs. The native Media3 queue remains independent of Angular state.
- The folder-tree build installed on 2026-09-27 was never committed; its TypeScript was recovered from the APK source map on 2026-10-15 and the native plugin was rewritten to match.

### Device results (Motorola, 2026-10-15)

| Check | Result |
| --- | --- |
| Tick `Music/VN/MCK` on the SD card | 46 tracks (46 audio files on disk; `.lrc` and `cover.jpg` ignored), 2 albums, 1 artist |
| Rescan three times | 46 rows, 46 unique IDs each time |
| Add a copied FLAC, rescan; delete it, rescan | 47, then 46 |
| Eject the SD card | `listTree` marks every node unavailable; `scan` rejects with `FOLDER_PERMISSION_REVOKED` |
| Remount and rescan | One `VN` tree, 46 tracks, 1 artist |
| Playlist create, duplicate entry, reorder, remove entry, rename, app restart | All persisted; test playlist deleted |

The checks were driven through the debug WebView with Chrome DevTools Protocol, which only answers while the app is in the foreground.

### Re-check after the rename (`com.lutstra.android`, 2026-10-15)

Fresh install, `Music` granted, `Music/VN/MCK` ticked: 65 folders listed, 46 tracks and 1 artist on five rescans with identical IDs, a copied FLAC added then removed (47, then 46), unticking `HVL` left the 16 tracks of `99%`, and the selection and a test playlist survived a force-stop. Listing the tree takes about 0.9 s; a scan takes 4–6 s because metadata is read at roughly 90 ms per file on every scan. Metadata is now cached in the app's `files/library-metadata.json` by document key, size and last-modified time, and rewritten after every scan so removed files drop out: a rescan of the 46 tracks went from about 3.8 s to 1.1 s with identical results, and a file replaced in place was read again.

## Library playback (start of stage D)

`AndroidPlayback.playQueue({ items, startIndex })` replaces the Media3 service queue with library document URIs and their title, artist and album. The diagnostic screen's **Phát thư viện đã quét** button queues the scanned library album by album in disc/track order (`libraryQueue`). On the Motorola the 46 MCK tracks played from the SD card through the tree grant; next, seek and previous worked; the media notification and foreground service appeared; playback kept going on the home screen and the play/pause media key paused it there. The notification shows the track's own ARTIST tag (one of several, see above). The diagnostic screen keeps this button for raw Media3 checks.

## Main app on Android (stage D)

`npm run build:android` ships the regular Angular app. On Android, `app.config.ts` provides the Android library and playlist gateways, `AndroidPlaybackEngine` (`src/app/core/android/android-playback.engine.ts`) and `AndroidSettingsGateway`, which keeps settings and the playback session in the WebView's localStorage (app-private data) and starts with crossfade off. Lyrics, artist metadata and popularity still use the browser mocks.

### Choosing folders

Every "Add folder" entry point on Android (Settings' **Choose folders**, onboarding and the empty states) calls `selectAndAddMusicFolders()`, which opens `app-android-folder-picker` (`shared/components/android-folder-picker`) through `openFolderPicker()` in `android-folder-selection.ts`; the app root renders it while `folderPickerRequest` is set. Modelled on Poweramp's **Thư mục nhạc** dialog: the tree of granted folders with tri-state ticks, each grant labelled with its volume (`listTree` returns `grants` with `StorageVolume.getDescription`, e.g. "Thẻ SD SanDisk"), **Add folder or storage** (system picker; the new grant is ticked in the draft), **Save & scan** and **Cancel**. Ticks are a draft until Save & scan. The ✕ on a granted folder calls `releaseGrant` at once (releases the persisted permission and drops the URI; its rules stay saved), so closing the dialog afterwards still rescans. Folder records use a readable path (`readablePath`: "Thẻ SD SanDisk/Music/VN/MCK") instead of the document URI. The diagnostic screen uses the same dialog.

On the Motorola (2026-10-16): Cancel left the saved rules unchanged; ticking `Music` and Save & scan replaced the `MCK` and `US-UK` rules with one `Music` rule and scanned 459 tracks; releasing the nested `Music/US-UK` grant left one grant, kept US-UK in the tree under `Music` and 459 tracks. The original selection was restored afterwards. The Android back button does not close the dialog yet (no `@capacitor/app`).

### Scans while the app is in use

`listTree` runs on its own thread, so the folder picker opens while a long scan is running (it used to queue behind the scan, and the picker sat on a disabled Cancel until the scan ended). `scan` emits `scanProgress` every 25 tracks, which the gateway passes on as `scanProgress# Android development status

The Android app lives in `main` beside the desktop app (merged from `android/development`, itself forked from the passed `android/spike` checkpoint `e34254e`). It is not a numbered roadmap phase. The app ID is `com.lutstra.android`; the spike naming was dropped on 2026-10-15. `npm run build:android` builds the main Lutstra app for the phone; `npm run build:android:diagnostics` builds the diagnostic screen (`src/app/android-diagnostics/`) instead. Both write `dist/android` and run `cap sync`; then run `android\gradlew.bat assembleDebug`. See `docs/ANDROID_SPIKE.md` for the toolchain.

## Gate B

Passed on two physical devices: Motorola moto g stylus 5G (2024), Android 15, and Nothing A065, Android 16. The user heard MP3, FLAC, and WAV and confirmed play/pause and track switching through Bluetooth and wired headset controls on both. The native Media3 service owns the playback queue. See `docs/ANDROID_SPIKE.md` for the APK and test details.

## Stage C: library folders and playlists

- A MediaStore bridge can enumerate all indexed audio after `READ_MEDIA_AUDIO` permission. The Motorola scan returned 448 tracks, 129 albums, and 83 artists. This was a technical check, not the chosen library policy.
- The user chose **only selected folders**. `AndroidFolderPlugin` grants trees through the system Storage Access Framework picker and persists each read grant. `listTree` returns every sub-folder of the granted trees; overlapping grants merge into one tree. The user ticks branches in the folder tree (`android-folder-selection.ts`); a rule on a folder applies to its descendants until a deeper rule overrides it. `scan` reads metadata only for audio in ticked branches. Folder and track keys are `<authority length>:<authority><document ID>`.
- Android's `MediaMetadataRetriever` returns only one of several ARTIST tags, so the library groups artists by album artist first, as the desktop library does.
- A tree that cannot be read (revoked grant, ejected SD card) is listed with `available: false`, and `scan` rejects with `FOLDER_PERMISSION_REVOKED` instead of returning a partial or substituted library.
- The Angular `LibraryGateway` adapter maps document IDs/URIs into tracks, albums, artists, folder records, and basic track details. It does not share the Windows database or path based track IDs.
- The Android `PlaylistGateway` adapter stores playlists and entries in an app private SQLite database. Duplicate tracks within a playlist have distinct entry IDs. Entries reference Android document IDs. The native Media3 queue remains independent of Angular state.
- The folder-tree build installed on 2026-09-27 was never committed; its TypeScript was recovered from the APK source map on 2026-10-15 and the native plugin was rewritten to match.

### Device results (Motorola, 2026-10-15)

| Check | Result |
| --- | --- |
| Tick `Music/VN/MCK` on the SD card | 46 tracks (46 audio files on disk; `.lrc` and `cover.jpg` ignored), 2 albums, 1 artist |
| Rescan three times | 46 rows, 46 unique IDs each time |
| Add a copied FLAC, rescan; delete it, rescan | 47, then 46 |
| Eject the SD card | `listTree` marks every node unavailable; `scan` rejects with `FOLDER_PERMISSION_REVOKED` |
| Remount and rescan | One `VN` tree, 46 tracks, 1 artist |
| Playlist create, duplicate entry, reorder, remove entry, rename, app restart | All persisted; test playlist deleted |

The checks were driven through the debug WebView with Chrome DevTools Protocol, which only answers while the app is in the foreground.

### Re-check after the rename (`com.lutstra.android`, 2026-10-15)

Fresh install, `Music` granted, `Music/VN/MCK` ticked: 65 folders listed, 46 tracks and 1 artist on five rescans with identical IDs, a copied FLAC added then removed (47, then 46), unticking `HVL` left the 16 tracks of `99%`, and the selection and a test playlist survived a force-stop. Listing the tree takes about 0.9 s; a scan takes 4–6 s because metadata is read at roughly 90 ms per file on every scan. Metadata is now cached in the app's `files/library-metadata.json` by document key, size and last-modified time, and rewritten after every scan so removed files drop out: a rescan of the 46 tracks went from about 3.8 s to 1.1 s with identical results, and a file replaced in place was read again.

## Library playback (start of stage D)

`AndroidPlayback.playQueue({ items, startIndex })` replaces the Media3 service queue with library document URIs and their title, artist and album. The diagnostic screen's **Phát thư viện đã quét** button queues the scanned library album by album in disc/track order (`libraryQueue`). On the Motorola the 46 MCK tracks played from the SD card through the tree grant; next, seek and previous worked; the media notification and foreground service appeared; playback kept going on the home screen and the play/pause media key paused it there. The notification shows the track's own ARTIST tag (one of several, see above). The diagnostic screen keeps this button for raw Media3 checks.

## Main app on Android (stage D)

`npm run build:android` ships the regular Angular app. On Android, `app.config.ts` provides the Android library and playlist gateways, `AndroidPlaybackEngine` (`src/app/core/android/android-playback.engine.ts`) and `AndroidSettingsGateway`, which keeps settings and the playback session in the WebView's localStorage (app-private data) and starts with crossfade off. Lyrics, artist metadata and popularity still use the browser mocks.

### Choosing folders

Every "Add folder" entry point on Android (Settings' **Choose folders**, onboarding and the empty states) calls `selectAndAddMusicFolders()`, which opens `app-android-folder-picker` (`shared/components/android-folder-picker`) through `openFolderPicker()` in `android-folder-selection.ts`; the app root renders it while `folderPickerRequest` is set. Modelled on Poweramp's **Thư mục nhạc** dialog: the tree of granted folders with tri-state ticks, each grant labelled with its volume (`listTree` returns `grants` with `StorageVolume.getDescription`, e.g. "Thẻ SD SanDisk"), **Add folder or storage** (system picker; the new grant is ticked in the draft), **Save & scan** and **Cancel**. Ticks are a draft until Save & scan. The ✕ on a granted folder calls `releaseGrant` at once (releases the persisted permission and drops the URI; its rules stay saved), so closing the dialog afterwards still rescans. Folder records use a readable path (`readablePath`: "Thẻ SD SanDisk/Music/VN/MCK") instead of the document URI. The diagnostic screen uses the same dialog.

On the Motorola (2026-10-16): Cancel left the saved rules unchanged; ticking `Music` and Save & scan replaced the `MCK` and `US-UK` rules with one `Music` rule and scanned 459 tracks; releasing the nested `Music/US-UK` grant left one grant, kept US-UK in the tree under `Music` and 459 tracks. The original selection was restored afterwards. The Android back button does not close the dialog yet (no `@capacitor/app`).

 (the "Scanning · 125" banner). `AndroidLibraryGateway.requestScan()` queues one more pass when called during a scan, so a selection saved mid-scan is scanned instead of dropped; `getLibrary()` callers that arrive before the first scan finishes wait for that pass instead of getting an empty library (`tests/android-library-scan.spec.mts`). On the Motorola, a cold scan of `Music` (459 tracks, metadata cache deleted) took 47 s; the picker listed its folders 1.0 s after opening mid-scan, the longest frame gap was 67 ms, and Settings showed the new folder when it finished.

 fires only when the rescan finds a different library. Before, every start waited for a full listing and scan (about 1.9 s for 459 tracks).
- **One walk:** `scan` returns the folders it visited and the grants, so the gateway no longer calls `listTree` first. It skips folders that are neither ticked nor above a ticked folder (path-like document IDs of `com.android.externalstorage.documents` only). Warm rescan with `Music` ticked: 1.0 s; with only `Music/VN/MCK` ticked: 108 ms (was about 1.9 s).
- **Tag reads:** files missing from the metadata cache are read on four threads (`READ_THREADS`). A cold scan of 459 tracks went from 47 s to about 30 s; the SD card, not the CPU, is the limit.

The `android` build configuration keeps `inlineCritical` off, as production does: inlined critical CSS loads the full stylesheet through an `onload` handler that the app's Content Security Policy blocks, which left the phone with only the critical dark-theme rules.

- `PlayerService` keeps owning the queue. The engine loads one track into Media3 and appends the next one through `prepareNext`; Media3 continues into it gaplessly and the engine reports `trackAutoAdvanced$`.
- Any Media3 move to a track the engine handed over, including headset and notification next/previous, is reported the same way, so the UI follows remote controls.
- Media3 cannot crossfade. A crossfade request (`transitionTo` with seconds) resolves when Media3 continues gaplessly at the natural end, so `PlayerService` does not cancel and re-prepare the next track in a loop.
- The engine reports no frequency analysis, so the spectrum stays hidden, and it reports the `chromium` backend because `AudioEngineBackend` has no Android member yet.

On the Motorola: Play album started Media3 with the next track prepared; two gapless advances in a row kept the UI in step; headset next and previous moved the UI with Media3; with the app on the home screen Media3 advanced on its own, the WebView prepared the following track, and a media-key next moved into it. Left on the home screen for eight minutes, playback advanced three times on its own, the last one after more than five minutes hidden. After a force-stop the home screen offered "Continue listening" on the last track, and a theme change survived the restart.

## Phone shell (P0)

The Android app no longer runs the desktop shell. `main.ts` boots `PhoneAppComponent` (`src/app/phone/shell`) and `app.config.ts` provides `phoneRoutes` on Android; the services and gateways are the same. See `plan/plans/android-phone-shell.md` for the phases (P0 shell → P4 polish).

- **Mini player** (72 px): after PixelPlayer's, the cover blurred as its ground over the cover's dark tone (a scrim from the left keeps the title readable), the cover, title and artist (no format line; the ⋯ sheet has it), then Previous and Next as round pills in the cover's dark tone and Play as a rounded square in its light tone, as on Now Playing; the progress runs along the bottom edge in the cover's middle tone. Without a cover it is grey. A tap opens Now Playing, and a sideways swipe changes track.
- **Shell:** app bar, page, mini player and a bottom navigation of Home · Search · Library; Settings (the desktop page until P3) opens from the app bar; it belongs to no tab, so the tab it was opened from stays lit (`activeTab`, without `aria-current`). Now Playing is a full-screen sheet over the shell and the queue a bottom sheet over it. P0 pages are minimal: Library lists every track by title to start playback, Home shows the last track, Search is a placeholder.
- **Back:** `MainActivity` registers an `OnBackPressedCallback` that fires the `lutstraback` window event instead of finishing the activity. The shell sends Escape to an open dialog (the folder picker and page dialogs already close on it), else closes the queue sheet, then Now Playing, then goes back a page (a tab goes to Home); at Home it calls `AppShell.moveToBack` (a plugin nested in `MainActivity`), which moves the task back as the system does at a root screen, so playback keeps going. No `@capacitor/app` dependency. The diagnostics build gets the same callback, so Back does nothing there.
- **File quality:** `readMetadata` also stores `bitrate` (all versions) and `sampleRate` and `bitDepth` (`METADATA_KEY_SAMPLERATE` / `BITS_PER_SAMPLE`, Android 12 / API 31 and later). Cache entries carry `v` (`METADATA_VERSION`, now 2), so entries written before these fields are read again once on the next scan. The gateway maps them onto `Track`, so `formatTrackFormat` and the Now Playing chip (`formatTrackQualityLine`, "FLAC 24/96 · 2605 kbps") show real values.
- **Theme:** `ThemeService` sets `data-layout='phone'` on Android; the phone layout tokens live in `_themes.scss`. `AndroidSettingsGateway` starts with the blue accent until the user picks one.

On the Motorola (2026-10-16): the three tabs switched; Library listed 459 tracks with real measurements after the one-time metadata re-read (`FLAC 24/48`, `16/44.1`, Hi-Res in accent); the mini player followed the playing track; Now Playing opened from the mini player, showed `FLAC 24/48 · 2221 kbps` between the times and closed with ⌄ and with Back (focus back on the mini player); the queue sheet opened from Now Playing and Back closed it (focus back on its button); Back closed the folder picker in Settings, then left Settings, went from Search to Home, and at Home moved the app to the background. An install that already saved an accent (this one had rose) keeps it.

## Phone Library (P1)

- **Library** (`phone/pages/library`) has chip tabs Songs · Albums · Artists · Playlists · Folders. The tab is the `?tab=` query parameter (switched with `replaceUrl`), so Back from a detail page returns to it. Each list has Shuffle (the whole library) and a native sort select (`library-sort.ts`; the choice lasts for the session in `PhoneLibraryService`).
- **Detail pages** `library/albums/:id`, `artists/:id`, `playlists/:id` and `folders/:id` share `app-phone-detail-header` (cover, title, prose line, mono measurement line from `collectionMeasure`, ink Play and Shuffle) and `app-phone-track-row`. A folder id is its root's id followed by `/name` per level; Play and Shuffle on a folder take every track below it, and its list shows sub-folders, then its own tracks.
- **⋯ sheet** (`app-phone-track-actions-sheet`): Play next, Add to queue, Add to playlist… (the shared `app-add-to-playlist-dialog`). Both close on Back through the shell's Escape path.
- **Tap feedback:** `_base.scss` turns off the WebView's blue tap highlight under `data-layout='phone'`; phone controls show their own `:active` background instead.
- **Scroll:** the page scrolls inside the shell, so the shell keeps each URL's offset and restores it on Back (popstate) only.

On the Motorola (2026-10-17): the five tabs listed 459 tracks, 64 albums and one folder root; Music → US-UK → DPR IAN → Dear insanity showed 459, 236 and then 7 tracks, and Back walked up to `?tab=folders`; an album opened from 2000px down the grid came back to 2000px; album rows show track numbers; an artist page listed 2 albums and 12 tracks; the ⋯ sheet and the Add to playlist dialog opened and closed on Back (the first Back hides the keyboard). Playback (volume turned down): a Songs row, an album's Play, an artist's Shuffle and a folder's Play each started the expected track; Play next put the track right after the current one and Add to queue put it last; a playlist created from the dialog, with a second track added to it, listed both in order and played. The test playlist was deleted afterwards.

## Phone Home and Search (P2)

- **Home** (`phone/pages/home`), laid out after PixelPlayer's (`plan/reports/android-ui-design-references.md` §9): "Your mix" in display type with one big ink button; a collage of recently played covers (topped up with recently added) cut into circle, pill, tile and blob shapes, each a link to its album, hidden below three covers; the Smart Shuffle card; then Recently played and Recently added album strips. The shell injects `RecentPlaysService` so plays are recorded on the phone too.
- **Mix card ("Up next in your mix"; the feature is named once, in the "Your mix" heading):** while Smart Shuffle plays it lists the current entry and the next four from the queue (the compass star on suggestions; a tap jumps there). Otherwise it shows `SmartShuffleService.previewSuggestions()`, the cold start's picks without touching the queue, with a New picks button; the big button or a row plays them through `playSuggestions(picks)` (from that row on).
- **Loading:** while the library snapshot is null, Home shows a skeleton of its own shapes (hero, covers, mix card) in surface tones with "Loading your library…", instead of a blank page.
- **Search** (`phone/pages/search`): one field over tracks, albums, artists and playlists, ranked by `rankMatches` / `normalizeSearch` (`shared/utils/search-rank.ts`, shared with the desktop global search), so case and Vietnamese accents, `đ` included, are optional. The query is `?q=` (`replaceUrl` per keystroke), so Back from a result returns to the same results. A song result plays that track alone, as on desktop.

On the Motorola (2026-10-17): Home showed the paused track, the Smart Shuffle card and both strips; "cuộc gọi" and "cuoc goi" both found "100 Cuộc Gọi Nhỡ", "duong" found "đường về" and "Slippery (feat. Tùng Dương)", "mck" listed RPT MCK's tracks, two albums and the artist, and "zzqx" said no matches; Back from an album opened from the results kept "hours" and its results; Smart Shuffle (volume turned down) played a suggestion with 11 suggested entries queued. Typing through Gboard's Vietnamese Telex turns "af" into "à", as in any app.

## Phone Settings and Material You (P3)

- **Settings** (`phone/pages/settings`) replaces the desktop page on the phone: music folders (the selected roots, scan status, **Choose folders** to open the folder picker, **Rescan**), Appearance (Dark/Light and the accent), and Listening history (**Clear history** behind an inline confirmation). The history is kept across launches (below).
- **Material You:** `AppShell.getDynamicColors()` (in `MainActivity`) returns the `system_accent1_*` tones on Android 12+ and rejects `UNSUPPORTED` below. The shell reads it at start and whenever the app becomes visible again (a new wallpaper), and hands it to `ThemeService.setDynamicPalette()`. With the `dynamicAccent` setting on, `ThemeService` sets `data-accent='system'` and writes the nine `--color-accent*` tokens inline from `dynamicAccentTokens()` (`core/theme/dynamic-accent.ts`): tones 200/300/400 on dark and 600/700/800 on light, the accent text stepping outwards until it reaches 4.5:1 on the preset's canvas and surfaces (the rule `check-accent-contrast.mjs` applies to the fixed accents), and black or white on the fill, whichever reads better. Picking a fixed accent turns it off. Without a palette the option is hidden and the chosen fixed accent applies. The amber distance check of the fixed accents is not applied to wallpaper colours.
On the Motorola (Android 15, 2026-10-17): Settings listed `Thẻ SD SanDisk/Music` and 459 tracks and offered Wallpaper (a blue palette). Wallpaper gave `#a6c8ff` on Dark (accent text 11:1 on the canvas, 9.8:1 on surfaces, 11:1 on the fill) and `#005eb1` with `#004787` text on Light (8.46:1, 9.33:1, 6.49:1); the choice was saved as `dynamicAccent`. Returning from the home screen read the palette again. Picking Rose cleared the inline tokens and saved `dynamicAccent: false`. Choose folders opened the picker and Back closed it; Clear history asked first and Cancel left it. The wallpaper itself was not changed.
- The six fixed swatches now come from `ACCENT_SWATCHES` (`core/models/settings.model.ts`), shared with the desktop Settings page.

## Edge to edge

`index.html` declares `viewport-fit=cover`. With it (and WebView 140+), Capacitor's `SystemBars` passes the status and navigation bar insets to the page instead of padding the WebView, so the app's own background runs under both bars and the shell keeps its content clear with `env(safe-area-inset-top|bottom)`. Without it the bars sat on the native window background, a grey strip above the app bar. `ThemeService` sets the bar icons with `SystemBars.setStyle` (light icons on Graphite, dark on Cloud).

## Now Playing

Laid out after PixelPlayer's full player (`FullPlayerContent`, `AnimatedPlaybackControls`, `BottomToggleRow`) in Lutstra's palette:
- **Ground:** the current cover blurred (80 px, saturate 1.25, 55 % dark / 42 % light) behind the whole sheet, crossfading over 1.2 s, as the Ambient Ground Rule does on the desktop; removed under reduced transparency or forced colours. Controls sit on translucent tonal surfaces (`color-mix` of `--bg-elevated`).
- **Cover colours:** after PixelPlayer's album scheme, every control here and in the mini player takes its colour from the cover, Play included (the one exception to the Ink Play Rule). `CoverToneService` (`src/app/phone/cover-tone.service.ts`) reads it once per cover for both. `coverTone()` (`src/app/phone/cover-tone.ts`) samples the cover at 64 px, votes colourful pixels into OKLCH hue bins by chroma and returns the strongest bin's hue and chroma, or chroma 0 when under 10 % of the cover has colour. The element sets `--np-hue` and `--np-chroma`, and `.cover-tinted` in `src/styles/_base.scss` builds each role as `oklch()` at a fixed lightness per theme (Play light with dark text, Prev/Next and the tonal buttons dark, modes that are on and the progress in between), so every label keeps 4.5:1. Colours cross-fade over `--np-tint-dur` (1.2 s, with the ground); without a cover the controls stay untinted. The rest of the phone keeps the accent.
- **Bar:** a round collapse button, "Now Playing" and a queue pill.
- **Cover:** `--sheet-radius`, as large as the height allows; it swipes like the mini player (left next, right previous).
- **Heading:** title (800, `--font-size-3xl`) and artist on one line each, with a ⋯ button that opens the track actions sheet.
- **Focus ring:** one rule in `src/styles/_base.scss` (`html[data-layout='phone'] :where(a, button, select, [tabindex]):focus-visible`, 2 px accent, offset 2 px); full-width rows keep their own inset offset.
- **Focus:** opening or closing a sheet (Now Playing, queue, ⋯) moves focus with `focusQuietly()` (`src/app/phone/focus.ts`, `focus({ focusVisible: false })`), so screen readers and keyboards land in the right place while a tap shows no focus ring; the next Tab shows it as usual.
- **Track actions sheet (⋯):** after PixelPlayer's song sheet: the cover, title, artist · album and the format line on top, then tonal pills two by two (an odd last one spans the row; `--phone-sheet-action-height`). From a track list: Play next (the accent pill) and Add to queue (both hidden for the track that is playing), Playlist, Album, Artist. From a queue row (`PhoneLibraryService.openActions(tracks, entry)`) it acts on that entry: Play now (ink, the Ink Play Rule), Play next (moves the entry after the current one; hidden when it is already next), Remove (with Undo, as the swipe), Playlist, Album, Artist; the queue sheet is inert under it. A **File info** row shows bitrate · size and opens **File** (format, bitrate, channels when known, size, the readable part of the document path, in sans since a path is not a measurement) and **Output** (Android mixer, file rate → mixer rate, resampled or not, and a line that the phone is not bit-perfect). Following Album or Artist closes Now Playing and the queue sheet.
- **Timeline:** the seek slider and the times in mono, with one chip between them: the output path in secondary text, not a control, "Android mixer · 48 kHz" (only the number in mono). The file's format and whether it is resampled live in the mini player and the ⋯ sheet, not here. `AppShell.getOutputInfo` reads `AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE` (the mixer rate of the primary output) each time Now Playing or the ⋯ sheet opens; `mixerRate` and `outputPath()` live in `src/app/phone/app-shell.ts`. Playback goes through ExoPlayer and the Android mixer, so the phone is never bit-perfect and never says otherwise; the line is never accent.
- **Transport:** three pills sharing the row (`--phone-np-transport-height` 88 px); the pressed one widens to 1.1 while the others give way to 0.65 for 220 ms. Play takes the cover's lightest tone (see Cover colours; ink when there is no cover) and turns from a pill into a soft square (`--phone-np-play-radius`) while playing.
- **Toggles:** Shuffle (Off → Shuffle → Smart Shuffle) and Repeat (Off → All → One) as segments of one pill, each with its state in words ("Smart Shuffle", "Repeat one"); on is accent. Repeat is disabled while Smart Shuffle is on, with the line "Smart Shuffle keeps the music going, so repeat is off." under the pill, and the row is hidden while the roulette plays.

## Gestures and haptics

Tuned after PixelPlayer's `QueueBottomSheet`, `MiniPlayerSkipGestureHandler` and `QueueItemDismissGestureHandler`.

- **Queue rows:** cards after PixelPlayer's queue (`--bg-surface`, `--radius-xl`, cover `--phone-queue-cover`), the current one a pill in `--accent-muted` with a round cover and no handle. Each row ends with its duration and a ⋯ button that opens the track actions sheet for that entry. Smart Shuffle's picks after the current track are marked once, by a "Suggested by Smart Shuffle" divider with the compass star, not on every row (rows read it as their `aria-description`). The header reads "Queue".
- **Queue drag:** each upcoming row has a grip handle (`touch-action: none`). Dragging it lifts the row (`scale: 1.015`, large shadow) under the finger, the rows between its old and new place slide to make room (`dropSlot` in `src/app/phone/queue-drag.ts`, measured on layout positions so the shifts never move the goal), the list scrolls while the finger moves near its top or bottom edge, and the drop calls `moveQueueEntry`. Under Smart Shuffle the moved entry is pinned, and a pinned suggestion survives a re-plan. The handle also moves the row with the up and down arrow keys, and a live region announces the new position.
- **Queue header:** the count and the listening time left (the rest of the current track plus everything after it).
- **Long queues:** each row has `content-visibility: auto` with an intrinsic height, so only rows near the screen are rendered; a drag measures the rows once when it starts and on each new slot touches only the rows that move.
- **Missing files:** the same in the queue and every track list: muted title, and "File unavailable" in amber with a warning mark in place of the artist.
- **Queue remove:** swipe a row left (not the current one). The first 60 px move it only 20 px, so a scroll never removes a row; past 40 % of the screen it commits, slides out and is removed. Swipe, or Remove in the row's ⋯ sheet (the way for TalkBack, which takes swipes), show "Removed “title” · Undo"; Undo (`PlayerService.insertQueueEntry`) puts it back in place without touching playback. A removed suggestion is recorded for Smart Shuffle only when the Undo window passes (`QueueActionsService.removeWithUndo`). Remove on the current row moves playback on, with "Removed “…”, playing the next track · Undo"; that Undo puts the entry back and plays it again from the start.
- **Mini player:** the first time it appears it nudges left and back once (no words; `lutstra.phone.swipeHintShown` in localStorage; skipped under reduced motion). Swipe left for the next track, right for the previous one. It follows the finger with resistance (never past half the screen), commits at 22 % of the screen or on a flick (300 CSS px/s over at least 5 %), leaves fading, changes the track while invisible and comes back in from the other side. A tap still opens Now Playing.
- **Swipe:** `SwipeDirective` (`src/app/phone/swipe.directive.ts`, `swipeMode` `skip` or `dismiss`) takes the gesture after 10 px of mostly sideways movement; vertical moves stay with scrolling (`touch-action: pan-y`), and the click that ends a swipe is swallowed.
- **Haptics:** `haptic()` (`src/app/phone/haptics.ts`) calls `AppShell.haptic`, which runs `performHapticFeedback` on the WebView, so it follows the system touch-vibration setting and needs no `VIBRATE` permission (`navigator.vibrate` is not used). Kinds follow PixelPlayer: `start`/`end` (`GESTURE_START`/`GESTURE_END`, Android 11+) when a drag or swipe begins and ends, `activate`/`deactivate` (`GESTURE_THRESHOLD_*`, Android 14+) when a swipe crosses its threshold either way, `tick` (`CLOCK_TICK`) per drop slot and when a dismiss leaves its tension; older versions fall back to `CLOCK_TICK` or `LONG_PRESS`.
- **Motion:** sheets slide in over `--motion-dur`, rows make room over 60 % of it, swipes use their own short timings (Web Animations); `prefers-reduced-motion` sets `--motion-dur` to 0 ms and the swipe animations jump straight to their end.

## Covers on Android

`readMetadata` keeps the file's embedded picture (`getEmbeddedPicture`); a track without one takes its folder's `cover.jpg`, `folder.jpg` or `front.jpg` (found during the walk). Each image is scaled once to at most `ARTWORK_SIZE` (1024 px) and written as `files/artwork/<sha1>-1024.jpg`; embedded pictures are named by their bytes, so an album's tracks share one file, and folder covers by their key and modified time. The cache keeps the embedded file name (`art`); `METADATA_VERSION` 4 makes older entries read again once. Rows carry the absolute path as `artwork`, which the gateway turns into a WebView URL with `Capacitor.convertFileSrc` (same origin, so the CSP's `img-src 'self'` allows it); an album takes the first cover among its tracks. Unused cover files are not pruned yet.

On the Motorola (2026-10-17): the one-time re-read of 459 tracks with covers took about 35–40 s and wrote 64 covers (13 MB with the earlier 512 px set); Library, album pages, the mini player, Now Playing and the new Home all showed them. The Smart Shuffle card showed the live queue ("In your queue" while paused), and with Smart Shuffle off a five-track preview that New picks replaced, without starting playback.

## Test devices

From 2026-10-15 only the Motorola moto g stylus 5G (2024) is used for device testing. The Nothing A065 passed Gate B but is no longer in the test set, so later stages are verified on the Motorola alone.
