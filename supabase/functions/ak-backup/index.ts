// Блок «Ангрен Каолин» — ежедневный зашифрованный бэкап на Яндекс Диск (2026-11-26).
//
// Отдельная функция, не зависит от бэкапа mm_transport (db-backup): своя папка
// app:/angren/, свой журнал ak_backup_log, свой список получателей уведомлений
// (ak_settings 'notify' → { chat_ids: [...] }). Данные mm_transport не читает.
//
//   ?mode=run   — снять бэкап всех таблиц ak_*, зашифровать, загрузить, почистить старые.
//   ?mode=check — сторож: если успешного бэкапа не было > 30 ч — тревога.
//
// Формат файла: 12 байт IV + шифротекст AES-256-GCM (тег в конце) — тот же, что у
// db-backup, ключ тот же BACKUP_ENCRYPTION_KEY (один ключ хранить проще владельцу).
// Внутри — JSON { block: 'angren', format_version: 1, generated_at, tables: {имя: [строки]} }.
// Восстановление — scripts/ak-restore-backup.mjs.

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const YANDEX_DISK_TOKEN = Deno.env.get('YANDEX_DISK_TOKEN')!;
const BACKUP_ENCRYPTION_KEY = Deno.env.get('BACKUP_ENCRYPTION_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const FOLDER = 'app:/angren';
const PAGE = 1000; // PostgREST отдаёт не больше 1000 строк за запрос — читаем страницами
// Ключ сортировки для постраничного чтения (стабильный порядок).
const ORDER_KEY: Record<string, string> = {
  ak_settings: 'key', ak_members: 'user_id', ak_fx_rates: 'rate_date', ak_counters: 'series', ak_expense_requests: 'expense_id',
};
// ВАЖНО: у новой таблицы без столбца id — добавьте её сюда, иначе бэкап упадёт (сторож предупредит).

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function notify(text: string) {
  const { data } = await supabase.from('ak_settings').select('value').eq('key', 'notify').maybeSingle();
  for (const chatId of data?.value?.chat_ids || []) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  }
}

async function encrypt(json: string): Promise<Uint8Array> {
  const raw = Uint8Array.from(atob(BACKUP_ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(json)));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

// С повтором: первый запрос ночью иногда ловит остывший пул (см. db-backup).
async function withRetry<T>(what: string, fn: () => Promise<{ data: T | null; error: any }>): Promise<T> {
  let last: any;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await fn();
    if (!error) return data as T;
    last = error;
    await sleep(1500 * (i + 1));
  }
  throw new Error(`${what}: ${last?.message || last}`);
}

async function fetchTable(t: string): Promise<any[]> {
  const rows: any[] = [];
  const order = ORDER_KEY[t] || 'id';
  for (let from = 0; ; from += PAGE) {
    const page = await withRetry<any[]>(`таблица ${t}`, () =>
      supabase.from(t).select('*').order(order).range(from, from + PAGE - 1) as any);
    rows.push(...(page || []));
    if (!page || page.length < PAGE) return rows;
  }
}

async function buildPayload() {
  const names = await withRetry<string[]>('список таблиц', () => supabase.rpc('ak_backup_tables') as any);
  const tables: Record<string, any[]> = {};
  for (const t of names) tables[t] = await fetchTable(t);
  return { block: 'angren', format_version: 1, generated_at: new Date().toISOString(), tables };
}

const yd = (path: string, init: RequestInit = {}) =>
  fetch(`https://cloud-api.yandex.net/v1/disk/resources${path}`, {
    ...init,
    headers: { Authorization: `OAuth ${YANDEX_DISK_TOKEN}`, ...(init.headers || {}) },
  });

async function ensureFolder() {
  const r = await yd(`?path=${encodeURIComponent(FOLDER)}`, { method: 'PUT' });
  if (!r.ok && r.status !== 409) throw new Error(`Яндекс Диск (папка): HTTP ${r.status}`);
}

async function upload(name: string, bytes: Uint8Array) {
  const r = await yd(`/upload?path=${encodeURIComponent(`${FOLDER}/${name}`)}&overwrite=true`);
  const j = await r.json();
  if (!r.ok) throw new Error(`Яндекс Диск (upload url): ${j.message || JSON.stringify(j)}`);
  const put = await fetch(j.href, { method: 'PUT', body: bytes });
  if (!put.ok && put.status !== 201) throw new Error(`Яндекс Диск (upload): HTTP ${put.status}`);
}

// Хранение как у mm_transport: ежедневные — 60 дней, снимки 1-го числа — всегда.
async function retention() {
  const r = await yd(`?path=${encodeURIComponent(FOLDER)}&limit=1000`);
  const j = await r.json();
  if (!r.ok) throw new Error(`Яндекс Диск (list): ${j.message || JSON.stringify(j)}`);
  const cutoff = Date.now() - 60 * 86400000;
  for (const f of j._embedded?.items || []) {
    const m = /^ak-backup-(\d{4})-(\d{2})-(\d{2})\.json\.enc$/.exec(f.name);
    if (!m || m[3] === '01') continue;
    if (new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime() < cutoff) {
      await yd(`?path=${encodeURIComponent(`${FOLDER}/${f.name}`)}&permanently=true`, { method: 'DELETE' });
    }
  }
}

async function runBackup(): Promise<Response> {
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tashkent' });
  const fileName = `ak-backup-${date}.json.enc`;
  try {
    const payload = await buildPayload();
    const counts = Object.entries(payload.tables).map(([t, r]) => `${t.replace(/^ak_/, '')}: ${r.length}`).join(', ');
    const enc = await encrypt(JSON.stringify(payload));
    await ensureFolder();
    await upload(fileName, enc);
    await retention();
    const size = `${(enc.length / 1024).toFixed(1)} КБ`;
    await supabase.from('ak_backup_log').insert({ status: 'success', file_name: fileName, detail: `${size}; ${counts}` });
    await notify(`✅ Ангрен Каолин: бэкап от ${date} загружен на Яндекс Диск (${size}).`);
    return Response.json({ ok: true, fileName, size, counts });
  } catch (e: any) {
    const msg = e?.message || String(e);
    await supabase.from('ak_backup_log').insert({ status: 'error', file_name: fileName, detail: msg });
    await notify(`⚠️ Ангрен Каолин: бэкап от ${date} НЕ УДАЛСЯ.\nОшибка: ${msg}`);
    return Response.json({ ok: false, error: msg }, { status: 500 });
  }
}

async function runCheck(): Promise<Response> {
  const { data: last } = await supabase.from('ak_backup_log').select('run_at')
    .eq('status', 'success').order('run_at', { ascending: false }).limit(1).maybeSingle();
  const hours = last ? (Date.now() - new Date(last.run_at).getTime()) / 3600000 : Infinity;
  if (hours > 30) {
    await notify(`🚨 Ангрен Каолин: последний успешный бэкап был ${last ? Math.round(hours) + ' ч. назад' : 'ни разу'}. Проверьте резервное копирование.`);
  }
  return Response.json({ ok: true, hoursSinceLastSuccess: hours });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (!CRON_SECRET || req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }
  const mode = new URL(req.url).searchParams.get('mode') || 'run';
  return mode === 'check' ? await runCheck() : await runBackup();
});
