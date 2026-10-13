// Windows System Media Transport Controls for the main window. Chromium only
// publishes Media Session to SMTC while one of its own media elements plays, and
// Lutstra plays through the native Audio Host, so the app registers SMTC itself.
#include <node_api.h>
#include <windows.h>
#include <roapi.h>
#include <shcore.h>
#include <systemmediatransportcontrolsinterop.h>
#include <windows.media.h>
#include <windows.storage.streams.h>
#include <wrl/client.h>
#include <wrl/event.h>
#include <wrl/wrappers/corewrappers.h>
#include <string>

using ABI::Windows::Media::ISystemMediaTransportControls;
using ABI::Windows::Media::ISystemMediaTransportControlsButtonPressedEventArgs;
using ABI::Windows::Media::ISystemMediaTransportControlsDisplayUpdater;
using ABI::Windows::Media::IMusicDisplayProperties;
using ABI::Windows::Media::IMusicDisplayProperties2;
using ABI::Windows::Media::SystemMediaTransportControls;
using ABI::Windows::Media::SystemMediaTransportControlsButtonPressedEventArgs;
using ABI::Windows::Media::SystemMediaTransportControlsButton;
using ABI::Windows::Storage::Streams::IRandomAccessStream;
using ABI::Windows::Storage::Streams::IRandomAccessStreamReference;
using ABI::Windows::Storage::Streams::IRandomAccessStreamReferenceStatics;
using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Wrappers::HStringReference;

namespace {
ComPtr<ISystemMediaTransportControls> controls;
EventRegistrationToken buttonToken{};
napi_threadsafe_function buttonCallback = nullptr;

const char* ButtonName(SystemMediaTransportControlsButton button) {
  switch (button) {
    case ABI::Windows::Media::SystemMediaTransportControlsButton_Play: return "play";
    case ABI::Windows::Media::SystemMediaTransportControlsButton_Pause: return "pause";
    case ABI::Windows::Media::SystemMediaTransportControlsButton_Stop: return "stop";
    case ABI::Windows::Media::SystemMediaTransportControlsButton_Next: return "next";
    case ABI::Windows::Media::SystemMediaTransportControlsButton_Previous: return "previous";
    default: return nullptr;
  }
}

void CallButton(napi_env env, napi_value callback, void*, void* data) {
  const char* name = static_cast<const char*>(data);
  if (!env || !callback || !name) return;
  napi_value argument, receiver;
  napi_create_string_utf8(env, name, NAPI_AUTO_LENGTH, &argument);
  napi_get_undefined(env, &receiver);
  napi_call_function(env, receiver, callback, 1, &argument, nullptr);
}

bool ReadHwnd(napi_env env, napi_value value, HWND* result) {
  void* data = nullptr;
  size_t length = 0;
  bool isBuffer = false;
  if (napi_is_buffer(env, value, &isBuffer) != napi_ok || !isBuffer ||
      napi_get_buffer_info(env, value, &data, &length) != napi_ok || length < sizeof(HWND)) {
    return false;
  }
  memcpy(result, data, sizeof(HWND));
  return *result != nullptr;
}

std::wstring ReadProperty(napi_env env, napi_value object, const char* key) {
  napi_value value;
  napi_valuetype type;
  if (napi_get_named_property(env, object, key, &value) != napi_ok ||
      napi_typeof(env, value, &type) != napi_ok || type != napi_string) return L"";
  size_t length = 0;
  napi_get_value_string_utf16(env, value, nullptr, 0, &length);
  std::u16string text(length, u'\0');
  napi_get_value_string_utf16(env, value, text.data(), length + 1, &length);
  return std::wstring(text.begin(), text.end());
}

napi_value Undefined(napi_env env) {
  napi_value result;
  napi_get_undefined(env, &result);
  return result;
}

void Dispose() {
  if (controls) {
    controls->remove_ButtonPressed(buttonToken);
    controls->put_IsEnabled(false);
    controls.Reset();
  }
  if (buttonCallback) {
    napi_release_threadsafe_function(buttonCallback, napi_tsfn_abort);
    buttonCallback = nullptr;
  }
}

napi_value MediaInit(napi_env env, napi_callback_info info) {
  size_t count = 2;
  napi_value args[2];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  HWND window = nullptr;
  napi_value result;
  if (count != 2 || !ReadHwnd(env, args[0], &window)) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  Dispose();
  // Chromium already initialized COM on this thread; a mode mismatch is harmless here.
  RoInitialize(RO_INIT_SINGLETHREADED);

  ComPtr<ISystemMediaTransportControlsInterop> interop;
  bool ok = SUCCEEDED(RoGetActivationFactory(
      HStringReference(RuntimeClass_Windows_Media_SystemMediaTransportControls).Get(), IID_PPV_ARGS(&interop)));
  ok = ok && SUCCEEDED(interop->GetForWindow(window, IID_PPV_ARGS(&controls)));
  if (ok) {
    napi_value name;
    napi_create_string_utf8(env, "LutstraMediaControls", NAPI_AUTO_LENGTH, &name);
    ok = napi_create_threadsafe_function(env, args[1], nullptr, name, 0, 1, nullptr, nullptr, nullptr,
                                         CallButton, &buttonCallback) == napi_ok;
  }
  if (ok) {
    napi_unref_threadsafe_function(env, buttonCallback);
    // SMTC raises ButtonPressed on a thread-pool thread; hop to JS through the TSFN.
    auto handler = Callback<ABI::Windows::Foundation::ITypedEventHandler<
        SystemMediaTransportControls*, SystemMediaTransportControlsButtonPressedEventArgs*>>(
        [](ISystemMediaTransportControls*, ISystemMediaTransportControlsButtonPressedEventArgs* event) {
          SystemMediaTransportControlsButton button;
          const char* name = SUCCEEDED(event->get_Button(&button)) ? ButtonName(button) : nullptr;
          if (name && buttonCallback) {
            napi_call_threadsafe_function(buttonCallback, const_cast<char*>(name), napi_tsfn_nonblocking);
          }
          return S_OK;
        });
    ok = SUCCEEDED(controls->add_ButtonPressed(handler.Get(), &buttonToken));
  }
  if (ok) {
    controls->put_IsPlayEnabled(true);
    controls->put_IsPauseEnabled(true);
    controls->put_IsNextEnabled(true);
    controls->put_IsPreviousEnabled(true);
    controls->put_IsStopEnabled(true);
    controls->put_IsEnabled(false);
  } else {
    Dispose();
  }
  napi_get_boolean(env, ok, &result);
  return result;
}

// update({ title, artist, album, artworkPath, state: 'playing' | 'paused' | 'none' })
napi_value MediaUpdate(napi_env env, napi_callback_info info) {
  size_t count = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &count, args, nullptr, nullptr);
  if (!controls || count != 1) return Undefined(env);

  const std::wstring state = ReadProperty(env, args[0], "state");
  if (state != L"playing" && state != L"paused") {
    controls->put_PlaybackStatus(ABI::Windows::Media::MediaPlaybackStatus_Closed);
    controls->put_IsEnabled(false);
    return Undefined(env);
  }

  ComPtr<ISystemMediaTransportControlsDisplayUpdater> updater;
  if (SUCCEEDED(controls->get_DisplayUpdater(&updater))) {
    updater->ClearAll();
    updater->put_Type(ABI::Windows::Media::MediaPlaybackType_Music);
    ComPtr<IMusicDisplayProperties> music;
    if (SUCCEEDED(updater->get_MusicProperties(&music))) {
      const std::wstring title = ReadProperty(env, args[0], "title");
      const std::wstring artist = ReadProperty(env, args[0], "artist");
      const std::wstring album = ReadProperty(env, args[0], "album");
      music->put_Title(HStringReference(title.c_str()).Get());
      music->put_Artist(HStringReference(artist.c_str()).Get());
      ComPtr<IMusicDisplayProperties2> music2;
      if (SUCCEEDED(music.As(&music2))) music2->put_AlbumTitle(HStringReference(album.c_str()).Get());
    }
    const std::wstring artworkPath = ReadProperty(env, args[0], "artworkPath");
    ComPtr<IRandomAccessStream> stream;
    ComPtr<IRandomAccessStreamReferenceStatics> references;
    ComPtr<IRandomAccessStreamReference> thumbnail;
    if (!artworkPath.empty() &&
        SUCCEEDED(CreateRandomAccessStreamOnFile(artworkPath.c_str(), 0 /* FileAccessMode::Read */, IID_PPV_ARGS(&stream))) &&
        SUCCEEDED(RoGetActivationFactory(
            HStringReference(RuntimeClass_Windows_Storage_Streams_RandomAccessStreamReference).Get(),
            IID_PPV_ARGS(&references))) &&
        SUCCEEDED(references->CreateFromStream(stream.Get(), &thumbnail))) {
      updater->put_Thumbnail(thumbnail.Get());
    }
    updater->Update();
  }
  controls->put_PlaybackStatus(state == L"playing" ? ABI::Windows::Media::MediaPlaybackStatus_Playing
                                                   : ABI::Windows::Media::MediaPlaybackStatus_Paused);
  controls->put_IsEnabled(true);
  return Undefined(env);
}

napi_value MediaDispose(napi_env env, napi_callback_info) {
  Dispose();
  return Undefined(env);
}
}  // namespace

void RegisterMediaControls(napi_env env, napi_value exports) {
  napi_property_descriptor methods[] = {
    {"mediaInit", nullptr, MediaInit, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"mediaUpdate", nullptr, MediaUpdate, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"mediaDispose", nullptr, MediaDispose, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 3, methods);
}
