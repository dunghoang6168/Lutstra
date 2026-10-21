# Hướng dẫn ứng dụng Lutstra

Dành cho người mới vào dự án. Tài liệu này giải thích app được tổ chức thế nào và vì sao: kiến trúc, ba layout, hệ token, các thành phần dùng chung, và quy trình làm việc. Phần cài đặt, chạy app và đóng gói nằm trong [README](../README.md). Quy tắc thiết kế chi tiết ở [DESIGN.md](../DESIGN.md). Bản tóm tắt dạng mệnh lệnh cho AI agent ở [AGENTS.md](../AGENTS.md).

## 1. Lutstra là gì
Trình phát nhạc desktop, local-first, dành cho người nghe quan tâm đến chất lượng file: lossless, Hi-Res, file nào bị thiếu. Nguyên tắc xuyên suốt là **sự thật về file luôn hiển thị**: định dạng, bit depth và sample rate, cùng việc output đang bit-perfect, resample hay đi qua shared mixer của Windows. Các thông tin này xuất hiện ở mọi layout, dưới dạng chữ mono.

Tên sản phẩm là **Lutstra**, tên kỹ thuật dùng `lutstra` (package, `dist/lutstra`, user agent và `lutstra.sqlite`). Giữ origin `app://lutsra`, khóa localStorage `lutsra.*` và IndexedDB `lutsra-waveform` để bảo toàn dữ liệu trình duyệt đã lưu. Migration giữ tên profile và database cũ để tìm dữ liệu nguồn.

## 2. Kiến trúc
Sơ đồ đầy đủ ở mục "Kiến trúc" của README. Bản ngắn:

- **Renderer (Angular 21, standalone, signals):**
  - `src/app/core`: services và contracts
  - `src/app/features`: từng trang
  - `src/app/shared`: component, pipe và util dùng chung
- **Gateway:** mọi truy cập dữ liệu đi qua gateway trong `core/contracts`. `app.config.ts` chọn adapter Electron (`core/desktop`) khi chạy desktop, và adapter mock (`core/mock`) khi chạy trên trình duyệt. Nhờ đó, `npm start` chạy được toàn bộ UI bằng dữ liệu giả.
- **Phát nhạc:**
  - `PlayerService` (`core/player`) giữ queue và trạng thái phát.
  - Phiên nghe được giữ qua lần tắt app: queue, thứ tự trước shuffle, bài hiện tại và giây (`PlaybackSession`), lưu ở hàng `session` của bảng `settings` qua IPC `session:get` / `session:save` (`validPlaybackSession`). Renderer ghi dần trong lúc nghe, vì `before-quit` đóng database ngay: queue đổi thì ghi trong khoảng 1 giây, còn vị trí thì tối đa 5 giây một lần khi đang phát. Khi một nguồn phát ngoài đang chạy, cái được lưu là queue đang tạm gác và chỗ nghe tiếp của nó. Mở app thì nạp lại ở trạng thái **dừng**, không tự phát. Bài đã bị xoá khỏi thư viện thì bỏ qua. File của bài hiện tại bị mất thì hiện Unavailable.
  - **Smart Shuffle** là một bước trong vòng xoay của nút Shuffle: Off → Shuffle → Smart Shuffle (icon ngôi sao) → Off, giống nút Repeat; phím S xoay theo đúng vòng này. Nút gộp ở Ambient và Gallery Now Playing xoay Off → Shuffle → Smart Shuffle → Repeat All → Repeat One. Smart Shuffle ẩn khi một nguồn phát ngoài đang chạy. Chi tiết kỹ thuật nằm ở mục Smart Shuffle trong AGENTS.md.
    - **Một chế độ của queue**, loại trừ với Shuffle:
      - Bài của bạn được xếp lại theo gu; bài được Play next hoặc kéo tay thì giữ nguyên chỗ.
      - Cứ vài bài (5 lúc đầu, tự chỉnh từ 4 đến 8) lại chèn một bài gợi ý, chỉ trong 10 vị trí phía trước. Hết bài của bạn thì chạy tiếp bằng gợi ý, không dứt.
      - Queue trống mà xoay tới Smart Shuffle thì phát luôn các bài gợi ý.
      - Rời Smart Shuffle thì bỏ các bài gợi ý chưa phát và trả lại thứ tự gốc.
    - **Thuật toán chạy ngầm, không có nút đánh giá** (`core/smart-shuffle`):
      - Hồ sơ gu tính từ `play_events`, tín hiệu cũ giảm một nửa sau 60 ngày.
      - Mỗi bài được lấy mẫu Thompson, rồi nhân với độ liên kết với bài trước (nghệ sĩ, vùng, thể loại, thời kỳ) và độ mỏi (bài vừa nghe thì nghỉ một ngày).
      - Không để 3 bài liền cùng nghệ sĩ.
      - Skip hai bài liền cùng vùng thì vùng đó bị hạ cho đến hết phiên.
    - **Queue drawer:**
      - Bài gợi ý có icon la bàn nhỏ (icon Smart Shuffle) trước tên nghệ sĩ.
      - Bài gợi ý sau bài kế tiếp hiện nhạt hơn, vì có thể đổi.
      - Chuỗi gợi ý ở cuối queue chỉ hiện 3 bài, kèm nút Show more.
      - Xóa một bài gợi ý được ghi là "không thích nhẹ" (`removed`).
    - **Autoplay** (như Autoplay của Spotify, tách khỏi Smart Shuffle). Mặc định bật; công tắc ở Settings › Playback (desktop) và Settings (điện thoại):
      - Chỉ chạy khi Smart Shuffle tắt, Repeat tắt và không có nguồn phát ngoài. Bật Repeat hoặc Smart Shuffle thì các gợi ý chưa phát rời queue; tắt Repeat thì chúng quay lại.
      - Xem trước như Spotify: queue vừa có bài là 5 bài gợi ý đã hiện ở cuối, chọn theo mấy bài cuối của queue.
      - Khi bài gợi ý đầu tiên bắt đầu phát, các bài gợi ý còn lại được chọn lại theo những bài vừa thật sự nghe (bài bạn thêm vào sau đó vẫn giữ). Từ đó mỗi bài gợi ý bắt đầu thì nối thêm cho đủ 5 bài chờ, không đổi các bài đang chờ, nên nghe mãi. Gợi ý là bài trong queue nên crossfade/gapless vẫn chạy.
      - Icon queue không còn số bài, vì phần Autoplay làm con số này tăng mãi.
      - Queue (desktop và điện thoại) hiện đủ các bài Autoplay đang chờ, bên dưới có nút **Refresh** để chọn lại cả 5 bài, không lấy lại bài nào đã có trong queue. Gợi ý của Smart Shuffle vẫn gọn còn 3 bài kèm Show more.
      - Bài của bạn giữ đúng thứ tự (Flex Mix, playlist phát đúng danh sách rồi mới sang gợi ý). Add to queue chèn trước các gợi ý; bật/tắt Shuffle vẫn để gợi ý ở cuối.
      - Trong queue (desktop và điện thoại) các gợi ý nằm dưới dòng phân cách "Autoplay"; icon la bàn chỉ dành cho gợi ý của Smart Shuffle. Tắt Autoplay thì bỏ các gợi ý chưa phát.
    - **Flex Mix** (mix của hôm nay; giao diện desktop và điện thoại đều gọi là Flex Mix, còn code, route `/daily-mix` và khoá `lutstra.dailyMix` giữ tên Daily Mix; `DailyMixService` trong `core/smart-shuffle`):
      - Mỗi ngày một danh sách 30 bài do Smart Shuffle chọn (`SmartShuffleService.picks()`, cùng logic với lúc khởi động nguội nên người dùng mới vẫn có mix). Lưu ở `lutstra.dailyMix` kèm ngày; sang ngày mới thì tạo mix mới, nút **New mix** tạo lại ngay.
      - Phát như một queue thường: Smart Shuffle tự tắt, skip không làm đổi bài trong mix nhưng vẫn được ghi vào lịch sử để học. Hết 30 bài thì Autoplay nối tiếp nếu đang bật; trang Flex Mix ghi "then Autoplay".
      - Gỡ một bài khỏi mix được ghi là `removed` như bài gợi ý.
      - Home Gallery và Ambient: thẻ ngang gồm ảnh ghép 4 bìa, nút Play/Pause, New mix (khi mix chưa phát) và 5 bài. Chưa phát thì là 5 bài đầu ("In today’s mix"); đang phát thì là các bài kế tiếp ("Up next in Flex Mix", "Playing · 7 of 30"). Bấm một dòng thì nhảy tới bài đó trong queue, hoặc phát mix từ bài đó.
      - Home Console: một dải một dòng phía trên bảng, gồm Play/Pause, Open, và dòng "Playing 7 of 30 · next: …" khi mix đang phát.
      - Mix được coi là đang phát khi queue chứa các bài của mix theo đúng thứ tự mix (Shuffle bật thì không cần đúng thứ tự, nhưng mix phải chiếm ít nhất nửa queue). Vì vậy Shuffle library không bị nhầm thành mix.
      - Trên điện thoại, Flex Mix nằm ở đầu Home.
    - **Báo cáo:** `node scripts/listening-report.mjs` ghi ra `plan/reports/listening-report.md` gồm tỉ lệ nghe hết và skip sớm theo nguồn và theo tuần, độ phủ thư viện trong 30 ngày, và tỉ lệ lặp bài trong 3 ngày.
  - **Lịch sử nghe** (nền cho Smart Shuffle):
    - **Ghi ngầm.** `ListeningHistoryService` (`core/history`, khởi động trong `app.config.ts`) ghi ngầm mọi lượt nghe vào bảng `play_events`: bài, lúc bắt đầu, số giây thật sự phát (không tính phần tua), vị trí xa nhất, số giây tua qua, cách bắt đầu (`user` / `auto` / `next` / `previous` / `resume`), lý do kết thúc (`ended` / `skip_next` / `skip_previous` / `picked_other` / `app_closed` / `other` / `removed`) và nguồn (`queue` / `roulette` / `smart-shuffle`).
    - **Đánh dấu lý do chuyển bài.** `PlayerService` ghi lại thao tác chuyển bài gần nhất của người dùng (`lastTransition()`), đặt trong `next()`, `previous()`, `playTrack()`, `playCollection()`, `jumpToQueueIndex()`, `playExternal()` và `backToQueue()`. Bài tự chuyển khi hết đi qua `advance()` riêng nên không bị tính là skip.
    - **Cách tính.** Logic thuần nằm trong `listen-tracker.ts`:
      - Nghe tới cách cuối bài trong `max(3, crossfade + 1)` giây thì tính là `ended`.
      - Repeat One: mỗi vòng là một lượt nghe.
      - Lượt dưới 1 giây không được ghi.
      - Lượt đang nghe dở được lưu tạm ở `lutstra.history.openListen`; lần mở app sau ghi lại với lý do `app_closed`.
    - **IPC:** `history:record`, `history:list`, `history:events` (toàn bộ, cho phân tích) và `history:clear`, có validate. Android lưu vào SQLite riêng của app với cùng bảng `play_events` (`AndroidListeningHistoryGateway` / `AndroidHistoryPlugin`); trên trình duyệt, lịch sử chỉ giữ trong bộ nhớ (`MockListeningHistoryGateway`).
    - **Trang History** (`/history`, sau Folders ở sidebar và tab):
      - Chỉ là lịch sử, không phải thống kê. Mỗi dòng gồm bài, nghệ sĩ, album, giờ nghe và thời lượng bài, chia nhóm theo ngày.
      - Hiện mọi lượt nghe đã ghi, kể cả lượt skip, trừ lượt từ nguồn phát ngoài và bài gợi ý bị xóa (`shownInHistory`). Các lượt này vẫn được lưu để phân tích.
      - Settings > Playback có nút **Clear history** (hỏi lại trước khi xóa).
  - `PlaybackEngine` là ranh giới với backend: Native Shared (Native Audio Host, mặc định) hoặc Chromium Shared (dự phòng).
  - Media flyout của Windows (Quick Settings, lock screen): khi chạy Chromium Shared, Chromium tự đẩy `navigator.mediaSession` lên. Khi chạy Native Shared, `MediaSessionService` gửi bài đang phát qua IPC `media-controls:update`, rồi `electron/media-controls.ts` gọi SMTC trong addon `native/window-snap/media_controls.cc`. Nút bấm trên flyout đi về theo channel `media-keys:action`.
- **Electron (`electron/`):** main process, IPC đã validate, SQLite, scanner và protocol `music://`. Renderer không chạm filesystem hay IPC thô.

**Ranh giới quan trọng:** việc thuần giao diện chỉ sửa `features/`, `shared/` và `src/styles/`. Hành vi phát nhạc, gateway, IPC và database là những thay đổi riêng, phải được yêu cầu rõ.

### Các service UI hay dùng (`core/layout`, `core/theme`)
- `LayoutPreferenceService`: layout hiện tại, lưu trong `lutsra.layout.*`.
- `ThemeService`: theme Graphite/Cloud và accent. Service này gắn `data-theme`, `data-accent` và `data-layout` lên `<html>`.
- `TrackSelectionService`: track đang chọn. Inspector của Console đọc giá trị này.
- `RecentPlaysService`: 20 bài gần nhất cho Home (Continue listening), lưu trong `lutsra.recentPlays` dạng `[{ trackId, playedAt }]`, mới nhất trước. Ghi khi `player.currentTrack` đổi. Đây không phải lịch sử nghe đầy đủ (`play_events`, xem mục Phát nhạc).
- `RightPanelService`: panel nào đang mở bên phải (queue drawer hoặc track details).
- `NavigationHistoryService`: lịch sử điều hướng cho nút back/forward.
- **Hai bản build (editions):** bản **public** là chính repo này; bản **full** thêm bản developer nằm trong `dev/`, một repo private riêng mà repo này bỏ qua (`.gitignore`). Tài liệu của bản developer nằm ở `dev/README.md`.
  - Code public chỉ chạm tới bản developer qua các "điểm cắm": `src/app/dev-hooks/index.ts` (renderer), `electron/dev-hooks.ts` (main process) và `electron/dev-hooks-preload.ts` (preload). Trong repo này chúng là stub không thêm gì; bản full thay bằng `dev/renderer/index.ts`, `dev/electron/index.ts`, `dev/electron/preload.ts`.
  - Cơ chế chung mà các điểm cắm dùng: `ContentSheetService.embedded` (trang nhúng một website: thu ô tìm thư viện, trình phát của Lutstra chỉ hiện khi đang phát, Console bỏ inspector), `NavigationHistoryService.setInnerHistory` (Back/Forward đi qua lịch sử riêng của trang trước), `ExternalSource.label`, và `FolderView` của Folders (`override` thay danh sách file, cột phụ `.col-extra`).
  - `scripts/edition.mjs` chọn bản build: theo `LUTSTRA_EDITION=full|public`, không có thì là full khi có thư mục `dev/`. `npm start`, `npm run build`, `npm run electron`, `npm run package:win` đi theo đó; `npm run electron:public` và `npm run package:win:public` ép bản public (installer ra `release/public`).
  - Không đưa code, tên hay hành vi của bản developer vào file public: thêm điểm cắm chung rồi đặt tính năng trong `dev/`.

## 3. Ba layout, một bảng màu
`<html data-layout>` nhận một trong ba giá trị. Mỗi layout khác nhau ở **vị trí** của điều hướng, nội dung và player, không khác nhau ở màu.

| | Gallery (`inset`) | Console (`classic`) | Ambient (`liquid-glass`) |
|---|---|---|---|
| Điều hướng | tab chữ trên header | cây thư viện kèm nhóm Quality | rail icon bằng kính |
| Player | rail Now Playing 300px (kéo mép trái để đổi 240–560px, kéo dưới 160px thì gập thành cột 76px; cửa sổ ≤1100px mặc định gập, lưu `lutsra.gallery.railWidth`, cách sheet 6px), có Lyrics | thanh strip 52px kèm signal path | dock dạng viên thuốc, nổi giữa màn hình: tên bài, độ phân giải ngắn (`24bit/96kHz`), transport, timeline, nút chế độ phát, volume, queue. Dưới 900px chia 3 vùng và bỏ timeline; dưới 600px volume thành icon có thanh dọc nổi. Trên Now Playing, dock bỏ tên bài và độ phân giải, và dưới 900px timeline chuyển vào card spectrum |
| Mật độ | hàng 52px | hàng 30px, inspector dock ở cạnh | hàng 44px |
| Source file (trang Now Playing) | card thông số dưới khối chính | card thông số dưới khối chính | chip signal path trên thẻ tên, bấm mở All properties |

Component không viết `if layout === ...`. Thay vào đó, chúng đọc token theo layout: `--surface-radius`, `--control-radius`, `--row-height`, `--cover-*`, `--type-display*`, `--motion-*`. Chỉ khi topology thật sự khác (ví dụ Lyrics chỉ có trong rail Gallery) mới tách theo layout.

**Android dùng khung điện thoại riêng**, không dùng ba layout trên. `main.ts` khởi động `PhoneAppComponent` (`src/app/phone/`) với `phoneRoutes`, và `ThemeService` đặt `data-layout='phone'`: giữ bảng màu và giọng chữ của Gallery, thêm token cho ngón tay (`--touch-target` 48px, `--phone-nav-height`, `--phone-mini-player-height`, `--phone-transport-size`, `--phone-play-size`, `--sheet-radius`). Khung gồm app bar (tiêu đề lấy từ `data.title` của route), trang, mini player (nền là ảnh bìa làm mờ, bìa, tên, nghệ sĩ, nút bài trước / play / bài sau tô màu theo bìa như Now Playing, vạch tiến độ) và thanh điều hướng Home · Search · Library. Chạm mini player mở Now Playing toàn màn hình, bố cục theo PixelPlayer: nền là ảnh bìa làm mờ, nút hàng chờ ở góc trên (vuốt lên ở Now Playing cũng mở hàng chờ, khi trang không đang cuộn), bìa vuốt để đổi bài, tên bài kèm nút ⋯ (sheet dạng lưới nút viên thuốc theo PixelPlayer: Playlist / Album / Artist, dòng File info mở ra mục File, Output), timeline là thanh dày tách ở đầu phát bởi một vạch (kiểu Material 3), chạy mượt theo từng khung hình, giữ để kéo thì thanh và giờ to lên, chạm giờ bên phải để đổi sang thời gian còn lại; chip output giữa hai mốc thời gian bằng chữ phụ (chạm vào mở sheet **Audio path**: chuỗi File → Decoder → Lutstra → mixer → codec Bluetooth → thiết bị, kèm một dòng kết luận có bị resample không, theo kiểu Thông tin âm thanh của Poweramp), kiểu dòng output của Poweramp: đầu ra · số bit thiết bị nhận · tần số (bit trước, Hz sau), ví dụ "Speaker · 16-bit · 48 kHz", "USB mixer · 32-bit · 96 kHz", "LDAC adaptive · 32-bit · 96 kHz"; số bit chỉ hiện khi Android báo (chỉ ghi điều Android xác nhận; codec Bluetooth cần quyền Nearby devices, xin ở Settings › Bluetooth; việc resample xem ở sheet ⋯), ba nút transport dạng viên thuốc (thành ô vuông bo góc khi đang phát); mọi nút ở Now Playing, kể cả Play, lấy màu từ ảnh bìa như PixelPlayer (`cover-tone.ts`, bìa gần như xám thì nút xám), phần còn lại của app vẫn theo accent và hàng toggle Shuffle / Repeat có chữ ghi trạng thái (khi bật Smart Shuffle có dòng giải thích vì sao Repeat tắt); hàng chờ là bottom sheet "Queue": mỗi dòng là một thẻ có ảnh bìa và nút ⋯ (Play now, Play next, Remove, Playlist, Album, Artist), bài gợi ý được đánh dấu một lần bằng dòng phân cách "Suggested by Smart Shuffle", kéo tay nắm ⠿ để đổi chỗ (các dòng khác dạt ra nhường chỗ; phím mũi tên lên/xuống cũng được), header ghi số bài và thời lượng còn lại, vuốt trái một dòng sắp phát hoặc chọn Remove trong ⋯ để bỏ bài (Remove trên dòng đang phát cũng có Undo, Undo phát lại bài đó), có Undo trong toast (bài gợi ý chỉ bị ghi `removed` khi hết hạn Undo). Vuốt mini player sang trái là bài sau, sang phải là bài trước; lần đầu mini player khẽ trượt một nhịp để gợi ý (không có chữ). Cử chỉ chỉnh theo PixelPlayer, rung qua `AppShell.haptic` (theo cài đặt rung khi chạm của máy); chuyển động dùng `--motion-dur`, về 0 khi bật giảm chuyển động. Nút Back của Android: đóng dialog trên cùng → hàng chờ → Now Playing → lùi trang → ở Home thì đưa app xuống nền. Accent mặc định trên điện thoại là blue. Library có 5 tab chip (Songs · Albums · Artists · Playlists · Folders, lưu ở `?tab=`) cùng nút Shuffle và ô sắp xếp; vuốt ngang vùng danh sách để sang tab bên cạnh (như bấm chip, dừng ở tab đầu và cuối); khi cuộn xuống hàng chip và toolbar trượt lên ẩn, cuộn lên là hiện lại và ghim dưới tiêu đề; danh sách dài hiện 100 dòng một lần, gần cuối thì thêm, ảnh bìa trong danh sách tải khi sắp vào màn hình; trang chi tiết album, nghệ sĩ, playlist, thư mục dùng chung `app-phone-detail-header` và `app-phone-track-row`; nút ⋯ mở sheet Play next / Add to queue / Playlist / Album / Artist; ở Settings, tab vừa mở nó vẫn sáng; trạng thái chung nằm trong `PhoneLibraryService`. Home theo kiểu PixelPlayer: tiêu đề "Flex Mix" (mix của hôm nay) với nút Play lớn, cụm ảnh bìa nghe gần đây, thẻ "Up next in Flex Mix" liệt kê bài của mix (khi mix đang phát thì theo queue, bỏ qua gợi ý; hết mix thì ghi "Autoplay is on"; ⋯ có Remove from mix), dải Recently played và Recently added, và skeleton đúng hình khối Home lúc thư viện đang tải; ảnh bìa Android lấy từ ảnh nhúng hoặc `cover.jpg` lúc scan; Search tìm bài, album, nghệ sĩ, playlist bằng `rankMatches`/`normalizeSearch` (`shared/utils/search-rank.ts`, dùng chung với global search desktop), từ khóa lưu ở `?q=`. Settings riêng cho điện thoại (thư mục nhạc, giao diện sáng/tối, accent cố định hoặc **Wallpaper** theo Material You trên Android 12+, **USB DAC** trên Android 14+: Shared · File rate · Bit-perfect, xoá lịch sử); màu Wallpaper do `dynamicAccentTokens()` (`core/theme/dynamic-accent.ts`) chọn tông đủ tương phản rồi ghi đè các biến `--color-accent*` với `data-accent='system'`. Kế hoạch: `plan/plans/android-phone-shell.md`.

Responsive tính theo **container** `.main-content` (`@container main-content`, đơn vị `cqi`), không theo viewport. Lý do: ở Console, cây thư viện và inspector chiếm chỗ, nên cùng một cửa sổ nhưng phần nội dung hẹp hơn nhiều.

## 4. Token, theme và màu
- **Nguồn token:**
  - `src/styles/_tokens.scss`: thang spacing, cỡ chữ, bo góc, scrim và các token ngữ nghĩa.
  - `_themes.scss`: hai preset Graphite và Cloud, sáu accent, và token theo từng layout.
- **Accent chỉ dùng để mang nghĩa:** Hi-Res, mục đang active, tiến trình, focus.
  - Chữ màu accent dùng `--text-accent`.
  - Nền có chữ trên accent dùng `--color-accent-fill` với `--color-on-accent`.
- **Amber là dấu hiệu thiếu:** file thiếu hoặc unavailable, output mất kết nối. Chữ màu amber dùng `--status-warning-text`. Với accent Amber, màu cảnh báo tự chuyển sang cam để không trùng với accent.
- **Nút xóa:** dùng `--status-error-fill`, `--status-error-fill-hover` và `--color-on-error`.
- **Nút Play màu mực:** nền `--text-primary`, icon `--text-inverse`.
- **Chữ trên ảnh:** chữ trắng đặt trên scrim (`--scrim-soft`, `--scrim-strong`, `--scrim-heavy`). Đặt nền tối bên dưới ảnh để chữ vẫn đọc được trong lúc ảnh đang tải.
- **Script contrast:** `node scripts/check-accent-contrast.mjs` kiểm mọi cặp accent × theme, cặp nút xóa và khoảng cách màu (ΔE) giữa accent và màu cảnh báo. Chạy lại mỗi khi đổi token màu.

## 5. Chất lượng file và câu chữ
- **Hàm format:** dùng chung trong `src/app/features/home/library-quality.ts`. Không tự viết chuỗi "kHz" ở từng chỗ.
  - `trackQuality`: trả về `lossy` / `lossless` / `hires`. Hi-Res nghĩa là lossless và 24-bit trở lên hoặc trên 48 kHz.
  - `formatTrackFormat`: dạng "FLAC 24/96".
  - `formatResolution`: dạng "24/96" hoặc "256k".
  - `formatTrackQualityLine`: đủ mọi thông số, dạng "FLAC 24/96 · 2605 kbps" hoặc "MP3 · 44.1 kHz · 320 kbps" (Now Playing trên điện thoại).
- **Signal path** (`shared/components/signal-path`): dòng mono `nguồn → đường ra`, có tooltip giải thích trạng thái. Settings › Audio output giải thích engine và shared mixer ngay tại chỗ. Dock Ambient chỉ hiện độ phân giải (`pillFormat` trong player-bar), hoặc "Output disconnected" màu amber khi mất output.
- **Câu chữ:**
  - Mọi nhãn viết sentence case: nút, tiêu đề, aria-label, tooltip.
  - Tên trang và tên engine giữ chữ hoa.
  - Một bài gọi là **track**.
  - Toggle hiển thị On/Off, kèm `aria-pressed`.

## 6. Thành phần dùng chung đáng biết
- **`album-card`:** thẻ không viền. Nhận `imageUrls` để ghép 2×2 khi có 4 ảnh. Nút phụ chèn qua slot `[card-actions]`.
- **`shared/utils/list-media.ts`:**
  - `selectPlaylistArtwork`: chọn 4 ảnh khác nhau làm bìa playlist.
- **`player-bar`:** gồm cả ba dạng player. Rail Gallery hiện lyrics của bài đang phát (lấy từ `CurrentLyricsService`, dùng chung với Now Playing), và ẩn khối này khi cửa sổ nhỏ hơn 1101×701.
- **Tooltip** (`shared/directives/tip.directive.ts`): `appTip="…"` cho nút chỉ có icon và cho lời giải thích (giữ `aria-label`), `appTipOverflow` cho chữ bị cắt (chỉ hiện khi tràn, trễ 450ms). Cả app dùng chung một popover. Không dùng `title`, trừ tay nắm resize rail Gallery. Độ bo theo `--control-radius`.
- **`appMarquee`** (`shared/directives/marquee.directive.ts`): chữ một dòng quá dài trượt qua lại; con đầu tiên là `.marquee-text`. Khi reduced motion thì hiện `…`. Dùng cho tên bài và độ phân giải trong dock Ambient.
- **`app-cover-art`** (`shared/components/cover-art`): cover của bài đang phát (Now Playing, cả ba dạng player-bar, hero trên Home, nền Ambient, ánh sáng viền Gallery). Ảnh mới chỉ hiện khi đã decode xong, rồi mờ dần đè lên ảnh cũ theo `--cover-fade-dur` (bằng `--motion-dur`; Console là 0ms nên đổi tức thì). Cùng URL thì không đổi; bấm Next liên tục chỉ giữ ảnh cuối, tối đa 2 lớp. `[icon]="null"` để lớp trống thay cho placeholder (nền, ánh sáng). Logic nằm ở `CoverSwap` (`cover-swap.ts`, test `tests/cover-swap.spec.mts`).
- **Nút chế độ phát gộp:** dock Ambient và Now Playing của Gallery dùng một nút xoay vòng Off → Shuffle → Repeat All → Repeat One (`PlayerService.playbackMode` / `cyclePlaybackMode()`). Bật thì màu accent, tắt thì icon repeat màu xám. Strip Console và rail Gallery vẫn tách 2 nút.
- **Artwork backdrop:** công tắc trong Settings › Layout, chỉ hiện ở Ambient (setting `ambientArtwork`, mặc định bật), để tắt lớp cover mờ dưới kính.
- **Ô search khi hẹp:** dưới 900px chữ gợi ý chỉ còn "Search"; dưới 650px thành icon, và ở Ambient ô trượt ra ngay trong cụm nút.
- **`track-details-panel`:** inspector của Console. Hiển thị khối chất lượng file trước, rồi mới đến tag.
- **Xóa có hoàn tác:** xóa playlist không còn hộp xác nhận. Playlist ẩn ngay, toast "Deleted … · Undo" hiện 6 giây. Gateway chỉ xóa thật khi hết giờ, khi xóa playlist khác, hoặc khi rời trang. Xóa queue cũng có Undo (`QueueActionsService.clearWithUndo`).
- **Modal theo layout:** bộ token `--dialog-*` điều khiển bán kính, nền, viền, bóng, blur và bán kính control: Gallery r12, Console r3, Ambient glass r22 (nền đặc và bỏ blur khi giảm trong suốt). Create/Rename playlist, Remove folder và editor nghệ sĩ dùng native `<dialog>` + `showModal()` để phủ cả header và player; Onboarding/Shortcuts nằm ở app root với lớp phủ riêng.
- **Menu ⋯ trên mỗi dòng track** (`TrackActionsMenuComponent`, dùng ở Songs, Folders, chi tiết album/artist/playlist): một nút thay cho các nút lẻ, mở menu Play next / Add to queue / Add to playlist…. Nút hiện khi hover hoặc focus dòng, luôn hiện trên màn cảm ứng. Menu dùng Popover API, ↑/↓/Home/End di chuyển, Esc đóng, cuộn hoặc resize thì đóng.
- **Dialog Add to playlist** (`AddToPlaylistDialogComponent`, mở từ menu ⋯ và từ selection bar): ô search theo tên; mỗi playlist là một hàng gồm bìa (`selectPlaylistArtwork`), tên, số bài, nút Add. Playlist đã chứa bài đang thêm có dấu ✓ (`splitDuplicates` trong `list-media.ts`, có test). Thêm bài đã có thì dialog chuyển sang bước xác nhận: Cancel / Add anyway, hoặc khi chỉ một phần trùng: Cancel / Skip duplicates / Add all. Search không khớp playlist nào thì hiện hàng Create “tên” để tạo playlist mới và thêm luôn. Thêm xong đóng dialog và báo toast.
- **Sidebar Add tracks (playlist detail):** `AddTracksPanelComponent` (`features/playlists/add-tracks-panel/`) là cột bên phải, **không modal**, để kéo bài sang bảng playlist; container hẹp (≤ 600px) thì panel phủ cả trang. 4 tab Songs / Albums / Artists / Folders; tab dùng gần nhất lưu trong setting `addTracksTab`. Songs có search và popover Filter (Artist, Album, Year, Quality). Album/Artist/Folder bấm vào để xem bài bên trong (Back, Esc lùi một cấp), nút "Add all" chỉ thêm bài chưa có; folder duyệt theo cây thư mục con. Mỗi bài có cover, bài đã trong playlist hiện dấu ✓ (bấm không thêm trùng). Kéo một bài, một nhóm (album/artist/folder) hoặc header nhóm vào bảng: thả lên một dòng để chèn trước/sau dòng đó, thả chỗ trống để thêm vào cuối (`addTracks` rồi `reorderEntries`, thứ tự tính bằng `insertOrder`). Kéo vẫn cho thêm bản trùng nếu là bài đơn đã ✓; kéo nhóm chỉ mang bài chưa có.
- **`android-folder-picker`** (chỉ Android): hộp nổi chọn thư mục quét theo kiểu Poweramp, mở từ mọi nút Add folder trên Android (Settings ghi **Choose folders**). Cây thư mục đã cấp quyền với ô tick 3 trạng thái, tên ổ dưới thư mục gốc, nút ✕ bỏ quyền, **Add folder or storage**, **Save & scan**. Tick chỉ là nháp đến khi lưu. Chi tiết trong `docs/ANDROID_DEVELOPMENT.md`.
- **`spectrum-visualizer`:** khi tạm dừng, vẽ đường phẳng kèm chữ "Paused", và giữ nguyên chiều cao khung. Không còn nhãn "Spectrum".

## 7. Bảng track và bàn phím
Mọi bảng track (Songs, chi tiết album/artist/playlist, Home của Console, queue) đi theo một mẫu:
- `role="grid"`, roving tabindex: chỉ một hàng nằm trong thứ tự Tab.
- Phím ↑/↓/Home/End/PageUp/PageDown di chuyển qua `nextRowIndex` (`shared/utils/row-navigation.ts`).
- Enter chạy hành động chính của hàng. Space để dành cho play/pause toàn cục.
- ↑/↓ chỉ chỉnh volume (±5%, giữ phím để lặp; trên thanh volume đang focus thì ↑/↓ vẫn 5%, còn ←/→ và kéo chuột đi 1%) khi đang ở Now Playing hoặc focus nằm trong player (bấm vào chỗ trống của thẻ player, section có `tabindex="-1"`); ở nơi khác chúng vẫn cuộn/di chuyển hàng. Grid, listbox, menu và lyrics của rail luôn giữ mũi tên cho mình.
- Selection đi theo focus (`aria-selected`).
- Nút trên hàng chỉ vào thứ tự Tab ở hàng đang active.

**Chọn nhiều** (Songs, chi tiết album/artist/playlist; `aria-multiselectable="true"`). Logic chung nằm ở `shared/utils/row-selection.ts`, là hàm thuần và có test.
- Ctrl+click hoặc Ctrl+Space: bật/tắt một hàng.
- Shift+click hoặc Shift+phím mũi tên: chọn dải từ anchor.
- Ctrl+phím mũi tên: chỉ di chuyển focus, giữ nguyên selection.
- Ctrl+A: chọn mọi hàng đang hiển thị.
- Esc hoặc nút Clear: thu selection về hàng đang focus. Luôn có ít nhất một hàng được chọn, nên inspector vẫn khớp.
- Từ hai hàng trở lên, `app-track-selection-bar` phủ lên header bảng. Header bên dưới bị `inert`, các hàng không bị đẩy xuống.
  - Thanh có Play next, Add to queue, Add to playlist (mở dialog Add to playlist) và Clear.
  - Track unavailable bị bỏ qua, và toast báo rõ số track bị bỏ qua.
  - Playlist detail chọn theo entry id, nên một track xuất hiện hai lần thì được gửi hai lần.

Trang chi tiết đọc `route.paramMap` để tải lại khi router dùng lại component. Một lượt tải về muộn không được ghi đè trang mới.

## 8. Test và kiểm tra
1. `npx ng build`.
2. `npx vitest run`. Test nằm trong `tests/`. `.gitignore` bỏ qua `*.spec.ts`, nên file test mới phải thêm bằng `git add -f`, hoặc đặt đuôi `.spec.mts`.
3. `node scripts/check-accent-contrast.mjs` khi đổi màu.
4. **Xem giao diện thật:** chạy dev server (`npm start`), rồi chạy
   `env -u ELECTRON_RUN_AS_NODE npx electron scripts/ui-sweep.cjs`.
   - Script duyệt mọi route × 3 layout × 2 theme × 1440/560.
   - Nó báo contrast thấp, cuộn ngang, control thiếu tên, ảnh thiếu alt và lỗi console.
   - Kết quả phải là 0 trang bị báo lỗi.
   - Script không đo được chữ nằm trên ảnh, nên các chỗ đó phải xem ảnh chụp bằng mắt.
   - Nếu tự viết probe: chèn style tắt transition **trước** khi đo, vì cửa sổ ẩn làm transition đứng yên và cho kết quả sai.

## 9. Làm việc nhiều agent cùng lúc
Dự án từng được làm song song bởi nhiều agent: một bên review, các bên khác thực hiện.
- Mỗi agent làm trong git worktree và branch riêng, với cổng dev server riêng. Mỗi agent chỉ sửa những file được giao, để hai bên không đụng cùng một file.
- Agent thực hiện **không** commit, push, checkout, stash hay reset. Họ gửi plan ngắn, chờ duyệt, rồi báo cáo kèm: file đổi, output test, ảnh chụp, chỗ làm khác yêu cầu, và lỗi ngoài phạm vi.
- Người review tự đọc diff thật và tự kiểm trên giao diện. Sau đó mới commit, rebase và merge fast-forward vào `main`.
- Các lỗi phát hiện ngoài phạm vi được ghi vào backlog và sửa ở đợt sau, không sửa lẫn vào đợt đang làm.
