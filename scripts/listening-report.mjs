// Developer report: how Smart Shuffle is doing, from the listening history (play_events). Reads the app
// database read-only. The report is written in Vietnamese for the working notes in plan/.
// Usage: node scripts/listening-report.mjs [path/to/lutstra.sqlite] [out.md]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_PATH = process.argv[2] ?? path.join(process.env.APPDATA ?? '', 'Lutstra', 'lutstra.sqlite');
const OUT_PATH = process.argv[3] ?? path.join('plan', 'reports', 'listening-report.md');
const DAY = 86_400_000;
const EARLY_SECONDS = 30;

const db = new DatabaseSync(DB_PATH, { readOnly: true });
if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='play_events'").get()) {
  console.error('No play_events table yet: open the app once with the listening history.');
  process.exit(1);
}
const events = db.prepare('SELECT * FROM play_events ORDER BY started_at, id').all();
const libraryCount = Number(db.prepare('SELECT COUNT(*) AS n FROM tracks WHERE is_available = 1').get().n);
const titles = new Map(db.prepare('SELECT id, title, artist FROM tracks').all().map((row) => [row.id, `${row.title} — ${row.artist ?? '?'}`]));
const now = Date.now();

const percent = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : '—';
const played = (event) => event.end_reason !== 'removed';
const through = (event) => event.end_reason === 'ended' || (event.duration > 0 && event.played_seconds / event.duration >= 0.8);
const early = (event) => event.end_reason === 'removed' || (event.end_reason === 'skip_next' && event.played_seconds < EARLY_SECONDS);

function sourceRow(label, rows) {
  return `| ${label} | ${rows.length} | ${percent(rows.filter(through).length, rows.length)} | ${percent(rows.filter(early).length, rows.length)} |`;
}

const lines = [
  '# Báo cáo lịch sử nghe (Smart Shuffle)',
  '',
  `Tạo lúc ${new Date(now).toISOString()} từ \`${DB_PATH}\`, chỉ đọc. ${events.length} lượt ghi nhận.`,
  '',
  '## 1. Theo nguồn',
  '',
  'Nghe hết: hết bài hoặc nghe từ 80% trở lên. Skip sớm: Next trong 30 giây đầu, hoặc bài gợi ý bị xóa khỏi queue.',
  '',
  '| Nguồn | Lượt | Nghe hết | Skip sớm |',
  '|---|---|---|---|',
];
for (const [label, source] of [['Bài của bạn (queue)', 'queue'], ['Bài gợi ý (Smart Shuffle)', 'smart-shuffle'], ['Roulette', 'roulette']]) {
  lines.push(sourceRow(label, events.filter((event) => event.source === source)));
}

lines.push('', '## 2. Bài gợi ý theo tuần', '', 'Tỉ lệ skip sớm của bài gợi ý nên giảm dần khi Smart Shuffle học được gu.', '',
  '| Tuần bắt đầu | Lượt gợi ý | Nghe hết | Skip sớm |', '|---|---|---|---|');
const weeks = new Map();
for (const event of events.filter((item) => item.source === 'smart-shuffle')) {
  const start = new Date(event.started_at);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const key = start.toISOString().slice(0, 10);
  weeks.set(key, [...(weeks.get(key) ?? []), event]);
}
for (const [week, rows] of weeks) lines.push(sourceRow(week, rows));
if (!weeks.size) lines.push('| — | 0 | — | — |');

const recent = events.filter((event) => played(event) && event.played_seconds > 0 && now - event.started_at <= 30 * DAY);
const covered = new Set(recent.map((event) => event.track_id));
const byTrack = new Map();
for (const event of events.filter((item) => played(item) && item.played_seconds >= EARLY_SECONDS)) {
  byTrack.set(event.track_id, [...(byTrack.get(event.track_id) ?? []), event.started_at]);
}
let repeats = 0;
let listens = 0;
for (const starts of byTrack.values()) {
  listens += starts.length;
  for (let i = 1; i < starts.length; i++) if (starts[i] - starts[i - 1] < 3 * DAY) repeats++;
}
lines.push('', '## 3. Độ đổi mới', '',
  `- **Độ phủ 30 ngày:** ${covered.size} / ${libraryCount} bài được phát (${percent(covered.size, libraryCount)}).`,
  `- **Lặp trong 3 ngày:** ${repeats} / ${listens} lượt nghe (từ 30 giây) là bài đã nghe trong 3 ngày trước đó (${percent(repeats, listens)}).`);

const removed = events.filter((event) => event.end_reason === 'removed').slice(-10).reverse();
lines.push('', '## 4. Bài gợi ý bị xóa gần đây', '');
lines.push(...(removed.length ? removed.map((event) => `- ${titles.get(event.track_id) ?? event.track_id} (${new Date(event.started_at).toLocaleString('vi-VN')})`) : ['- Chưa có.']));
lines.push('');

mkdirSync(path.dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, lines.join('\n'));
console.log('Wrote', OUT_PATH);
