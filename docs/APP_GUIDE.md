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
  - Phiên nghe được giữ qua lần tắt app: queue, thứ tự trước shuffle, bài hiện tại và giây (`PlaybackSession`), lưu ở hàng `session` của bảng `settings` qua IPC `session:get` / `session:save` (`validPlaybackSession`). Renderer ghi dần trong lúc nghe, vì `before-quit` đóng database ngay: queue đổi thì ghi trong khoảng 1 giây, còn vị trí thì tối đa 5 giây một lần khi đang phát. Khi roulette chạy, cái được lưu là queue đang tạm gác và chỗ nghe tiếp của nó. Mở app thì nạp lại ở trạng thái **dừng**, không tự phát. Bài đã bị xoá khỏi thư viện thì bỏ qua. File của bài hiện tại bị mất thì hiện Unavailable.
  - `PlaybackEngine` là ranh giới với backend: Native Shared (Native Audio Host, mặc định) hoặc Chromium Shared (dự phòng).
  - Media flyout của Windows (Quick Settings, lock screen): khi chạy Chromium Shared, Chromium tự đẩy `navigator.mediaSession` lên. Khi chạy Native Shared, `MediaSessionService` gửi bài đang phát qua IPC `media-controls:update`, rồi `electron/media-controls.ts` gọi SMTC trong addon `native/window-snap/media_controls.cc`. Nút bấm trên flyout đi về theo channel `media-keys:action`.
- **Electron (`electron/`):** main process, IPC đã validate, SQLite, scanner và protocol `music://`. Renderer không chạm filesystem hay IPC thô.

**Ranh giới quan trọng:** việc thuần giao diện chỉ sửa `features/`, `shared/` và `src/styles/`. Hành vi phát nhạc, gateway, IPC và database là những thay đổi riêng, phải được yêu cầu rõ.

### Các service UI hay dùng (`core/layout`, `core/theme`)
- `LayoutPreferenceService`: layout hiện tại, lưu trong `lutsra.layout.*`.
- `ThemeService`: theme Graphite/Cloud và accent. Service này gắn `data-theme`, `data-accent` và `data-layout` lên `<html>`.
- `TrackSelectionService`: track đang chọn. Inspector của Console đọc giá trị này.
- `RecentPlaysService`: lịch sử nghe, lưu trong `lutsra.recentPlays` dạng `[{ trackId, playedAt }]`, mới nhất trước, tối đa 20. Lịch sử được ghi khi `player.currentTrack` đổi.
- `RightPanelService`: panel nào đang mở bên phải (queue drawer hoặc track details).
- `NavigationHistoryService`: lịch sử điều hướng cho nút back/forward.
- `DevModeService` (`core/settings`): developer mode ẩn, lưu trong `lutsra.dev.enabled`. Cách bật: khi dev mode đang tắt, bấm tiêu đề "About Lutstra" trong Settings để mở modal nhập mã (`app-dev-mode-dialog`). Mã duy nhất là **`lutstra-dev`**; không phân biệt hoa thường, bỏ qua khoảng trắng hai đầu. Mã này chỉ để tránh bật nhầm, không phải để bảo mật. Khi dev mode đang bật, bấm tiêu đề không làm gì; thẻ About có dòng "Developer mode: On" kèm nút **Exit developer mode** để quay về chế độ thường. Khi bật, header (cả 3 layout) có thêm nút icon gacha cạnh Settings (`src/assets/icons/gacha_cards_{outline,solid}.svg`, hiển thị bằng CSS mask, bản solid khi đang ở trang) dẫn tới trang **Music Roulette** (`/random-folder`, có guard; route, tên trong code và key localStorage vẫn giữ tên "random folder"). Trang này cố ý không nằm trong tab hay sidebar để không lẫn với Folders:
  - Duyệt folder như màn Folders (không cover). Folder mở gần nhất được nhớ trong `lutsra.dev.randomFolder.path`.
  - Mỗi dòng folder có một checkbox bên trái để gộp nhiều folder nhỏ thành một nguồn roll:
    - Tick ở folder nào cũng được. Dấu tick giữ nguyên khi đi vào đi ra các folder, và được nhớ trong `lutsra.dev.randomFolder.checked`.
    - Khi có folder được tick, nguồn roll là các folder đó thay cho folder đang mở. Nút Roll ghi "N folders" (hoặc tên folder nếu chỉ tick 1). Bài trùng giữa các folder lồng nhau chỉ tính một lần (`sourceTrackIds()`).
    - Dòng "N folders ticked to roll together" có nút **Clear** để bỏ hết dấu tick. Folder không còn trong thư viện thì tự bỏ tick.
  - Dưới danh sách folder con là danh sách **Tracks**: các bài còn phát được nằm trực tiếp trong folder đang mở. Mỗi dòng có cover, tên bài, nghệ sĩ, chip bậc và thời lượng.
    - Bấm vào dòng nào cũng tick hoặc bỏ tick bài đó (cả dòng là label của checkbox). Dấu tick được nhớ trong `lutsra.dev.randomFolder.checkedTracks`.
    - Bài đã tick được gộp chung với các folder đã tick thành một nguồn. Nút Roll ghi kiểu "2 folders, 5 tracks". **Clear** bỏ cả hai loại dấu tick.
  - Bấm Roll (nền accent) để bắt đầu một **lượt** (`RandomSessionService`). Dải quay kiểu mở hòm CS:GO (`random-reel`) hé lộ bài đầu trong 7 giây. Dải có nút Skip, có tiếng tách và tiếng ding (Web Audio, có thể im khi output Exclusive chiếm DAC), và bỏ hiệu ứng nếu bật reduced motion.
  - Viền mỗi ô theo bậc hiếm, tính theo lượt xem YouTube đã lưu (`popularityTiers()`), màu token `--rarity-1`…`--rarity-4` và hologram cho Mythical (chỉ dùng cho màn này):
    - Phân vị tính riêng trong từng vùng, tức thư mục cấp 1 dưới music root (`trackRegions()`). Riêng các folder trong `RANKED_WITH_LIBRARY` (hiện là "Random ass") xếp theo thang của cả thư viện.
    - Tỉ lệ số bài trong mỗi vùng (`TIER_SHARES`): vàng là 10% bài nhiều view nhất, đỏ 20% kế tiếp, xanh dương 30% kế tiếp, còn lại 40% là bậc nền xám xanh.
    - Bậc 5 **Mythical**: 2% bài nhiều view nhất của vùng (`MYTHIC_SHARE`), không giới hạn theo nghệ sĩ.
    - Vàng giữ tối đa 2 bài mỗi nghệ sĩ (`GOLD_PER_ARTIST`, tính theo nghệ sĩ đầu tiên, `leadArtist()`). Các bài vượt mức xuống đỏ, để một nghệ sĩ không chiếm hết bậc vàng.
    - Mythical không có màu cố định mà dùng kiểu hologram, chạy vòng qua mọi màu (`--holo-hue` đăng ký bằng `@property`, keyframes `holo-cycle` trong `_primitives.scss`), nên không lẫn với 4 màu kia trên bất kỳ màn hình nào.
      - Cả trang chỉ có **một đồng hồ màu**: animation đặt trên khung trang, sinh ra biến `--holo-live`. Ô trúng, lóe sáng, thẻ kết quả, chip và spectrum đều đọc biến này, nên cùng một màu tại mọi thời điểm.
      - Spectrum là canvas nên dùng input `liveColor` để đọc lại màu mỗi khung hình.
      - `--rarity-holo` là dải cầu vồng tĩnh cho chấm màu.
    - Bài không có view (No match hoặc chưa tra) xếp vào bậc nền. Intro và interlude không được lọc riêng, view quyết định.
    - Bậc tính trên cả thư viện, không theo folder nguồn, nên một bài giữ nguyên bậc ở mọi folder. Màn này đọc views đã lưu qua `PopularityFetchService.load()` (không lên mạng) rồi đặt vào `RandomSessionService.tiers`.

    Khi trúng, quầng sáng mạnh dần theo bậc; vàng và Mythical có thêm vệt sáng quét qua. Hiệu ứng riêng:
    - Tiếng khi dừng tăng theo bậc: ding cho xám/xanh, 2 nốt cho đỏ, rải hợp âm 4 nốt cho vàng, chuỗi nốt dài có tiếng lấp lánh cho Mythical (Web Audio).
    - Vàng: quầng sáng phập phồng 3 lần rồi đứng yên.
    - Mythical: viền và quầng sáng chạy vòng màu, một lần lóe sáng hologram lan khắp dải quay, spectrum đổi màu liên tục khi bài đang phát.
    - Thẻ kết quả của vàng có viền và nền phủ màu vàng, của Mythical thì viền chạy vòng màu.
    - Bật reduced motion thì giữ trạng thái cuối, không có chuyển động.
  - Mỗi lần pick là một roll gacha (`rollTier()` rồi `drawTrack()`):
    - Tỉ lệ niêm yết: xám 65%, xanh 25%, đỏ 8.5%, bậc cao (vàng hoặc Mythical) 1.5%. Bậc không có bài thì tỉ lệ rơi xuống bậc dưới.
    - Bảo hiểm: soft pity từ lượt 40 (+6% mỗi lượt), lượt 50 chắc chắn ra bậc cao, mỗi 10 lượt chắc chắn có đỏ trở lên.
    - Mỗi lần ra bậc cao có 25% là Mythical (`MYTHIC_CHANCE`). Lần ra bậc cao thứ 3 kể từ Mythical gần nhất chắc chắn là Mythical (`MYTHIC_GUARANTEE`). Mô phỏng 100k lượt: trung bình 32 lượt một lần ra bậc cao, 74 lượt một Mythical.
    - Bộ đếm `gold`, `red`, `mythic` lưu trong `lutsra.dev.randomFolder.pity`, giữ qua các lượt và qua lần mở app. Màn roll hiện bộ đếm ("Gold pity x/50 · Red y/10 · Mythical m/3"), ẩn trong lúc quay.
    - Tỉ lệ co giãn theo nguồn (`RateScale`): trọng số mỗi bậc, và cả tỉ lệ nâng lên Mythical, được nhân với tỉ lệ (phần của bậc đó trong nguồn) / (phần của bậc đó trong cả thư viện). Thống kê thư viện là `RandomSessionService.libraryTiers`, tính bằng `tierCounts()`.
      - Roll cả thư viện hay một vùng thì gần như không đổi.
      - Folder toàn bài hit thì ra hit nhiều hơn. Ví dụ VN/Anh Chính (1 Base, 1 Gold, 6 Mythical): trước đây bài Base ra 98.6%, vì Blue và Red không có bài nên tỉ lệ của chúng dồn về Base. Giờ còn 54%, Gold 7%, Mythical 39%.
    - Ô đệm trên dải quay rút theo tỉ lệ đó (không tính pity), bình thường không bao giờ là vàng hay Mythical, để hai bậc này chỉ hiện khi bài trúng thuộc bậc đó. Nếu nguồn có dưới 5 bài từ Base đến Red (`MIN_FILLER_TRACKS`), ô đệm lấy từ cả nguồn, để dải quay không lặp đi lặp lại một bài.
    - Dưới dải quay có spectrum đối xứng: 40 dải (50 Hz–23 kHz) lan ra hai bên từ vạch chỉ, cột rủ từ trên xuống và thò xuống dưới thẻ kết quả, màu theo bậc rarity của bài đang phát. Spectrum ẩn (giữ chỗ) khi reel đang quay hoặc queue thường còn đang phát, chỉ hiện khi bài gacha đã phát. Dùng lại `app-spectrum-visualizer` với các input `mirrored`, `flipped`, `bare`, `barCount`, `minHz`/`maxHz`, `colorVar`; giá trị mặc định giữ nguyên spectrum ở Now Playing.
    - Ô đệm trên dải rút theo tỉ lệ gốc. Dialog tùy chọn có khối Rates chỉ đọc.
  - Lượt phát như **nguồn ngoài** của player (`player.playExternal()` với `ExternalSource`: `next`, `peek`, `previous`). Queue thường được cất ở bài và giây hiện tại, vẫn nhận Add to queue / Play next; `player.backToQueue()` phát tiếp đúng chỗ đó, `stopExternal()` dừng hẳn khi queue rỗng; phát bất cứ thứ gì từ thư viện hoặc bấm một bài trong queue thì lượt kết thúc.\n  - Lượt giữ lịch sử riêng: Previous/Next đi qua lịch sử (Previous về đầu bài nếu đã nghe quá 3 giây), hết lịch sử mới pick bài mới. Bài kế được pick sẵn qua `peek` cho crossfade/gapless, trừ khi trang sẽ quay reel cho nó.
  - Tùy chọn trong `app-random-options-dialog` (`lutsra.dev.randomFolder.options`):
    - Include subfolders.
    - Roll every track: mỗi bài quay 3 giây và nhạc chờ quay xong. Nếu đang ở màn khác, hoặc cửa sổ đang ẩn hay thu nhỏ (`document.hidden`, ví dụ khi chuyển bài bằng phím media lúc app chạy nền), thì pick im lặng và phát ngay. Cửa sổ bị ẩn giữa lúc đang quay thì reel kết thúc luôn. Lớp an toàn: reel bị đứng quá 4 giây thì session tự phát bài. Khi tắt, chỉ roll bài đầu, các bài sau pick im lặng.
    - No repeats in a round: hết pool thì dừng và báo (khi Infinite roulette tắt).
    - Infinite roulette (mặc định tắt, chỉ bật được khi có No repeats): hết pool thì tự bắt đầu lại, bài vừa phát không bị pick ngay lượt kế; pity giữ nguyên.
  - Roll, Roll again hoặc Change folder rồi roll lại sẽ bắt đầu lượt mới. Màn kết quả (Change folder, dải quay, card) giữ nguyên khi chuyển trang, cho tới khi lượt kết thúc: rời lượt (Back to queue, Stop roulette, phát thứ khác) thì trang về danh sách thư mục, không còn reel hay spectrum.
  - Suốt lượt (`player.modesLocked()`, bật khi có nguồn ngoài) nút shuffle/repeat bị ẩn ở player bar và Now Playing, phím S/R bị bỏ qua, và repeat được coi là off; trạng thái shuffle/repeat đã lưu không đổi và áp dụng lại khi lượt kết thúc. Queue chỉ bị ẩn khi ở trang (`RightPanelService.queueHidden`); ở trang khác vẫn mở được và là queue thường.\n  - Drawer Queue hiện dải "Roulette is playing" với nút **Back to queue**, hoặc **Stop roulette** khi queue rỗng (cả hai gọi `player.backToQueue()`). Bài đang cất có nhãn "Resumes here" (`.parked`: viền accent trái, không tô như bài đang phát). Thẻ kết quả trên trang có cùng nút đó dưới Roll again (`session.leave()`).
- Thử nghiệm độ phổ biến (cũng chỉ hiện khi bật developer mode), trong màn Folders:
  - Bảng file có thêm cột **Views** và nút **Fetch views**. Nút này tra lại lượt xem YouTube cho các bài đang hiện trong bảng, kể cả bài đã có số.
  - Toolbar có nút **Fetch missing views (N)**: tra mọi bài chưa có số dưới folder đang mở, kể cả thư mục con. Đứng ở root là quét cả thư viện, khoảng 1,2 giây mỗi bài. Việc quét vẫn chạy khi chuyển sang trang khác (`PopularityFetchService`).
  - Mỗi lần Scan library hoặc Scan this folder xong, app tự tra views cho mọi bài chưa có số trong thư viện. Việc tự tra chỉ bắt đầu sau khi đã mở màn Folders ít nhất một lần.
  - Trong lúc tra, ngay dưới khung tiến trình scan có thêm khung **Fetching views** (đã tra x / n bài, thanh tiến độ, nút **Stop**).
  - Tắt developer mode thì việc tra đang chạy dừng luôn.
  - Toolbar có nút bật/tắt **No match (N)**, hiện ở folder có thư mục con. Khi bật, bảng chỉ liệt kê các bài không khớp được video nào, kèm đường dẫn folder của từng bài.
  - Việc tra do `PopularityService` (`electron/services`) đảm nhận: chạy file `yt-dlp` không qua shell, mỗi process khoảng 100 query truyền qua tham số dòng lệnh (yt-dlp đọc stdin sai bảng mã với chữ có dấu trên Windows). Stop diệt cả cây process. Máy phải cài sẵn yt-dlp, ví dụ bằng `winget install yt-dlp.yt-dlp`.
  - Báo cáo phân bố: `node scripts/popularity-report.mjs` đọc database ở chế độ chỉ đọc, ghi ra `plan/reports/popularity-distribution.md`. Báo cáo gồm phân vị lượt xem theo vùng (thư mục cấp 1 dưới root; Random ass xếp hạng theo cả thư viện) và thử 3 cách chia bậc. App dùng cách C (40/30/20/10).
  - Kết quả lưu vào bảng `track_popularity` trong database. Lần sau mở folder thì cột Views hiện ngay số đã lưu mà không cần tra lại.
  - Cách chọn video (`electron/utils/youtube-match.ts`), search bằng nghệ sĩ đầu tiên cộng tên bài, xét 10 kết quả đầu:
    - Tiêu đề video phải có đủ mọi từ của tên bài, thứ tự nào cũng được, từ lặp phải lặp đủ số lần. Trước khi so đã bỏ phần feat. và phần ngoặc đứng tách rời; ngoặc nằm giữa từ như "Go(o)d" thì giữ.
    - Loại video có chữ cover, remix, live, extended, karaoke, practice, fancam…, trừ khi tên bài hoặc tên nghệ sĩ có chữ đó. Tên bài có chữ "…mix" (ví dụ Machimix) thì cho phép video remix.
    - Ngược lại, tên bài có remix, "…mix", instrumental hoặc inst thì video cũng phải có chữ đó, để bản remix hay instrumental không lấy view của MV gốc.
    - Video không được ngắn hơn file quá 30 giây. Video dài hơn file được tối đa 180 giây (MV hay có intro); riêng file dưới 90 giây chỉ được dài hơn tối đa 30 giây.
    - Ưu tiên video có tên nghệ sĩ trong tiêu đề hoặc tên kênh, sau đó chọn video nhiều view nhất.
    - Bài chưa khớp được search lại lần hai với tên bài bỏ chữ cuối, vì YouTube trả về rỗng với một số chữ (ví dụ "Drake Janice STFU"). Lần hai chỉ ghi đè khi khớp được.
    - Không có video nào thỏa thì ô hiện "No match".
  - Lượt xem này là nguồn xếp bậc rarity của màn Music Roulette (xem ở trên).

## 3. Ba layout, một bảng màu
`<html data-layout>` nhận một trong ba giá trị. Mỗi layout khác nhau ở **vị trí** của điều hướng, nội dung và player, không khác nhau ở màu.

| | Gallery (`inset`) | Console (`classic`) | Ambient (`liquid-glass`) |
|---|---|---|---|
| Điều hướng | tab chữ trên header | cây thư viện kèm nhóm Quality | rail icon bằng kính |
| Player | rail Now Playing 300px (kéo mép trái để đổi 240–560px, kéo dưới 160px thì gập thành cột 76px; cửa sổ ≤1100px mặc định gập, lưu `lutsra.gallery.railWidth`, cách sheet 6px), có Lyrics | thanh strip 52px kèm signal path | dock dạng viên thuốc, nổi giữa màn hình: tên bài, độ phân giải ngắn (`24bit/96kHz`), transport, timeline, nút chế độ phát, volume, queue. Dưới 900px chia 3 vùng và bỏ timeline; dưới 600px volume thành icon có thanh dọc nổi. Trên Now Playing, dock bỏ tên bài và độ phân giải, và dưới 900px timeline chuyển vào card spectrum |
| Mật độ | hàng 52px | hàng 30px, inspector dock ở cạnh | hàng 44px |
| Source file (trang Now Playing) | card thông số dưới khối chính | card thông số dưới khối chính | chip signal path trên thẻ tên, bấm mở All properties |

Component không viết `if layout === ...`. Thay vào đó, chúng đọc token theo layout: `--surface-radius`, `--control-radius`, `--row-height`, `--cover-*`, `--type-display*`, `--motion-*`. Chỉ khi topology thật sự khác (ví dụ Lyrics chỉ có trong rail Gallery) mới tách theo layout.

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
