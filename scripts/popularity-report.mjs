// Developer report: how the cached YouTube views (developer mode, Folders > Fetch views) spread over each
// library region, to choose the cuts for popularity-based rarity. Reads the app database read-only.
// A region is a top-level folder under a music root; RANKED_WITH_LIBRARY folders are ranked against the
// whole library instead. The report is written in Vietnamese for the working notes in plan/.
// Usage: node scripts/popularity-report.mjs [path/to/lutstra.sqlite] [out.md]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2] ?? path.join(process.env.APPDATA ?? '', 'Lutstra', 'lutstra.sqlite');
const OUT_PATH = process.argv[3] ?? path.join('plan', 'reports', 'popularity-distribution.md');
const RANKED_WITH_LIBRARY = new Set(['Random ass']);
const LIBRARY = 'Cả thư viện';
const SHORT_S = 90;
const TIERS = ['Base', 'Blue', 'Red', 'Gold'];
// Share of each tier, Base to Gold.
const SPLITS = {
  A: [0.55, 0.30, 0.13, 0.02],
  B: [0.65, 0.25, 0.085, 0.015],
  C: [0.40, 0.30, 0.20, 0.10],
};
// What the app uses: TIER_SHARES, MYTHIC_SHARE and GOLD_PER_ARTIST in src/app/features/random-folder/random-folder.utils.ts.
const CHOSEN = 'C';
const MYTHIC_SHARE = 0.02;
const GOLD_PER_ARTIST = 2;
const APP_TIERS = [...TIERS, 'Mythical'];
const PERCENTILES = [0.25, 0.5, 0.75, 0.85, 0.9, 0.95, 0.98, 0.99];

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
const views = (value) => value == null || !Number.isFinite(value) ? '—' : compact.format(value);

const db = new DatabaseSync(DB_PATH, { readOnly: true });
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='track_popularity'").get()) {
  console.error('No track_popularity table yet: fetch views in the app first (developer mode, Folders).');
  process.exit(1);
}
const roots = db.prepare('SELECT path FROM music_folders').all().map((row) => String(row.path));
const tracks = db.prepare(`SELECT t.id, t.title, t.artist, t.duration, t.path, p.status, p.views
  FROM tracks t LEFT JOIN track_popularity p ON p.track_id = t.id
  WHERE t.is_available = 1 AND EXISTS (SELECT 1 FROM folder_tracks ft WHERE ft.track_id = t.id)`).all()
  .map((row) => ({ ...row, region: regionOf(String(row.path)), views: row.views == null ? null : Number(row.views) }));

function regionOf(filePath) {
  const root = roots.find((rootPath) => filePath.startsWith(rootPath + path.sep) || filePath.startsWith(rootPath + '/'));
  const parts = root ? filePath.slice(root.length + 1).split(/[\\/]/) : [];
  return parts.length > 1 ? parts[0] : '(root)';
}

const regions = [...new Set(tracks.map((track) => track.region))].sort();
const matched = tracks.filter((track) => track.status === 'matched' && track.views != null);
// The scale each track is ranked on: its own region, or the whole library.
const scaleName = (region) => RANKED_WITH_LIBRARY.has(region) ? LIBRARY : region;
const scales = new Map([[LIBRARY, matched], ...regions.filter((region) => !RANKED_WITH_LIBRARY.has(region))
  .map((region) => [region, matched.filter((track) => track.region === region)])]);

/** Minimum views for Red, Red and Gold on a scale, by share from the top; Infinity when a tier is empty. */
function cuts(scale, split) {
  const sorted = scale.map((track) => track.views).sort((a, b) => b - a);
  const at = (share) => {
    const count = Math.round(sorted.length * share);
    return count > 0 ? sorted[count - 1] : Infinity;
  };
  const [, blue, red, gold] = split;
  return { mythic: at(MYTHIC_SHARE), gold: at(gold), red: at(gold + red), blue: at(gold + red + blue) };
}

function tierOf(track, split) {
  const cut = cuts(scales.get(scaleName(track.region)), split);
  return track.views >= cut.gold ? 3 : track.views >= cut.red ? 2 : track.views >= cut.blue ? 1 : 0;
}

// The app's tiers (popularityTiers in random-folder.utils.ts): the CHOSEN split, the top MYTHIC_SHARE
// mythical, gold capped at GOLD_PER_ARTIST per lead artist. 0 base … 4 mythical.
const leadArtist = (artist) => String(artist ?? '').split(/\s*(?:,|&|\/|;|\bfeat\.?|\bft\.?|\bx\b)\s*/i)[0].trim();
const scaleCuts = new Map([...scales.keys()].map((name) => [name, cuts(scales.get(name), SPLITS[CHOSEN])]));
const appTier = new Map();
const goldCount = new Map();
for (const track of [...matched].sort((a, b) => b.views - a.views)) {
  const cut = scaleCuts.get(scaleName(track.region));
  let tier = track.views >= cut.mythic ? 4 : track.views >= cut.gold ? 3 : track.views >= cut.red ? 2 : track.views >= cut.blue ? 1 : 0;
  if (tier === 3) {
    const key = `${scaleName(track.region)}|${leadArtist(track.artist)}`;
    goldCount.set(key, (goldCount.get(key) ?? 0) + 1);
    if (goldCount.get(key) > GOLD_PER_ARTIST) tier = 2;
  }
  appTier.set(track.id, tier);
}

function quantile(sortedAsc, share) {
  return sortedAsc.length ? sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(share * sortedAsc.length) - 1))] : null;
}

const table = (head, rows) => [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n');
const lines = [];
lines.push('# Phân bố lượt xem YouTube theo vùng', '');
lines.push(`Tạo lúc ${new Date().toISOString()} từ \`${DB_PATH}\`, chỉ đọc. Gold là nhóm nhiều view nhất.`);
lines.push(`Vùng là thư mục cấp 1 dưới music root. ${[...RANKED_WITH_LIBRARY].join(', ')} xếp hạng theo thang "${LIBRARY}". Bài No match và bài chưa quét không tính vào phân vị.`, '');

lines.push('## 1. Độ phủ', '');
lines.push(table(['Vùng', 'Bài', 'Khớp', 'No match', 'Chưa quét'], [...regions, LIBRARY].map((region) => {
  const inRegion = region === LIBRARY ? tracks : tracks.filter((track) => track.region === region);
  return [region, inRegion.length, inRegion.filter((track) => track.status === 'matched').length,
    inRegion.filter((track) => track.status === 'unmatched').length, inRegion.filter((track) => !track.status).length];
})), '');

lines.push('## 2. Phân vị lượt xem', '');
lines.push(table(['Thang', 'Bài', ...PERCENTILES.map((share) => `p${Math.round(share * 100)}`), 'max'], [...scales].map(([name, scale]) => {
  const sorted = scale.map((track) => track.views).sort((a, b) => a - b);
  return [name, sorted.length, ...PERCENTILES.map((share) => views(quantile(sorted, share))), views(sorted.at(-1))];
})), '');

lines.push('## 3. Xem thử các cách chia', '');
for (const [name, split] of Object.entries(SPLITS)) {
  lines.push(`### Cách ${name}: ${split.map((share, index) => `${TIERS[index]} ${+(share * 100).toFixed(1)}%`).join(' / ')}`, '');
  lines.push(table(['Vùng', 'Mốc Gold', 'Mốc Red', 'Mốc Blue', ...TIERS], regions.map((region) => {
    const cut = cuts(scales.get(scaleName(region)), split);
    const counts = [0, 0, 0, 0];
    for (const track of matched.filter((item) => item.region === region)) counts[tierOf(track, split)]++;
    return [region + (RANKED_WITH_LIBRARY.has(region) ? ` (thang ${LIBRARY})` : ''), `≥ ${views(cut.gold)}`, `≥ ${views(cut.red)}`, `≥ ${views(cut.blue)}`, ...counts];
  })), '');
}

lines.push(`## 4. Bậc app đang dùng: cách ${CHOSEN}, Mythical top ${MYTHIC_SHARE * 100}%, Gold tối đa ${GOLD_PER_ARTIST} bài mỗi nghệ sĩ`, '');
lines.push(table(['Vùng', ...APP_TIERS], regions.map((region) => {
  const counts = [0, 0, 0, 0, 0];
  for (const track of matched.filter((item) => item.region === region)) counts[appTier.get(track.id)]++;
  return [region, ...counts];
})), '');
for (const region of regions) {
  lines.push(`### ${region}`, '');
  for (const tier of [4, 3]) {
    const picked = matched.filter((track) => track.region === region && appTier.get(track.id) === tier).sort((a, b) => b.views - a.views);
    const artists = new Set(picked.map((track) => leadArtist(track.artist))).size;
    lines.push(`**${APP_TIERS[tier]}** (${picked.length} bài, ${artists} nghệ sĩ)`, '');
    lines.push(...(picked.length ? picked.map((track) => `- ${views(track.views)} · ${track.artist ?? '?'} — ${track.title}`) : ['- (không có)']), '');
  }
}

lines.push(`## 5. Bài dưới ${SHORT_S} s (intro, interlude) theo bậc app đang dùng`, '');
const short = matched.filter((track) => Number(track.duration) < SHORT_S);
const shortCounts = [0, 0, 0, 0, 0];
for (const track of short) shortCounts[appTier.get(track.id)]++;
lines.push(table(['Bài', ...APP_TIERS], [[short.length, ...shortCounts]]), '');
const shortHigh = short.filter((track) => appTier.get(track.id) >= 1).sort((a, b) => b.views - a.views);
if (shortHigh.length) lines.push('Bài ngắn nằm trên Base:', '', ...shortHigh.map((track) => `- ${APP_TIERS[appTier.get(track.id)]} · ${views(track.views)} · ${Math.round(track.duration)} s · ${track.artist ?? '?'} — ${track.title}`), '');

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, lines.join('\n'));
console.log(`Wrote ${OUT_PATH}: ${tracks.length} tracks, ${matched.length} with views.`);
