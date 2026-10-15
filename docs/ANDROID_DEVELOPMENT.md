# Android development status

The Android app lives in `main` beside the desktop app (merged from `android/development`, itself forked from the passed `android/spike` checkpoint `e34254e`). It is not a numbered roadmap phase. Build it with `npm run build:android:spike`, then `android\gradlew.bat assembleDebug`; see `docs/ANDROID_SPIKE.md` for the toolchain.

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

## Next checks

1. Repeat the library and playlist checks on the Nothing device.
2. Drop the `spike` naming (application ID, app name, Angular entry) before the mobile shell work.
