import { describe, expect, it } from 'vitest';
import { cleanTitle, fallbackQuery, normalize, pickVideo, searchQuery } from '../electron/utils/youtube-match';

describe('cleanTitle', () => {
  it('drops version notes and featured artists', () => {
    expect(cleanTitle('Nếu Như Ta Chẳng Còn (feat. A$AP Ướt Mi)')).toBe('Nếu Như Ta Chẳng Còn');
    expect(cleanTitle('Vì (Special Music Night Ver)')).toBe('Vì');
    expect(cleanTitle('Here Comes the Sun - 2019 Remaster')).toBe('Here Comes the Sun');
    expect(cleanTitle('Switchblade feat. Ty Dolla $ign')).toBe('Switchblade');
  });

  it('keeps notes that are part of the track', () => {
    expect(cleanTitle('XTC (Xích Thêm Chút) (Remix)')).toBe('XTC (Xích Thêm Chút) (Remix)');
    expect(cleanTitle('Lively')).toBe('Lively');
  });
});

describe('normalize', () => {
  it('folds diacritics, đ and punctuation', () => {
    expect(normalize('Để Có Được Anh!')).toBe('de co duoc anh');
    expect(normalize('NGONGIODEMQUATRANGSANGDEMNAY')).toBe('ngongiodemquatrangsangdemnay');
  });
});

describe('searchQuery', () => {
  it('joins the first artist and the clean title', () => {
    expect(searchQuery('RPT MCK', 'Tay To (Live)')).toBe('RPT MCK Tay To');
    expect(searchQuery(null, 'Tay To')).toBe('Tay To');
    expect(searchQuery('Machiot, Linh Ka, Mason nguyen', 'Tét Vô Tâm Trí Em (Machimix)')).toBe('Machiot Tét Vô Tâm Trí Em (Machimix)');
  });
});

describe('fallbackQuery', () => {
  it('drops the last title word, or gives up on one-word titles', () => {
    expect(fallbackQuery('Drake', 'Janice STFU')).toBe('Drake Janice');
    expect(fallbackQuery('Machiot, Justatee', 'Talk To You (Machimix)')).toBe('Machiot Talk To');
    expect(fallbackQuery('Wuthering Waves', 'L!!!!ght')).toBeNull();
  });
});

describe('pickVideo', () => {
  const entries = [
    { id: 'lyric', title: 'Tay To - RPT MCK [Official Lyric Video]', view_count: 56_790_104, duration: 166 },
    { id: 'live', title: 'RAPITALIVE | Tay To - RPT MCK', view_count: 219_386, duration: 181 },
    { id: 'topic', title: 'TAY TO', view_count: 1_023_934, duration: 165 },
    { id: 'cover', title: 'Tay To (cover)', view_count: 90_000_000, duration: 165 },
    { id: 'long', title: 'Tay To (MV)', view_count: 99_000_000, duration: 400 },
    { id: 'short', title: 'Tay To (MV)', view_count: 99_000_000, duration: 120 },
    { id: 'other', title: 'Another track', view_count: 99_000_000, duration: 165 },
  ];

  it('takes the most viewed upload that names the track and runs as long', () => {
    expect(pickVideo(entries, 'Tay To', 165)?.id).toBe('lyric');
  });

  it('matches the title words in any order and allows a remix when the track is one', () => {
    const remix = [
      { id: 'remix', title: 'Xích Thêm Chút - XTC Remix | RPT Groovie ft TLinh x RPT MCK', view_count: 128_182_053, duration: 245 },
      { id: 'original', title: 'Rapitalove EP| XTC (Xích Thêm Chút) - RPT Groovie', view_count: 1_470_202, duration: 242 },
      { id: 'reaction', title: 'XTC(Xích Thêm Chút) Remix - ViruSs Reaction !', view_count: 880_305, duration: 692 },
    ];
    expect(pickVideo(remix, 'XTC (Xích Thêm Chút) (Remix)', 244)?.id).toBe('remix');
    expect(pickVideo(remix, 'XTC (Xích Thêm Chút)', 242)?.id).toBe('original');
  });

  it('keeps a remix or instrumental track off the original video', () => {
    const original = { id: 'mv', title: 'SƠN TÙNG M-TP | CHẠY NGAY ĐI | OFFICIAL MUSIC VIDEO', view_count: 165_800_000, duration: 280 };
    expect(pickVideo([original], 'Chạy Ngay Đi (Onionn Remix)', 260)).toBeNull();
    const mv = { id: 'mv', title: "NewJeans (뉴진스) 'How Sweet' Official MV", view_count: 81_594_220, duration: 220 };
    const inst = { id: 'inst', title: 'How Sweet (Instrumental)', view_count: 900_000, duration: 219 };
    expect(pickVideo([mv, inst], 'How Sweet (Instrumental)', 219, 'NewJeans')?.id).toBe('inst');
    expect(pickVideo([mv, inst], 'How Sweet', 219, 'NewJeans')?.id).toBe('mv');
  });

  it('prefers an upload that names the artist, so a cover does not match the original', () => {
    const ehEh = [
      { id: 'kaze', title: 'Eh, Eh', channel: 'Fujii Kaze', view_count: 1_421_207, duration: 167 },
      { id: 'gaga', title: 'Lady Gaga - Eh, Eh (Nothing Else I Can Say) (Official Music Video)', channel: 'Lady Gaga', view_count: 93_734_889, duration: 177 },
      { id: 'other', title: 'Fujii Kaze - Mo-Eh-Wa (Official Video)', channel: 'Fujii Kaze', view_count: 27_754_455, duration: 302 },
    ];
    expect(pickVideo(ehEh, 'Eh, Eh', 167, 'Fujii Kaze')?.id).toBe('kaze');
    expect(pickVideo(ehEh.slice(1), 'Eh, Eh', 167, 'Fujii Kaze')?.id).toBe('gaga');
    const hug = [
      { id: 'own', title: 'Một Cái Ôm - MCK', channel: 'MCK // Nger', view_count: 3_900_000, duration: 202 },
      { id: 'fan', title: '[ Vietsub/Engsub ] Một Cái Ôm | Only A Hug - RPT MCK', channel: 'Shigetsuna Shitposting', view_count: 1_100, duration: 202 },
    ];
    expect(pickVideo(hug, 'Một Cái Ôm', 202, 'RPT MCK')?.id).toBe('own');
    expect(pickVideo([{ id: 'bts', title: '134340', channel: 'BANGTANTV', view_count: 9, duration: 230 }], '134340', 230, 'BTS')?.id).toBe('bts');
  });

  it('takes a longer music video over a live take', () => {
    const seishun = [
      { id: 'mv', title: 'Fujii Kaze - Seishun Sick (Official Video)', channel: 'Fujii Kaze', view_count: 32_567_467, duration: 478 },
      { id: 'live', title: 'Fujii Kaze - "Seishun Sick" (live at Nissan Stadium) [Day2]', channel: 'Fujii Kaze', view_count: 40_000_000, duration: 334 },
    ];
    expect(pickVideo(seishun, '"Seishun Sick"', 324, 'Fujii Kaze')?.id).toBe('mv');
  });

  it('keeps a short interlude off a much longer medley', () => {
    const interlude = [
      { id: 'audio', title: 'WREN EVANS - Màu Đỏ (Interlude) | CHAATMD (Official Audio)', channel: 'Wren Evans Official', view_count: 299_897, duration: 64 },
      { id: 'medley', title: 'Anh Thấy x Màu Đỏ - Wren Evans hát cực tình', channel: 'FOREST STUDIO', view_count: 1_236_727, duration: 113 },
    ];
    expect(pickVideo(interlude, 'Màu Đỏ (Interlude)', 64, 'Wren Evans')?.id).toBe('audio');
    const short = [
      { id: 'mv', title: "NewJeans (뉴진스) 'New Jeans' Official MV", channel: 'HYBE LABELS', view_count: 43_866_979, duration: 211 },
      { id: 'lyrics', title: "NewJeans 'New Jeans (ft. The Powerpuff Girls)' Lyrics", channel: 'Jaeguchi', view_count: 19_579_659, duration: 110 },
    ];
    expect(pickVideo(short, 'New Jeans', 109, 'NewJeans')?.id).toBe('mv');
  });

  it('matches reordered notes and bracketed inserts, but keeps brackets inside a word', () => {
    expect(pickVideo([{ id: 'i', title: 'HIEUTHUHAI - Nước Mắt Cá Sấu Interlude (prod. by Kewtiie)', channel: 'HIEUTHUHAI', view_count: 554_175, duration: 135 }],
      'Interlude Nước Mắt Cá Sấu', 131, 'HIEUTHUHAI')?.id).toBe('i');
    expect(pickVideo([{ id: 'm', title: '楽音 - mosi mosi? LEESOL (KiiiKiii) Remix [Official Audio]', channel: '楽音', view_count: 157_014, duration: 164 }],
      'mosi mosi? LEESOL (KiiiKiii) Remix', 162, '楽音')?.id).toBe('m');
    const good = [
      { id: 'own', title: 'Fujii Kaze - Feelin’ Go(o)d', channel: 'Fujii Kaze', view_count: 13_656_709, duration: 337 },
      { id: 'other', title: 'Feelin God', channel: 'Someone', view_count: 99_000_000, duration: 260 },
    ];
    expect(pickVideo(good, 'Feelin’ Go(o)d', 260, 'Fujii Kaze')?.id).toBe('own');
  });

  it('does not count a banned word that belongs to the artist, and lets a "…mix" title match a remix', () => {
    expect(pickVideo([{ id: 'd', title: 'DPR IAN - No Blueberries (ft. DPR LIVE, CL) OFFICIAL M/V', channel: 'Dream Perfect Regime', view_count: 21_889_910, duration: 287 }],
      'No Blueberries', 185, 'DPR LIVE')?.id).toBe('d');
    expect(pickVideo([{ id: 'r', title: 'Fishing Game (Machiot Remix)', channel: 'Machiot Official', view_count: 9_535, duration: 178 }],
      'Fishing Game (Machimix)', 177, 'Machiot, KayC')?.id).toBe('r');
  });

  it('finds an unspaced CJK title inside a longer run', () => {
    expect(pickVideo([{ id: 'jp', title: 'YOASOBI「眩いばかり」Official Music Video', view_count: 9, duration: 250 }], '眩いばかり (Dazzling)', 250)?.id).toBe('jp');
  });

  it('returns null when nothing qualifies', () => {
    expect(pickVideo([{ id: 'x', title: 'Tay To', view_count: null }], 'Tay To', 165)).toBeNull();
    expect(pickVideo([], 'Tay To', 165)).toBeNull();
  });
});
