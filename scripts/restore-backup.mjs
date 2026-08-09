#!/usr/bin/env node
/**
 * Расшифровывает и превращает файл ежедневного бэкапа (см. supabase/functions/db-backup)
 * в SQL-файл с INSERT'ами — для восстановления данных ОДНОЙ компании или всех сразу.
 *
 * Использование:
 *   node scripts/restore-backup.mjs <backup-YYYY-MM-DD.json.enc> <ключ-base64> [company_id] [output.sql]
 *
 * Ключ — тот самый BACKUP_ENCRYPTION_KEY, который пользователь хранит отдельно от
 * Supabase (без него расшифровать нечем — см. комментарий в db-backup/index.ts).
 * company_id — необязательно; если не указан, восстанавливаются ВСЕ компании из файла.
 *
 * Дальше применить результат:
 *   npx supabase db query --file output.sql --linked
 *   (или отдельными кусками, если файл большой — см. известную особенность в CLAUDE.md:
 *   один SQL-запрос за раз надёжнее, чем всё одним вызовом)
 *
 * profiles (учётные записи пользователей) НАРОЧНО не восстанавливаются этим скриптом —
 * profiles.id ссылается на auth.users, которого при полной потере проекта тоже не будет;
 * восстановление пользователей — отдельная ручная операция (создать auth-пользователя,
 * потом profiles), не блокирующая восстановление самих бизнес-данных.
 *
 * Без внешних зависимостей — только встроенные модули Node (как и migrate-data.mjs).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';

const [, , backupPath, keyB64, arg3, arg4] = process.argv;
if (!backupPath || !keyB64) {
  console.error('Использование: node scripts/restore-backup.mjs <backup.json.enc> <ключ-base64> [company_id] [output.sql]');
  process.exit(1);
}
// company_id — это uuid (содержит дефисы), в отличие от пути к выходному .sql файлу
const companyIdArg = arg3 && /^[0-9a-f-]{36}$/i.test(arg3) ? arg3 : null;
const outputPath = (companyIdArg ? arg4 : arg3) || backupPath.replace(/\.json\.enc$/i, '') + '.sql';

// ---------------------------------------------------------------- расшифровка --
const fileBuf = readFileSync(backupPath);
const iv = fileBuf.subarray(0, 12);
const rest = fileBuf.subarray(12);
const authTag = rest.subarray(rest.length - 16);
const ciphertext = rest.subarray(0, rest.length - 16);
const key = Buffer.from(keyB64, 'base64');
if (key.length !== 32) {
  console.error(`Ключ должен быть 32 байта (256 бит) в base64, получено ${key.length} байт — проверьте, что скопировали ключ целиком.`);
  process.exit(1);
}
let payload;
try {
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  payload = JSON.parse(plain.toString('utf8'));
} catch (e) {
  console.error('Не удалось расшифровать файл — неверный ключ или файл повреждён.', e.message);
  process.exit(1);
}

console.log('Бэкап создан:', payload.generated_at);
const allCompanyIds = Object.keys(payload.companies || {});
const companyIds = companyIdArg ? [companyIdArg] : allCompanyIds;
if (companyIdArg && !allCompanyIds.includes(companyIdArg)) {
  console.error(`В этом бэкапе нет компании ${companyIdArg}. Доступные: ${allCompanyIds.join(', ')}`);
  process.exit(1);
}
console.log(`Восстанавливаем ${companyIds.length} компани${companyIds.length === 1 ? 'ю' : 'й'} из ${allCompanyIds.length} в файле.`);

// ---------------------------------------------------------------- генерация SQL --
// Порядок важен — таблицы позже в списке ссылаются на таблицы раньше в списке
// (внешние ключи), иначе INSERT упадёт с ошибкой "нет такой записи-родителя".
const TABLE_ORDER = [
  'companies', 'company_settings', 'kontragenty', 'people', 'person_docs', 'transport', 'fleet',
  'trips', 'trip_legs', 'trip_expenses', 'trip_payments', 'trip_surcharges', 'tirs', 'dozv',
  'doz_planned', 'finance', 'maintenance', 'kassa_wallets', 'kassa', 'waybills', 'poa', 'labor',
  'telegram_links', 'driver_messages', 'notification_log',
  // 'profiles' — намеренно не восстанавливается, см. комментарий в шапке файла.
];

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

const lines = [];
lines.push(`-- Восстановлено из ${backupPath} (бэкап от ${payload.generated_at})`);
lines.push(`-- Компании: ${companyIds.join(', ')}`);
lines.push('begin;');

let totalRows = 0;
for (const table of TABLE_ORDER) {
  const rowsForTable = [];
  for (const cid of companyIds) {
    const bucket = payload.companies[cid] || {};
    rowsForTable.push(...(bucket[table] || []));
  }
  if (!rowsForTable.length) continue;
  lines.push(`-- ${table}: ${rowsForTable.length} строк`);
  for (const row of rowsForTable) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => sqlValue(row[c]));
    // ON CONFLICT DO NOTHING без указания колонки — работает по ЛЮБОМУ уникальному
    // ограничению таблицы, а не только по "id" (у company_settings, например, ключ —
    // company_id, а не id вообще; баг найден и исправлен сразу при первом же реальном
    // тестовом прогоне скрипта, 2026-08-10). Если строка уже есть (восстанавливаем
    // поверх частично уцелевшей базы) — просто не перезаписываем её молча.
    lines.push(`insert into ${table} (${cols.join(', ')}) values (${vals.join(', ')}) on conflict do nothing;`);
    totalRows++;
  }
}
lines.push('commit;');

writeFileSync(outputPath, lines.join('\n') + '\n', 'utf8');
console.log(`Готово: ${totalRows} строк → ${outputPath}`);
console.log('Применить: npx supabase db query --file ' + outputPath + ' --linked');
