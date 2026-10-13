{
  "targets": [
    {
      "target_name": "window_snap",
      "sources": ["window_snap.cc", "media_controls.cc"],
      "defines": ["NAPI_VERSION=8", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
      "libraries": ["comctl32.lib", "runtimeobject.lib", "shcore.lib"]
    }
  ]
}
