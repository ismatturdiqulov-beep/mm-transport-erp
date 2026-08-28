// MM Transport ERP — ежедневная проверка истекающих сроков (Edge Function)
// Этап 3 плана (2026-07-20): ТИР/Дозвол на руках, срок аренды транспорта, документы
// водителя (права/паспорт/мед.справка/ADR/тахограф) — уведомляем контрагента заранее,
// в контрольных точках (10/5/3/1/0 дней до истечения), а не каждый день подряд, чтобы
// не заваливать сообщениями. Запускается по расписанию через pg_cron (см. миграцию
// 0030), не пользователем — поэтому не требует JWT, а вместо этого проверяется
// секретный заголовок (CRON_SECRET), чтобы никто посторонний не мог вызвать эндпойнт
// и разослать спам от имени бота.
//
// 2026-08-16 (решение пользователя, "проверь функцию напоминание о предупреждение
// подходящих сроков"): добавлены документы самого транспорта (лицензия, свидетельство
// о допущении, техосмотр, ДОПОГ, тахограф машины, ОСАГО, техпаспорт) — раньше эта
// функция их не проверяла вообще, они были видны только на странице "Сроки" в
// приложении. Плюс — те же сообщения теперь дублируются владельцу платформы в личный
// Telegram (owner_notify), но ТОЛЬКО для его собственной компании (account_type=
// 'admin') и только если включён переключатель "Приближающиеся сроки" в Настройках
// (company_settings.owner_notify_settings.deadlines) — тот же принцип разделения
// доступа, что и у admin-бота/уведомлений о ТИР-Дозвол/кассе.
//
// 2026-08-28: добавлены Путёвки и Доверенности (не проверялись в Telegram вовсе).
//
// 2026-08-28 (решение пользователя, "уведомление должно уходить ответственным лицам
// и если подключён водитель, водителю тоже"): раньше по ТИР/Дозволу/транспорту
// уведомлялось только "ответственное лицо" (fleet.kontragent_id / resp_kontragent_id —
// обычно арендатор/собственник), а фактический водитель этой ПС (fleet.driver_id),
// даже если у него есть своя привязка к боту (Наёмный водитель), ничего не получал.
// Теперь для каждого события собираем МНОЖЕСТВО получателей (ответственный + водитель,
// если у него есть свой контрагент-аккаунт и он отличается от ответственного) и шлём
// каждому по разу — но владельцу платформы всё равно только один раз за событие, не
// по разу на каждого получателя.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const CHECKPOINTS = [10, 5, 3, 1, 0];

const DOC_TYPE_LABELS: Record<string, string> = {
  passport: 'Паспорт',
  international_passport: 'Загранпаспорт',
  driver_license: 'Водительское удостоверение',
  mnp: 'Медсправка',
  tachograph_card: 'Карта тахографа',
  adr_cert: 'ADR-сертификат',
};

// Транспортные документы живут в jsonb-блобе transport.docs — те же ключи и поля,
// что использует index.html (getTransportDocsFromModal/getDocAlerts), см. CLAUDE.md
// про camelCase/snake_case разницу между браузером и Edge Function.
const TRANSPORT_DOC_CHECKS: { key: string; label: string }[] = [
  { key: 'lic', label: 'Лицензия транспорта' },
  { key: 'svid', label: 'Свидетельство о допущении' },
  { key: 'tech', label: 'Техосмотр' },
  { key: 'dopog', label: 'ДОПОГ транспорта' },
  { key: 'tacho', label: 'Сертификат тахографа (машина)' },
];

function daysLeft(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

Deno.serve(async (req) => {
  if (req.headers.get('x-cron-secret') !== CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Карта kontragent_id -> telegram_user_id, одним запросом, чтобы не дёргать базу
  // по одному разу на каждый документ.
  const { data: links } = await supabase
    .from('telegram_links')
    .select('kontragent_id, telegram_user_id')
    .eq('active', true)
    .not('telegram_user_id', 'is', null);
  const linkMap = new Map<string, number>();
  (links || []).forEach((l: any) => linkMap.set(l.kontragent_id, l.telegram_user_id));

  // Все ед. ПС разом — чтобы для транспорта/водителя находить и "ответственного"
  // (fleet.kontragent_id), и фактического водителя (fleet.driver_id), без запроса
  // на каждую отдельную запись. transportId -> fleet[] покрывает и тягач, и прицеп.
  const { data: allFleet } = await supabase.from('fleet').select('id, kontragent_id, driver_id, truck_id, trailer_id');
  const fleetByTransport = new Map<string, any[]>();
  const fleetByDriver = new Map<string, any[]>();
  (allFleet || []).forEach((f: any) => {
    if (f.truck_id) fleetByTransport.set(f.truck_id, [...(fleetByTransport.get(f.truck_id) || []), f]);
    if (f.trailer_id) fleetByTransport.set(f.trailer_id, [...(fleetByTransport.get(f.trailer_id) || []), f]);
    if (f.driver_id) fleetByDriver.set(f.driver_id, [...(fleetByDriver.get(f.driver_id) || []), f]);
  });
  // person_id -> kontragent_id (только для тех водителей, у кого есть своя карточка
  // контрагента — Наёмный водитель или сам арендатор/собственник за рулём своей ПС).
  const { data: allPeople } = await supabase.from('people').select('id, kontragent_id').not('kontragent_id', 'is', null);
  const personKgMap = new Map<string, string>();
  (allPeople || []).forEach((p: any) => personKgMap.set(p.id, p.kontragent_id));

  // Владелец платформы — своя компания (account_type='admin'), свой переключатель
  // в Настройках. Если переключатель выключен или чат не привязан — просто не шлём,
  // уведомления контрагентам это никак не затрагивает.
  const { data: adminCompany } = await supabase.from('companies').select('id').eq('account_type', 'admin').maybeSingle();
  const adminCompanyId: string | null = adminCompany?.id || null;
  let ownerChatIds: number[] = [];
  if (adminCompanyId) {
    const { data: settingsRow } = await supabase.from('company_settings').select('owner_notify_settings').eq('company_id', adminCompanyId).maybeSingle();
    const deadlinesOn = settingsRow?.owner_notify_settings?.deadlines !== false; // по умолчанию включено, тот же принцип, что и в index.html
    if (deadlinesOn) {
      const { data: owners } = await supabase.from('owner_notify').select('chat_id');
      ownerChatIds = (owners || []).map((o: any) => o.chat_id);
    }
  }

  let sent = 0;
  // Шлёт одно и то же сообщение КАЖДОМУ уникальному получателю из kgIds (ответственное
  // лицо + водитель, если у него есть своя привязка и он отличается от ответственного),
  // и ОТДЕЛЬНО один раз владельцу — если запись принадлежит его же компании. Владелец
  // не дублируется, даже если получателей-контрагентов несколько.
  async function notifyRecipients(kgIds: (string | null | undefined)[], companyId: string | null | undefined, msg: string) {
    const uniqueKgIds = [...new Set(kgIds.filter(Boolean))] as string[];
    for (const kgId of uniqueKgIds) {
      const chatId = linkMap.get(kgId);
      if (chatId) { await sendMessage(chatId, msg); sent++; }
    }
    if (adminCompanyId && companyId === adminCompanyId && ownerChatIds.length) {
      await Promise.all(ownerChatIds.map((cid) => sendMessage(cid, msg)));
    }
  }

  // --- ТИР на руках ---
  const { data: tirs } = await supabase
    .from('tirs')
    .select('num, type, expires, fleet_id, company_id, fleet:fleet_id(kontragent_id, driver_id, label)')
    .not('transferred', 'is', null)
    .is('returned_office', null)
    .not('expires', 'is', null);
  for (const t of tirs || []) {
    const dl = daysLeft(t.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const fleet = (t as any).fleet;
    const label = fleet?.label || '';
    const kgIds = [fleet?.kontragent_id, fleet?.driver_id ? personKgMap.get(fleet.driver_id) : null];
    const msg = dl > 0
      ? `⏰ ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(t.expires)}). Не забудьте вернуть в офис вовремя.`
      : `🚫 ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(t.expires)})!`;
    await notifyRecipients(kgIds, (t as any).company_id, msg);
  }

  // --- Бумажный Дозвол на руках ---
  const { data: dozv } = await supabase
    .from('dozv')
    .select('num, country, expires, fleet_id, company_id, epermit, fleet:fleet_id(kontragent_id, driver_id, label)')
    .not('issued', 'is', null)
    .is('returned_office', null)
    .eq('epermit', false)
    .not('expires', 'is', null);
  for (const d of dozv || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const fleet = (d as any).fleet;
    const label = fleet?.label || '';
    const kgIds = [fleet?.kontragent_id, fleet?.driver_id ? personKgMap.get(fleet.driver_id) : null];
    const msg = dl > 0
      ? `⏰ Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(d.expires)}). Не забудьте вернуть в офис вовремя — санкция за просрочку!`
      : `🚫 Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(d.expires)})! Санкция при просрочке.`;
    await notifyRecipients(kgIds, (d as any).company_id, msg);
  }

  // --- Срок договора аренды транспорта + документы самого транспорта ---
  const { data: transportRows } = await supabase
    .from('transport')
    .select('id, callsign, plate, contract_end, resp_kontragent_id, company_id, owner, docs, techpass, active')
    .neq('active', false);
  for (const t of transportRows || []) {
    const n = t.callsign + (t.plate ? ` (${t.plate})` : '');
    const companyId = (t as any).company_id;
    const relatedFleets = fleetByTransport.get((t as any).id) || [];
    // Ответственный (resp_kontragent_id) + ответственные по fleet (обычно совпадает,
    // но не всегда синхронизировано) + водители этих же ед. ПС.
    const kgIds = [
      (t as any).resp_kontragent_id,
      ...relatedFleets.map((f: any) => f.kontragent_id),
      ...relatedFleets.map((f: any) => (f.driver_id ? personKgMap.get(f.driver_id) : null)),
    ];
    if (t.owner === 'Аренда' && t.contract_end) {
      const dl = daysLeft(t.contract_end);
      if (CHECKPOINTS.includes(dl)) {
        const msg = dl > 0
          ? `📄 Договор аренды на а/м ${t.callsign} истекает через ${dl} дн. (${fmtDate(t.contract_end)}).`
          : `📄 Договор аренды на а/м ${t.callsign} истекает сегодня (${fmtDate(t.contract_end)})!`;
        await notifyRecipients(kgIds, companyId, msg);
      }
    }
    // Техпаспорт хранится отдельным текстовым полем, не в docs — и иногда там номер
    // документа, а не дата (реальные данные, проверено 2026-08-10 при сборке admin-
    // бота); daysLeft() на нечисловую строку даёт NaN, CHECKPOINTS её не поймает —
    // такая запись просто безопасно пропускается, без падения и без мусорного "NaN дн.".
    if (t.techpass) {
      const dl = daysLeft(t.techpass);
      if (CHECKPOINTS.includes(dl)) {
        const msg = dl > 0
          ? `⏰ Техпаспорт: ${n} истекает через ${dl} дн. (${fmtDate(t.techpass)}).`
          : `🚫 Техпаспорт: ${n} истекает сегодня (${fmtDate(t.techpass)})!`;
        await notifyRecipients(kgIds, companyId, msg);
      }
    }
    const docs = (t as any).docs || {};
    for (const { key, label } of TRANSPORT_DOC_CHECKS) {
      const to = docs[key]?.to;
      if (!to) continue;
      const dl = daysLeft(to);
      if (!CHECKPOINTS.includes(dl)) continue;
      const msg = dl > 0
        ? `⏰ ${label}: ${n} истекает через ${dl} дн. (${fmtDate(to)}).`
        : `🚫 ${label}: ${n} истекает сегодня (${fmtDate(to)})!`;
      await notifyRecipients(kgIds, companyId, msg);
    }
    // ОСАГО — массив (может быть несколько полисов на разные страны/периоды)
    for (const o of (docs.osago || [])) {
      if (!o?.to) continue;
      const dl = daysLeft(o.to);
      if (!CHECKPOINTS.includes(dl)) continue;
      const country = o.country ? ` (${o.country})` : '';
      const msg = dl > 0
        ? `⏰ ОСАГО${country}: ${n} истекает через ${dl} дн. (${fmtDate(o.to)}).`
        : `🚫 ОСАГО${country}: ${n} истекает сегодня (${fmtDate(o.to)})!`;
      await notifyRecipients(kgIds, companyId, msg);
    }
  }

  // --- Документы водителя --- (личные документы самого водителя — уведомляем и
  // его самого, если он подключён отдельно, и ответственного за ту ПС, на которой
  // он ездит, если это другой человек)
  const { data: docs } = await supabase
    .from('person_docs')
    .select('doc_type, expires, person_id, person:person_id(name, kontragent_id, company_id)')
    .not('expires', 'is', null);
  for (const d of docs || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const person = (d as any).person;
    const companyId = person?.company_id;
    const personName = person?.name || '';
    const relatedFleets = fleetByDriver.get((d as any).person_id) || [];
    const kgIds = [person?.kontragent_id, ...relatedFleets.map((f: any) => f.kontragent_id)];
    const label = DOC_TYPE_LABELS[d.doc_type] || d.doc_type;
    const msg = dl > 0
      ? `⏰ ${label} (${personName}) истекает через ${dl} дн. (${fmtDate(d.expires)}).`
      : `🚫 ${label} (${personName}) истекает сегодня (${fmtDate(d.expires)})!`;
    await notifyRecipients(kgIds, companyId, msg);
  }

  // --- Доверенности (POA) --- документ на конкретного человека, не привязан к
  // ед. ПС в базе — уведомляем самого человека (если подключён) и ответственного
  // по любой ПС, на которой он числится водителем.
  const { data: poaRows } = await supabase
    .from('poa')
    .select('num, name, expires, company_id, person_id, person:person_id(kontragent_id)')
    .not('expires', 'is', null);
  for (const p of poaRows || []) {
    const dl = daysLeft(p.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const relatedFleets = fleetByDriver.get((p as any).person_id) || [];
    const kgIds = [(p as any).person?.kontragent_id, ...relatedFleets.map((f: any) => f.kontragent_id)];
    const msg = dl > 0
      ? `⏰ Доверенность № ${p.num} (${p.name}) истекает через ${dl} дн. (${fmtDate(p.expires)}).`
      : `🚫 Доверенность № ${p.num} (${p.name}) истекает сегодня (${fmtDate(p.expires)})!`;
    await notifyRecipients(kgIds, (p as any).company_id, msg);
  }

  // --- Путёвки --- срок действия = дата выдачи + дней (то же вычисление, что и в
  // index.html/renderWaybills). Уведомляем ответственного по ПС путёвки и обоих
  // водителей (если у них есть своя привязка).
  const { data: waybillRows } = await supabase
    .from('waybills')
    .select('num, full_num, issued_date, days, company_id, fleet:fleet_id(kontragent_id), driver1:driver1_id(kontragent_id), driver2:driver2_id(kontragent_id)')
    .not('issued_date', 'is', null);
  for (const w of waybillRows || []) {
    const issued = new Date(w.issued_date);
    const until = new Date(issued);
    until.setDate(until.getDate() + (w.days || 45));
    const untilStr = until.toISOString().slice(0, 10);
    const dl = daysLeft(untilStr);
    if (!CHECKPOINTS.includes(dl)) continue;
    const label = w.full_num || w.num;
    const msg = dl > 0
      ? `⏰ Путёвка № ${label} истекает через ${dl} дн. (${fmtDate(untilStr)}).`
      : `🚫 Путёвка № ${label} истекает сегодня (${fmtDate(untilStr)})!`;
    const kgIds = [(w as any).fleet?.kontragent_id, (w as any).driver1?.kontragent_id, (w as any).driver2?.kontragent_id];
    await notifyRecipients(kgIds, w.company_id, msg);
  }

  return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
