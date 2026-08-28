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
  // Отправляет одно и то же сообщение контрагенту (если привязан) и, отдельно,
  // владельцу — но владельцу только если запись принадлежит ЕГО ЖЕ компании.
  async function notifyBoth(kgId: string | null | undefined, companyId: string | null | undefined, msg: string) {
    const chatId = kgId && linkMap.get(kgId);
    if (chatId) { await sendMessage(chatId, msg); sent++; }
    if (adminCompanyId && companyId === adminCompanyId && ownerChatIds.length) {
      await Promise.all(ownerChatIds.map((cid) => sendMessage(cid, msg)));
    }
  }

  // --- ТИР на руках ---
  const { data: tirs } = await supabase
    .from('tirs')
    .select('num, type, expires, fleet_id, company_id, fleet:fleet_id(kontragent_id, label)')
    .not('transferred', 'is', null)
    .is('returned_office', null)
    .not('expires', 'is', null);
  for (const t of tirs || []) {
    const dl = daysLeft(t.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (t as any).fleet?.kontragent_id;
    const label = (t as any).fleet?.label || '';
    const msg = dl > 0
      ? `⏰ ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(t.expires)}). Не забудьте вернуть в офис вовремя.`
      : `🚫 ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(t.expires)})!`;
    await notifyBoth(kgId, (t as any).company_id, msg);
  }

  // --- Бумажный Дозвол на руках ---
  const { data: dozv } = await supabase
    .from('dozv')
    .select('num, country, expires, fleet_id, company_id, epermit, fleet:fleet_id(kontragent_id, label)')
    .not('issued', 'is', null)
    .is('returned_office', null)
    .eq('epermit', false)
    .not('expires', 'is', null);
  for (const d of dozv || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (d as any).fleet?.kontragent_id;
    const label = (d as any).fleet?.label || '';
    const msg = dl > 0
      ? `⏰ Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(d.expires)}). Не забудьте вернуть в офис вовремя — санкция за просрочку!`
      : `🚫 Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(d.expires)})! Санкция при просрочке.`;
    await notifyBoth(kgId, (d as any).company_id, msg);
  }

  // --- Срок договора аренды транспорта + документы самого транспорта ---
  const { data: transportRows } = await supabase
    .from('transport')
    .select('callsign, plate, contract_end, resp_kontragent_id, company_id, owner, docs, techpass, active')
    .neq('active', false);
  for (const t of transportRows || []) {
    const n = t.callsign + (t.plate ? ` (${t.plate})` : '');
    const kgId = (t as any).resp_kontragent_id;
    const companyId = (t as any).company_id;
    if (t.owner === 'Аренда' && t.contract_end) {
      const dl = daysLeft(t.contract_end);
      if (CHECKPOINTS.includes(dl)) {
        const msg = dl > 0
          ? `📄 Договор аренды на а/м ${t.callsign} истекает через ${dl} дн. (${fmtDate(t.contract_end)}).`
          : `📄 Договор аренды на а/м ${t.callsign} истекает сегодня (${fmtDate(t.contract_end)})!`;
        await notifyBoth(kgId, companyId, msg);
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
        await notifyBoth(kgId, companyId, msg);
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
      await notifyBoth(kgId, companyId, msg);
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
      await notifyBoth(kgId, companyId, msg);
    }
  }

  // --- Документы водителя ---
  const { data: docs } = await supabase
    .from('person_docs')
    .select('doc_type, expires, person:person_id(name, kontragent_id, company_id)')
    .not('expires', 'is', null);
  for (const d of docs || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (d as any).person?.kontragent_id;
    const companyId = (d as any).person?.company_id;
    const personName = (d as any).person?.name || '';
    const label = DOC_TYPE_LABELS[d.doc_type] || d.doc_type;
    const msg = dl > 0
      ? `⏰ ${label} (${personName}) истекает через ${dl} дн. (${fmtDate(d.expires)}).`
      : `🚫 ${label} (${personName}) истекает сегодня (${fmtDate(d.expires)})!`;
    await notifyBoth(kgId, companyId, msg);
  }

  // --- Доверенности (POA) --- (2026-08-28, "а путевые листы, доверенности не
  // проверяет?" — до этого была только на дашборде, в Telegram не проверялась вовсе)
  const { data: poaRows } = await supabase
    .from('poa')
    .select('num, name, expires, company_id, person:person_id(kontragent_id)')
    .not('expires', 'is', null);
  for (const p of poaRows || []) {
    const dl = daysLeft(p.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (p as any).person?.kontragent_id;
    const msg = dl > 0
      ? `⏰ Доверенность № ${p.num} (${p.name}) истекает через ${dl} дн. (${fmtDate(p.expires)}).`
      : `🚫 Доверенность № ${p.num} (${p.name}) истекает сегодня (${fmtDate(p.expires)})!`;
    await notifyBoth(kgId, (p as any).company_id, msg);
  }

  // --- Путёвки --- срок действия = дата выдачи + дней (то же вычисление, что и в
  // index.html/renderWaybills). Уведомляем контрагента(ов), к которым привязаны
  // водитель 1 и водитель 2 (если это разные люди/контрагенты — обоих).
  const { data: waybillRows } = await supabase
    .from('waybills')
    .select('num, full_num, issued_date, days, company_id, driver1:driver1_id(kontragent_id), driver2:driver2_id(kontragent_id)')
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
    const kgIds = new Set([(w as any).driver1?.kontragent_id, (w as any).driver2?.kontragent_id].filter(Boolean));
    if (kgIds.size) {
      for (const kgId of kgIds) await notifyBoth(kgId, w.company_id, msg);
    } else {
      await notifyBoth(null, w.company_id, msg);
    }
  }

  return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
