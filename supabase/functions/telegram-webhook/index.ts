// MM Transport ERP — Telegram bot webhook (Edge Function)
// Этап 1 плана (2026-07-20): один общий бот на всю платформу (не по одному на компанию —
// изоляция по company_id, как и везде в базе). Пока реализована только привязка аккаунта
// по одноразовому коду. Уведомления/команды/приём сообщений — следующие этапы.
//
// Доступ к диалогу с ботом — только у контрагента, закреплённого как "Ответственное лицо"
// хотя бы на одном активном подвижном составе (fleet.kontragent_id), не у любого контрагента —
// решение пользователя 2026-07-20.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('ok');

  let update: any;
  try {
    update = await req.json();
  } catch {
    return new Response('ok');
  }

  const message = update.message;
  if (!message || !message.text) return new Response('ok');

  const chatId: number = message.chat.id;
  const username: string | null = message.from?.username ?? null;
  const text: string = message.text.trim();

  // Уже привязан?
  const { data: existingLink } = await supabase
    .from('telegram_links')
    .select('id, kontragent_id, company_id, kontragenty(name)')
    .eq('telegram_user_id', chatId)
    .eq('active', true)
    .maybeSingle();

  if (existingLink) {
    // Этапы 2-5 (уведомления/команды/приём сообщений) ещё не реализованы.
    const kgName = (existingLink as any).kontragenty?.name || '';
    await sendMessage(chatId,
      `Вы уже подключены как <b>${kgName}</b>.\n\nОстальные функции бота (баланс, документы, сообщения) появятся в ближайшее время.`);
    return new Response('ok');
  }

  if (text === '/start') {
    await sendMessage(chatId,
      'Здравствуйте! Пришлите, пожалуйста, код привязки, который вам дал диспетчер в приложении MM Transport.');
    return new Response('ok');
  }

  // Пробуем воспринять текст как код привязки
  const code = text.replace(/^\/start\s+/, '');
  const { data: linkRow, error: linkErr } = await supabase
    .from('telegram_links')
    .select('id, kontragent_id, company_id')
    .eq('link_code', code)
    .is('telegram_user_id', null)
    .maybeSingle();

  if (linkErr || !linkRow) {
    await sendMessage(chatId,
      'Код не найден или уже использован. Проверьте код в приложении (Контрагент → Telegram) и пришлите его ещё раз.');
    return new Response('ok');
  }

  // Проверяем: контрагент должен быть "Ответственное лицо" хотя бы на одном активном ПС
  const { data: fleetRows } = await supabase
    .from('fleet')
    .select('id, label')
    .eq('kontragent_id', linkRow.kontragent_id)
    .neq('active', false);

  if (!fleetRows || fleetRows.length === 0) {
    await sendMessage(chatId,
      'Этот код привязан к контрагенту, за которым не закреплён ни один подвижной состав. Диалог с ботом доступен только ответственным лицам за ПС — обратитесь к диспетчеру.');
    return new Response('ok');
  }

  const { data: kg } = await supabase
    .from('kontragenty')
    .select('name')
    .eq('id', linkRow.kontragent_id)
    .single();

  await supabase
    .from('telegram_links')
    .update({ telegram_user_id: chatId, telegram_username: username, linked_at: new Date().toISOString() })
    .eq('id', linkRow.id);

  const vehicles = fleetRows.map((f: any) => f.label).join(', ');
  await sendMessage(chatId,
    `Готово! Вы подключены как <b>${kg?.name || ''}</b>.\nЗакреплённый подвижной состав: ${vehicles}\n\nОстальные функции бота появятся в ближайшее время.`);
  return new Response('ok');
});
