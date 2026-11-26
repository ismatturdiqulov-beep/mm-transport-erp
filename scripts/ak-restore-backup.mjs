#!/usr/bin/env node
/**
 * Блок «Ангрен Каолин»: восстановление из ежедневного бэкапа (supabase/functions/ak-backup).
 *
 *   node scripts/ak-restore-backup.mjs <ak-backup-ГГГГ-ММ-ДД.json.enc> <ключ-base64> [выход.sql] [--json]
 *
 * Ключ — BACKUP_ENCRYPTION_KEY (тот же, что у бэкапа mm_transport; владелец хранит
 * его отдельно от Supabase). --json — дополнительно сохранить расшифрованный JSON
 * рядом (для просмотра глазами; файл с реальными данными — не публиковать).
 *
 * ИНСТРУКЦИЯ ВОССТАНОВЛЕНИЯ
 *   1. Скачать нужный файл с Яндекс Диска: Приложения → (папка приложения) → angren.
 *   2. Если база пустая (проект потерян) — сначала применить миграции:
 *        npx supabase db push --yes
 *      Если база жива и нужно вернуть отдельные строки — шаг пропустить: скрипт
 *      вставляет с «on conflict do nothing», существующие строки не трогает.
 *   3. node scripts/ak-restore-backup.mjs <файл> <ключ> restore.sql
 *   4. npx supabase db query --file restore.sql --linked
 *   5. Участники блока (ak_members) восстанавливаются только для пользователей,
 *      которые уже есть в auth.users. При полной потере проекта — сначала заново
 *      создать пользователей (Authentication → Add user), потом добавить их в
 *      ak_members SQL-ом (user_id нового пользователя, role, partner_key, display_name).
 *
 * Триггеры журнала на время восстановления отключаются (session_replication_role),
 * чтобы восстановление не задвоило журнал и не упёрлось в «остатки зафиксированы».
 * Без внешних зависимостей — только встроенные модули Node.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createDecipheriv, randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const wantJson = args.includes('--json');
const [backupPath, keyB64, outArg] = args.filter((a) => a !== '--json');
if (!backupPath || !keyB64) {
  console.error('Использование: node scripts/ak-restore-backup.mjs <файл.json.enc> <ключ-base64> [выход.sql] [--json]');
  process.exit(1);
}
const outPath = outArg || backupPath.replace(/\.json\.enc$/i, '') + '.sql';

// ---------- расшифровка (12 байт IV | шифротекст | 16 байт тега) ----------
const buf = readFileSync(backupPath);
const key = Buffer.from(keyB64, 'base64');
if (key.length !== 32) {
  console.error(`Ключ должен быть 32 байта в base64, получено ${key.length} — проверьте, что скопирован целиком.`);
  process.exit(1);
}
let payload;
try {
  const iv = buf.subarray(0, 12);
  const rest = buf.subarray(12);
  const d = createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(rest.subarray(rest.length - 16));
  payload = JSON.parse(Buffer.concat([d.update(rest.subarray(0, rest.length - 16)), d.final()]).toString('utf8'));
} catch (e) {
  console.error('Не удалось расшифровать — неверный ключ или файл повреждён.', e.message);
  process.exit(1);
}
if (payload.block !== 'angren') {
  console.error('Это не бэкап блока «Ангрен Каолин» (для mm_transport — scripts/restore-backup.mjs).');
  process.exit(1);
}
console.log('Бэкап создан:', payload.generated_at);
if (wantJson) writeFileSync(outPath.replace(/\.sql$/i, '') + '.json', JSON.stringify(payload, null, 2));

// ---------- SQL ----------
// Порядок — родители раньше детей. Таблицы, которых здесь нет (новые этапы), идут в конце
// по алфавиту; если у новой таблицы есть внешние ключи — допишите её сюда в нужное место.
const ORDER = ['ak_wallets', 'ak_carriers', 'ak_vehicles', 'ak_vehicle_owners', 'ak_routes', 'ak_directors',
  'ak_opening_balances', 'ak_settings', 'ak_members', 'ak_audit_log'];
// Вычисляемые столбцы (generated always) — вставлять нельзя, база посчитает сама.
const GENERATED = { ak_vehicles: ['plate_norm'] };
const SERIAL = { ak_audit_log: 'id' };

const tables = payload.tables || {};
const names = [...ORDER.filter((t) => t in tables), ...Object.keys(tables).filter((t) => !ORDER.includes(t)).sort()];
const tag = '$ak' + randomBytes(6).toString('hex') + '$';
const ident = (s) => '"' + s.replace(/"/g, '""') + '"';

const out = ['-- Восстановление блока «Ангрен Каолин» из бэкапа ' + payload.generated_at, 'begin;',
  'set local session_replication_role = replica;'];
for (const t of names) {
  const rows = tables[t];
  if (!rows.length) { out.push(`-- ${t}: пусто`); continue; }
  const cols = Object.keys(rows[0]).filter((c) => !(GENERATED[t] || []).includes(c)).map(ident).join(', ');
  const json = JSON.stringify(rows);
  if (json.includes(tag)) throw new Error('совпадение тега кавычек — запустите ещё раз');
  const where = t === 'ak_members' ? ' where exists (select 1 from auth.users u where u.id = x.user_id)' : '';
  out.push(`-- ${t}: ${rows.length}`);
  out.push(`insert into ${ident(t)} (${cols}) select ${cols} from jsonb_populate_recordset(null::${ident(t)}, ${tag}${json}${tag}::jsonb) x${where} on conflict do nothing;`);
  if (SERIAL[t]) out.push(`select setval(pg_get_serial_sequence('${t}', '${SERIAL[t]}'), greatest((select max(${SERIAL[t]}) from ${ident(t)}), 1));`);
}
out.push('commit;');
writeFileSync(outPath, out.join('\n') + '\n');
console.log('Готово:', outPath);
for (const t of names) console.log(`  ${t}: ${tables[t].length}`);
