// MM Transport ERP — ежедневный зашифрованный бэкап на Яндекс Диск (Edge Function)
// (2026-08-10). Решение пользователя: страховка на случай потери/блокировки самого
// проекта Supabase — копия должна лежать ЗА пределами Supabase, поэтому файл
// шифруется и загружается на Яндекс Диск (папка приложения), а не просто
// складывается в Supabase Storage.
//
// Две точки входа через query-параметр ?mode=:
//   ?mode=run   (по умолчанию) — реально снять бэкап, зашифровать, залить, почистить
//                старые файлы по правилам хранения, уведомить владельца.
//   ?mode=check — "сторож": ничего не бэкапит, просто проверяет backup_log — если
//                последний успешный запуск был больше 30 часов назад, шлёт тревогу.
//                Нужен отдельно от ?mode=run, потому что если сама функция бэкапа
//                перестанет запускаться вообще (например сломался cron), ?mode=run
//                просто не выполнится — а ?mode=check вызывается ДРУГИМ, независимым
//                расписанием и это заметит.
//
// Формат зашифрованного файла: первые 12 байт — IV (nonce) для AES-256-GCM, дальше —
// шифротекст (тег аутентичности уже включён в него самим Web Crypto API). Ключ —
// BACKUP_ENCRYPTION_KEY, 32 байта в base64, пользователь хранит свою копию отдельно
// от Supabase (иначе при потере Supabase расшифровать нечем).

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const YANDEX_DISK_TOKEN = Deno.env.get('YANDEX_DISK_TOKEN')!;
const BACKUP_ENCRYPTION_KEY = Deno.env.get('BACKUP_ENCRYPTION_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Полный список бизнес-таблиц — тот же набор, что читает сам сайт при входе
// (см. loadAllData() в index.html), плюс profiles/notification_log для полноты.
const TABLES = [
  'companies', 'company_settings', 'kontragenty', 'people', 'person_docs', 'transport', 'fleet',
  'trips', 'trip_legs', 'trip_expenses', 'trip_payments', 'trip_surcharges', 'tirs', 'dozv',
  'doz_planned', 'finance', 'kassa', 'kassa_wallets', 'maintenance', 'waybills', 'poa', 'labor',
  'telegram_links', 'driver_messages', 'notification_log', 'profiles',
];

async function tg(method: string, payload: any) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function notifyOwners(text: string) {
  const { data: recipients } = await supabase.from('owner_notify').select('chat_id');
  for (const r of recipients || []) {
    await tg('sendMessage', { chat_id: r.chat_id, text, parse_mode: 'HTML' });
  }
}

async function importKey(): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(BACKUP_ENCRYPTION_KEY), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt']);
}

async function encrypt(json: string): Promise<Uint8Array> {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(json);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

// Собирает все таблицы и раскладывает по компаниям — дочерние таблицы (нет своего
// company_id) распределяются через компанию их родителя (trip_legs → trips,
// person_docs → people), чтобы при восстановлении можно было взять данные ровно
// ОДНОЙ компании, не трогая остальные (решение пользователя 2026-08-04/08-10).
async function buildBackupPayload() {
  const byTable: Record<string, any[]> = {};
  for (const t of TABLES) {
    const { data, error } = await supabase.from(t).select('*');
    if (error) throw new Error(`Не удалось прочитать таблицу ${t}: ${error.message}`);
    byTable[t] = data || [];
  }

  const tripCompany = new Map<string, string>();
  (byTable.trips || []).forEach((r: any) => tripCompany.set(r.id, r.company_id));
  const personCompany = new Map<string, string>();
  (byTable.people || []).forEach((r: any) => personCompany.set(r.id, r.company_id));

  const companyIds = new Set<string>((byTable.companies || []).map((c: any) => c.id));
  const perCompany: Record<string, Record<string, any[]>> = {};
  const ensure = (cid: string) => {
    if (!perCompany[cid]) perCompany[cid] = {};
    return perCompany[cid];
  };
  companyIds.forEach((cid) => ensure(cid));

  const directTables = TABLES.filter((t) => !['trip_legs', 'trip_expenses', 'trip_payments', 'trip_surcharges', 'person_docs'].includes(t));
  for (const t of directTables) {
    for (const row of byTable[t] || []) {
      const cid = row.company_id;
      if (!cid) continue; // строки без компании (например profiles владельца) в бэкап по компаниям не попадают
      ensure(cid)[t] = ensure(cid)[t] || [];
      ensure(cid)[t].push(row);
    }
  }
  for (const t of ['trip_legs', 'trip_expenses', 'trip_payments', 'trip_surcharges']) {
    for (const row of byTable[t] || []) {
      const cid = tripCompany.get(row.trip_id);
      if (!cid) continue;
      ensure(cid)[t] = ensure(cid)[t] || [];
      ensure(cid)[t].push(row);
    }
  }
  for (const row of byTable.person_docs || []) {
    const cid = personCompany.get(row.person_id);
    if (!cid) continue;
    ensure(cid).person_docs = ensure(cid).person_docs || [];
    ensure(cid).person_docs.push(row);
  }

  return {
    generated_at: new Date().toISOString(),
    format_version: 1,
    companies: perCompany,
  };
}

async function yandexUploadUrl(path: string): Promise<string> {
  const resp = await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources/upload?path=${encodeURIComponent(path)}&overwrite=true`,
    { headers: { Authorization: `OAuth ${YANDEX_DISK_TOKEN}` } }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Яндекс Диск (upload url): ${json.message || JSON.stringify(json)}`);
  return json.href;
}

async function yandexUpload(path: string, bytes: Uint8Array) {
  const href = await yandexUploadUrl(path);
  const resp = await fetch(href, { method: 'PUT', body: bytes });
  if (!resp.ok && resp.status !== 201) throw new Error(`Яндекс Диск (upload): HTTP ${resp.status}`);
}

async function yandexList(): Promise<{ name: string }[]> {
  const resp = await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources?path=app:/&limit=500`,
    { headers: { Authorization: `OAuth ${YANDEX_DISK_TOKEN}` } }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(`Яндекс Диск (list): ${json.message || JSON.stringify(json)}`);
  return (json._embedded?.items || []).map((i: any) => ({ name: i.name }));
}

async function yandexDelete(name: string) {
  await fetch(
    `https://cloud-api.yandex.net/v1/disk/resources?path=${encodeURIComponent('app:/' + name)}&permanently=true`,
    { method: 'DELETE', headers: { Authorization: `OAuth ${YANDEX_DISK_TOKEN}` } }
  );
}

// Хранение: ежедневные — 60 дней, снимки на 1-е число месяца — всегда (решение
// пользователя 2026-08-09).
async function applyRetention() {
  const files = await yandexList();
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 60);
  for (const f of files) {
    const m = /^backup-(\d{4})-(\d{2})-(\d{2})\.json\.enc$/.exec(f.name);
    if (!m) continue;
    const fileDate = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
    const isFirstOfMonth = m[3] === '01';
    if (!isFirstOfMonth && fileDate < cutoff) {
      await yandexDelete(f.name);
    }
  }
}

async function runBackup(): Promise<Response> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const fileName = `backup-${dateStr}.json.enc`;
  try {
    const payload = await buildBackupPayload();
    const json = JSON.stringify(payload);
    const encrypted = await encrypt(json);
    await yandexUpload(`app:/${fileName}`, encrypted);
    await applyRetention();
    await supabase.from('backup_log').insert({ status: 'success', file_name: fileName, detail: `${(encrypted.length / 1024).toFixed(1)} КБ` });
    await notifyOwners(`✅ Бэкап от ${dateStr} создан и загружен на Яндекс Диск (${(encrypted.length / 1024).toFixed(1)} КБ).`);
    return new Response(JSON.stringify({ ok: true, fileName }), { status: 200 });
  } catch (e: any) {
    const msg = e?.message || String(e);
    await supabase.from('backup_log').insert({ status: 'error', file_name: fileName, detail: msg });
    await notifyOwners(`⚠️ Бэкап от ${dateStr} НЕ УДАЛСЯ.\nОшибка: ${msg}`);
    return new Response(JSON.stringify({ ok: false, error: msg }), { status: 500 });
  }
}

async function runCheck(): Promise<Response> {
  const { data: last } = await supabase
    .from('backup_log')
    .select('run_at, status')
    .eq('status', 'success')
    .order('run_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const hoursSince = last ? (Date.now() - new Date(last.run_at).getTime()) / 3600000 : Infinity;
  if (hoursSince > 30) {
    const when = last ? `${Math.round(hoursSince)} ч. назад` : 'ни разу не было';
    await notifyOwners(`🚨 Внимание: последний успешный бэкап был ${when}. Проверьте систему резервного копирования.`);
  }
  return new Response(JSON.stringify({ ok: true, hoursSinceLastSuccess: hoursSince }), { status: 200 });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (CRON_SECRET) {
    const provided = req.headers.get('x-cron-secret');
    if (provided !== CRON_SECRET) return new Response('Unauthorized', { status: 401 });
  }
  const url = new URL(req.url);
  const mode = url.searchParams.get('mode') || 'run';
  return mode === 'check' ? await runCheck() : await runBackup();
});
