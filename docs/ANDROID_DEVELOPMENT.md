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

`npm run build:android` ships the regular Angular app. On Android, `app.config.ts` provides the Android library and playlist gateways, `AndroidPlaybackEngine` (`src/app/core/android/android-playback.engine.ts`) and `AndroidSettingsGateway`, which keeps settings and the playback session in the WebView's localStorage (app-private data) and starts with crossfade off. Lyrics, artist metadata and popularity still use the browser mocks.

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

- **Shell:** app bar, page, mini player and a bottom navigation of Home · Search · Library; Settings (the desktop page until P3) opens from the app bar. Now Playing is a full-screen sheet over the shell and the queue a bottom sheet over it. P0 pages are minimal: Library lists every track by title to start playback, Home shows the last track, Search is a placeholder.
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

## Test devices

From 2026-10-15 only the Motorola moto g stylus 5G (2024) is used for device testing. The Nothing A065 passed Gate B but is no longer in the test set, so later stages are verified on the Motorola alone.
