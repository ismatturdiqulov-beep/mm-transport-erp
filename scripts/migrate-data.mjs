#!/usr/bin/env node
/**
 * Преобразует JSON-экспорт localStorage (см. scripts/export-localstorage.js)
 * в SQL-файл с INSERT'ами под схему supabase/migrations/0001_init.sql + 0002_extend_fields.sql.
 *
 * Использование:
 *   node scripts/migrate-data.mjs mm_transport_export_....json [output.sql]
 *
 * Затем применить результат, например:
 *   supabase db execute -f output.sql
 *   (или psql "$DATABASE_URL" -f output.sql)
 *
 * Без внешних зависимостей — только встроенные модули Node.
 *
 * Важные допущения (см. также комментарии в 0002_extend_fields.sql):
 * - id — исходные genId()-строки заменяются на новые uuid (crypto.randomUUID()),
 *   связи между таблицами перекладываются через карты соответствия ids.
 * - tirs.person / dozv.person в приложении — это ИМЯ, а не ссылка на people/kontragenty.
 *   Скрипт пытается сопоставить его с people.name или kontragenty.name (без учёта регистра
 *   и лишних пробелов). Если совпадение не найдено (например, служебное значение "(Рейс)"
 *   или расхождение в написании ФИО) — person_id остаётся NULL, а сырой текст сохраняется
 *   в person_name. Все несопоставленные значения выводятся в консоль в конце работы скрипта
 *   для ручной проверки — это НЕ ошибка миграции, а список для ревью человеком.
 * - trip.legs[]/expenses[]/payments[]/surcharges[] разворачиваются в отдельные таблицы;
 *   surcharges.legIdx и payments.legIdx — это индекс в массиве legs исходного рейса,
 *   а не uuid, поэтому маппятся позиционно.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [, , inputPath, outputPathArg] = process.argv;
if (!inputPath) {
  console.error('Использование: node scripts/migrate-data.mjs <export.json> [output.sql]');
  process.exit(1);
}
const outputPath = outputPathArg || inputPath.replace(/\.json$/i, '') + '.sql';

const raw = JSON.parse(readFileSync(inputPath, 'utf8'));
const data = raw.data || raw; // допускаем и «сырой» дамп без обёртки {exportedAt, data}

const get = (key) => data[key] || [];

const srcKontragenty = get('mm_kontragenty_v2');
const srcPeople      = get('mm_people_v2');
const srcTransport   = get('mm_transport');
const srcFleet       = get('mm_fleet_v2');
const srcTrips       = get('mm_trips');
const srcTirs        = get('mm_tirs');
const srcDozv        = get('mm_dozv');
const srcFinance     = get('mm_finance_v2');
const srcKassa       = get('mm_kassa');
const srcKassaWallets= get('mm_kassa_wallets');
const srcMaintenance = get('mm_maintenance');
const srcWaybills    = get('mm_waybills');
const srcPoa         = get('mm_poa');
const srcLabor       = get('mm_labor');

// ---------------------------------------------------------------- id maps --
const idMap = new Map(); // `${type}:${oldId}` -> new uuid
function mapId(type, oldId) {
  if (oldId === undefined || oldId === null || oldId === '') return null;
  const key = `${type}:${oldId}`;
  if (!idMap.has(key)) idMap.set(key, randomUUID());
  return idMap.get(key);
}
function lookupId(type, oldId) {
  if (oldId === undefined || oldId === null || oldId === '') return null;
  return idMap.get(`${type}:${oldId}`) || null;
}

const companyId = randomUUID();

// ------------------------------------------------------------- sql helpers --
const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const str  = (v) => (v === undefined || v === null || v === '') ? 'NULL' : esc(v);
const num  = (v) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v))) ? 'NULL' : String(Number(v));
const bool = (v) => (v === undefined || v === null) ? 'NULL' : (v ? 'true' : 'false');
const dt   = (v) => (!v) ? 'NULL' : esc(v);                 // 'YYYY-MM-DD' проходит как есть
const uid  = (v) => v ? esc(v) : 'NULL';
const jsonb= (v) => (v === undefined || v === null) ? 'NULL' : esc(JSON.stringify(v)) + '::jsonb';

const out = [];
out.push('-- Автосгенерировано scripts/migrate-data.mjs — не редактировать вручную.');
out.push(`-- Источник экспорта: ${inputPath}`);
out.push('begin;');
out.push('');

const rowCounts = {}; // table -> count, для честного summary в консоли

function insertRows(table, columns, rows) {
  if (!rows.length) return;
  rowCounts[table] = (rowCounts[table] || 0) + rows.length;
  out.push(`insert into ${table} (${columns.join(', ')}) values`);
  out.push(rows.map((r, i) => '  (' + r.join(', ') + ')' + (i === rows.length - 1 ? ';' : ',')).join('\n'));
  out.push('');
}

const unresolvedPersons = new Set();

function resolvePerson(nameRaw) {
  const name = (nameRaw || '').trim();
  if (!name) return { personId: null, kontragentId: null };
  const norm = name.toLowerCase();
  const person = srcPeople.find(p => (p.name || '').trim().toLowerCase() === norm);
  if (person) return { personId: lookupId('person', person.id), kontragentId: null };
  const kontragent = srcKontragenty.find(k => (k.name || '').trim().toLowerCase() === norm || (k.short || '').trim().toLowerCase() === norm);
  if (kontragent) return { personId: null, kontragentId: lookupId('kontragent', kontragent.id) };
  unresolvedPersons.add(name);
  return { personId: null, kontragentId: null };
}

// pre-register ids so forward references (e.g. trip_id set on tirs/dozv) work regardless of insert order
srcKontragenty.forEach(k => mapId('kontragent', k.id));
srcPeople.forEach(p => mapId('person', p.id));
srcTransport.forEach(t => mapId('transport', t.id));
srcFleet.forEach(f => mapId('fleet', f.id));
srcTrips.forEach(t => mapId('trip', t.id));

// reverse maps: старый id ТИР/дозвола -> старый id рейса (из trip.tirIds[]/dozvIds[])
const tirTripOldId = new Map();
const dozvTripOldId = new Map();
srcTrips.forEach(t => {
  (t.tirIds || []).forEach(tid => tirTripOldId.set(tid, t.id));
  (t.dozvIds || []).forEach(did => dozvTripOldId.set(did, t.id));
});

// ---------------------------------------------------------------- companies --
insertRows('companies', ['id', 'name'], [[uid(companyId), str('MM Transport')]]);

// в приложении тип водителя ММ хранится как 'mm', а схема (по ТЗ) ожидает 'driver_mm'
const KONTRAGENT_TYPE_MAP = { mm: 'driver_mm' };
const mapKontragentType = (t) => KONTRAGENT_TYPE_MAP[t] || t;

// --------------------------------------------------------------- kontragenty --
insertRows('kontragenty',
  ['id','company_id','name','short','type','phone','passport','pinfl','active','contract_num','contract_date','contract_end','note','ops'],
  srcKontragenty.map(k => [
    uid(mapId('kontragent', k.id)), uid(companyId), str(k.name), str(k.short), str(mapKontragentType(k.type)),
    str(k.phone), str(k.passport), str(k.pinfl), bool(k.active ?? true),
    str(k.contract_num), dt(k.contract_date), dt(k.contract_end), str(k.note), jsonb(k.ops),
  ]));

// ------------------------------------------------------------------ people --
insertRows('people',
  ['id','company_id','kontragent_id','name','short','pinfl','birth','phone','passport','address','active','note'],
  srcPeople.map(p => [
    uid(mapId('person', p.id)), uid(companyId), uid(lookupId('kontragent', p.kontragentId)),
    str(p.name), str(p.short), str(p.pinfl), dt(p.birth), str(p.phone), str(p.passport),
    str(p.address), bool(p.active ?? true), str(p.note),
  ]));

// -------------------------------------------------------------- person_docs --
const DOC_TYPE_LABELS = { pass:'passport', inter:'international_passport', lic:'driver_license', mnp:'mnp', tacho:'tachograph_card', adr:'adr_cert' };
{
  const rows = [];
  srcPeople.forEach(p => {
    const docs = p.docs || {};
    Object.entries(DOC_TYPE_LABELS).forEach(([key, label]) => {
      const d = docs[key];
      if (!d || (!d.num && !d.from && !d.to && !d.org)) return;
      rows.push([
        uid(randomUUID()), uid(mapId('person', p.id)), str(label), str(d.num),
        dt(d.from), dt(d.to), str(d.org),
      ]);
    });
  });
  insertRows('person_docs', ['id','person_id','doc_type','doc_number','issued','expires','note'], rows);
}

// --------------------------------------------------------------- transport --
insertRows('transport',
  ['id','company_id','type','plate','brand','model','year','vin','osago_expires','mileage','active','note',
   'callsign','owner','resp_kontragent_id','techpass','contract_start','docs',
   'contract_end','resp','current_mileage','mileage_updated_at','maintenance_status','planned_to_mileage'],
  srcTransport.map(t => {
    const osago = (t.docs && Array.isArray(t.docs.osago)) ? t.docs.osago : [];
    const osagoExpires = osago.map(o => o.to).filter(Boolean).sort().slice(-1)[0] || null;
    return [
      uid(mapId('transport', t.id)), uid(companyId), str(t.type), str(t.plate), str(t.brand), str(t.model),
      num(t.year), str(t.vin), dt(osagoExpires), num(t.mileage), bool(t.active ?? true), str(t.note),
      str(t.callsign), str(t.owner), uid(lookupId('kontragent', t.respId)), str(t.techpass),
      dt(t.contract_start), jsonb(t.docs),
      dt(t.contract_end), str(t.resp), num(t.currentMileage), dt(t.mileageUpdatedAt),
      str(t.maintenanceStatus), num(t.plannedToMileage),
    ];
  }));

// -------------------------------------------------------------------- fleet --
insertRows('fleet',
  ['id','company_id','kontragent_id','truck_id','trailer_id','active',
   'driver_id','label','plan','plan_type','contract_end','balance','ops','note'],
  srcFleet.map(f => [
    uid(mapId('fleet', f.id)), uid(companyId), uid(lookupId('kontragent', f.kontragentId)),
    uid(lookupId('transport', f.truckId)), uid(lookupId('transport', f.trailerId)), bool(f.active ?? true),
    uid(lookupId('person', f.driverId)), str(f.label), num(f.plan), str(f.planType),
    dt(f.contract_end), num(f.balance ?? 0), jsonb(f.ops), str(f.note),
  ]));

// -------------------------------------------------------------------- trips --
insertRows('trips',
  ['id','company_id','trip_num','type','status','fleet_id','truck_id','trailer_id','driver_id',
   'load_date','unload_date','km_start','km_end','fuel_start','fuel_end','adblue_start','adblue_end',
   'advance_paid','note','created_at','cash_return'],
  srcTrips.map(t => [
    uid(mapId('trip', t.id)), uid(companyId), str(t.tripNum), str(t.type), str(t.status),
    uid(lookupId('fleet', t.fleetId)), uid(lookupId('transport', t.truckId)), uid(lookupId('transport', t.trailerId)),
    uid(lookupId('person', t.driverId)), dt(t.loadDate), dt(t.unloadDate), num(t.kmStart), num(t.kmEnd),
    num(t.fuelStart), num(t.fuelEnd), num(t.adblueStart), num(t.adblueEnd), num(t.advancePaid ?? 0),
    str(t.note), t.createdAt ? dt(t.createdAt) + '::timestamptz' : 'now()', num(t.cashReturn),
  ]));

// ----------------------------------------------------------------- trip_legs --
// legOldIndexId: `${tripOldId}:${legIndex}` -> new trip_legs.id, нужен для surcharges/payments
const legIndexId = new Map();
{
  const rows = [];
  srcTrips.forEach(t => {
    (t.legs || []).forEach((l, i) => {
      const legId = randomUUID();
      legIndexId.set(`${t.id}:${i}`, legId);
      rows.push([
        uid(legId), uid(lookupId('trip', t.id)), num(l.num ?? i + 1), str(l.from), str(l.to),
        uid(lookupId('kontragent', l.clientId)), num(l.rate), num(l.rateFinal), str(l.cargo),
        dt(l.loadDate), dt(l.unloadDate),
      ]);
    });
  });
  insertRows('trip_legs',
    ['id','trip_id','leg_num','from_point','to_point','client_id','rate','rate_final','cargo','load_date','unload_date'],
    rows);
}

// ------------------------------------------------------------- trip_expenses --
// expenseIdMap: старый id записи расхода (trip.expenses[].id) -> новый uuid trip_expenses.id,
// нужен, чтобы связать записи kassa.trip_exp_id (см. ниже) с правильной строкой.
const expenseIdMap = new Map();
{
  const rows = [];
  srcTrips.forEach(t => {
    (t.expenses || []).forEach(e => {
      const newId = randomUUID();
      if (e.id) expenseIdMap.set(e.id, newId);
      rows.push([
        uid(newId), uid(lookupId('trip', t.id)), dt(e.date), str(e.cat), num(e.amount),
        str(e.currency), num(e.fxRate), str(e.wallet), num(e.liters), str(e.desc || e.note), str('manual'),
        str(e.country), num(e.amountOrig),
      ]);
    });
  });
  insertRows('trip_expenses',
    ['id','trip_id','date','category','amount','currency','fx_rate','wallet','liters','note','source','country','amount_orig'],
    rows);
}

// ------------------------------------------------------------- trip_payments --
{
  const rows = [];
  srcTrips.forEach(t => {
    (t.payments || []).forEach(p => {
      rows.push([
        uid(randomUUID()), uid(lookupId('trip', t.id)), dt(p.date), num(p.amount), str(p.wallet), str(p.note),
        uid(legIndexId.get(`${t.id}:${p.legIdx}`) || null), uid(lookupId('kontragent', p.fromId)),
      ]);
    });
  });
  insertRows('trip_payments',
    ['id','trip_id','date','amount','method','note','leg_id','from_kontragent_id'],
    rows);
}

// ----------------------------------------------------------- trip_surcharges --
{
  const rows = [];
  srcTrips.forEach(t => {
    (t.surcharges || []).forEach(s => {
      rows.push([
        uid(randomUUID()), uid(lookupId('trip', t.id)), uid(legIndexId.get(`${t.id}:${s.legIdx}`) || null),
        str(s.cat), num(s.amount), str(s.note), str(s.type), dt(s.date),
      ]);
    });
  });
  insertRows('trip_surcharges', ['id','trip_id','leg_id','category','amount','note','kind','date'], rows);
}

// --------------------------------------------------------------------- tirs --
insertRows('tirs',
  ['id','company_id','num','type','received','expires','person_id','plate','transferred','returned_office',
   'returned_asmap','used','comp','buy_price','trip_id','note','person_name','fleet_id'],
  srcTirs.map(t => {
    const { personId } = resolvePerson(t.person);
    return [
      uid(randomUUID()), uid(companyId), str(t.num), str(t.type), dt(t.received), dt(t.expires),
      uid(personId), str(t.plate), dt(t.transferred), dt(t.returnedOffice), dt(t.returnedAsmaf),
      bool(t.used), num(t.comp ?? 0), num(t.buyPrice), uid(lookupId('trip', tirTripOldId.get(t.id))),
      str(t.note), str(t.person), uid(lookupId('fleet', t.fleetId)),
    ];
  }));

// --------------------------------------------------------------------- dozv --
insertRows('dozv',
  ['id','company_id','country','kind','epermit','num','received','expires','issued','person_id','plate',
   'fleet_id','returned_office','returned_mt','used','comp','buy_price','trip_id','person_name','closed'],
  srcDozv.map(d => {
    const { personId } = resolvePerson(d.person);
    return [
      uid(randomUUID()), uid(companyId), str(d.country), str(d.kind), bool(d.epermit), str(d.num),
      dt(d.received), dt(d.expires), dt(d.issued), uid(personId), str(d.plate),
      uid(lookupId('fleet', d.fleetId)), dt(d.returnedOffice), dt(d.returnedMt), bool(d.used),
      num(d.comp ?? 0), num(d.buyPrice), uid(lookupId('trip', dozvTripOldId.get(d.id))), str(d.person),
      dt(d.closed),
    ];
  }));

// ------------------------------------------------------------------ finance --
insertRows('finance',
  ['id','company_id','date','fleet_id','kontragent_id','person_name','type','category','description','amount','paid','wallet'],
  srcFinance.map(f => [
    uid(randomUUID()), uid(companyId), dt(f.date), uid(lookupId('fleet', f.fleetId)),
    uid(lookupId('kontragent', f.kontragentId)), str(f.person), str(f.type), str(f.cat), str(f.desc),
    num(f.amount ?? 0), num(f.paid ?? 0), str(f.wallet),
  ]));

// --------------------------------------------------------------------- kassa --
insertRows('kassa',
  ['id','company_id','wallet','type','date','category','from_name','to_name','description','amount','trip_id','trip_exp_id'],
  srcKassa.map(k => [
    uid(randomUUID()), uid(companyId), str(k.wallet), str(k.type), dt(k.date), str(k.cat),
    str(k.from), str(k.to), str(k.desc), num(k.amount),
    uid(lookupId('trip', k.tripId)), uid(expenseIdMap.get(k.tripExpId) || null),
  ]));

// ------------------------------------------------------------- kassa_wallets --
// id НЕ перегенерируем — это текстовый слаг ('cash'/'card'/'bank' и т.п.), на который
// по всему приложению ссылаются как на текст (kassa.wallet, finance.wallet, ...),
// а не как на настоящий внешний ключ. Перегенерация id разорвала бы эту связь.
insertRows('kassa_wallets', ['id','company_id','name','hidden','sort_order','icon','active'],
  srcKassaWallets.map(w => [
    str(w.id), uid(companyId), str(w.name), bool(w.hidden ?? false), num(w.order),
    str(w.icon), bool(w.active ?? true),
  ]));

// ------------------------------------------------------------------ maintenance --
insertRows('maintenance',
  ['id','company_id','transport_id','date','mileage','works','cost','service_kontragent_id','next_planned_km','note',
   'status','items','downtime','interval_km','next_date','wallet','type','cost_uzs','currency','custom_rate','parts'],
  srcMaintenance.map(m => [
    uid(randomUUID()), uid(companyId), uid(lookupId('transport', m.transportId)), dt(m.date), num(m.mileage),
    jsonb(m.items), num(m.cost ?? m.costUzs), uid(lookupId('kontragent', m.serviceId)), num(m.nextMileage), str(m.note),
    str(m.status), jsonb(m.items), num(m.downtime), num(m.intervalKm), dt(m.nextDate), str(m.wallet),
    str(m.type), num(m.costUzs), str(m.currency), num(m.customRate), str(m.parts),
  ]));

// -------------------------------------------------------------------- waybills --
insertRows('waybills', ['id','company_id','type','issued_date','note','dir','num','truck','trailer','drv1','drv2','days'],
  srcWaybills.map(w => [
    uid(randomUUID()), uid(companyId), str(w.dir), dt(w.date), str(''),
    str(w.dir), num(w.num), str(w.truck), str(w.trailer), str(w.drv1), str(w.drv2), num(w.days),
  ]));

// ------------------------------------------------------------------------ poa --
insertRows('poa', ['id','company_id','num','date','name','passport','expires','hired'],
  srcPoa.map(p => [uid(randomUUID()), uid(companyId), str(p.num), dt(p.date), str(p.name), str(p.passport), dt(p.expires), str(p.hired)]));

// ---------------------------------------------------------------------- labor --
insertRows('labor', ['id','company_id','num','name','days','date','passport','address'],
  srcLabor.map(l => [uid(randomUUID()), uid(companyId), str(l.num), str(l.name), str(l.days), dt(l.date), str(l.passport), str(l.address)]));

out.push('commit;');
writeFileSync(outputPath, out.join('\n'), 'utf8');

const totalRows = Object.values(rowCounts).reduce((s, n) => s + n, 0);
console.log(`Готово: ${outputPath}`);
console.log(`Компания: ${companyId}`);
console.log(`Таблиц с данными: ${Object.keys(rowCounts).length}, всего строк: ${totalRows}`);
Object.entries(rowCounts).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t}: ${n}`));
if (unresolvedPersons.size) {
  console.log('\nНе удалось сопоставить person_id (осталось только person_name), проверьте вручную:');
  [...unresolvedPersons].sort().forEach(n => console.log('  -', n));
}
