// MM Transport ERP — ежедневная проверка истекающих сроков (Edge Function)
// Этап 3 плана (2026-07-20): ТИР/Дозвол на руках, срок аренды транспорта, документы
// водителя (права/паспорт/мед.справка/ADR/тахограф) — уведомляем контрагента заранее,
// в контрольных точках (10/5/3/1/0 дней до истечения), а не каждый день подряд, чтобы
// не заваливать сообщениями. Запускается по расписанию через pg_cron (см. миграцию
// 0030), не пользователем — поэтому не требует JWT, а вместо этого проверяется
// секретный заголовок (CRON_SECRET), чтобы никто посторонний не мог вызвать эндпойнт
// и разослать спам от имени бота.

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

  let sent = 0;

  // --- ТИР на руках ---
  const { data: tirs } = await supabase
    .from('tirs')
    .select('num, type, expires, fleet_id, fleet:fleet_id(kontragent_id, label)')
    .not('transferred', 'is', null)
    .is('returned_office', null)
    .not('expires', 'is', null);
  for (const t of tirs || []) {
    const dl = daysLeft(t.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (t as any).fleet?.kontragent_id;
    const chatId = kgId && linkMap.get(kgId);
    if (!chatId) continue;
    const label = (t as any).fleet?.label || '';
    const msg = dl > 0
      ? `⏰ ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(t.expires)}). Не забудьте вернуть в офис вовремя.`
      : `🚫 ТИР № ${t.num} (${t.type})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(t.expires)})!`;
    await sendMessage(chatId, msg);
    sent++;
  }

  // --- Бумажный Дозвол на руках ---
  const { data: dozv } = await supabase
    .from('dozv')
    .select('num, country, expires, fleet_id, epermit, fleet:fleet_id(kontragent_id, label)')
    .not('issued', 'is', null)
    .is('returned_office', null)
    .eq('epermit', false)
    .not('expires', 'is', null);
  for (const d of dozv || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (d as any).fleet?.kontragent_id;
    const chatId = kgId && linkMap.get(kgId);
    if (!chatId) continue;
    const label = (d as any).fleet?.label || '';
    const msg = dl > 0
      ? `⏰ Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает через ${dl} дн. (${fmtDate(d.expires)}). Не забудьте вернуть в офис вовремя — санкция за просрочку!`
      : `🚫 Дозвол № ${d.num} (${d.country})${label ? ', ' + label : ''} истекает сегодня (${fmtDate(d.expires)})! Санкция при просрочке.`;
    await sendMessage(chatId, msg);
    sent++;
  }

  // --- Срок договора аренды транспорта ---
  const { data: rentals } = await supabase
    .from('transport')
    .select('callsign, contract_end, resp_kontragent_id')
    .eq('owner', 'Аренда')
    .neq('active', false)
    .not('contract_end', 'is', null);
  for (const t of rentals || []) {
    const dl = daysLeft(t.contract_end);
    if (!CHECKPOINTS.includes(dl)) continue;
    const chatId = t.resp_kontragent_id && linkMap.get(t.resp_kontragent_id);
    if (!chatId) continue;
    const msg = dl > 0
      ? `📄 Договор аренды на а/м ${t.callsign} истекает через ${dl} дн. (${fmtDate(t.contract_end)}).`
      : `📄 Договор аренды на а/м ${t.callsign} истекает сегодня (${fmtDate(t.contract_end)})!`;
    await sendMessage(chatId, msg);
    sent++;
  }

  // --- Документы водителя ---
  const { data: docs } = await supabase
    .from('person_docs')
    .select('doc_type, expires, person:person_id(name, kontragent_id)')
    .not('expires', 'is', null);
  for (const d of docs || []) {
    const dl = daysLeft(d.expires);
    if (!CHECKPOINTS.includes(dl)) continue;
    const kgId = (d as any).person?.kontragent_id;
    const chatId = kgId && linkMap.get(kgId);
    if (!chatId) continue;
    const personName = (d as any).person?.name || '';
    const label = DOC_TYPE_LABELS[d.doc_type] || d.doc_type;
    const msg = dl > 0
      ? `⏰ ${label} (${personName}) истекает через ${dl} дн. (${fmtDate(d.expires)}).`
      : `🚫 ${label} (${personName}) истекает сегодня (${fmtDate(d.expires)})!`;
    await sendMessage(chatId, msg);
    sent++;
  }

  return new Response(JSON.stringify({ ok: true, sent }), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
