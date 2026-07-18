// MM Transport ERP — Telegram bot webhook (Edge Function)
// Один общий бот на всю платформу (не по одному на компанию — изоляция по company_id,
// как и везде в базе).
//
// Доступ к диалогу с ботом — только у контрагента, закреплённого как "Ответственное лицо"
// хотя бы на одном активном подвижном составе (fleet.kontragent_id), не у любого контрагента —
// решение пользователя 2026-07-20.
//
// Этап 4 (2026-07-20): команды "Мой баланс" / "Мои документы" — привязанный контрагент
// сам спрашивает у бота, без диспетчера. Приём произвольных сообщений (текст/фото/голос)
// диспетчеру на рассмотрение — этап 5, ещё не реализован.

import { createClient } from 'npm:@supabase/supabase-js@2';

const TELEGRAM_BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const BTN_BALANCE = '💰 Мой баланс';
const BTN_DOCS = '📋 Мои документы';
const mainKeyboard = {
  keyboard: [[{ text: BTN_BALANCE }, { text: BTN_DOCS }]],
  resize_keyboard: true,
};

async function sendMessage(chatId: number, text: string, withKeyboard = false) {
  const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (withKeyboard) body.reply_markup = mainKeyboard;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function fmtDate(dateStr: string): string {
  const d = new Date(dateStr);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}
function fmtN(n: number): string {
  return Math.round(n).toLocaleString('ru-RU').replace(/,/g, ' ');
}

// Тот же расчёт, что и getKontragentBalance() в приложении: баланс по ПС + операции
// без привязки к конкретному ПС (кнопка "+Операция").
async function getBalance(kontragentId: string): Promise<number> {
  const { data: fleets } = await supabase.from('fleet').select('balance').eq('kontragent_id', kontragentId);
  const fleetBal = (fleets || []).reduce((s: number, f: any) => s + Number(f.balance || 0), 0);
  const { data: ops } = await supabase.from('finance').select('type, amount, paid').eq('kontragent_id', kontragentId).is('fleet_id', null);
  const genericCharged = (ops || []).filter((o: any) => o.type === 'charge').reduce((s: number, o: any) => s + Number(o.amount || 0), 0);
  const genericPaid = (ops || []).filter((o: any) => o.type === 'payment' || o.type === 'vacation').reduce((s: number, o: any) => s + Number(o.paid || 0), 0);
  return fleetBal - genericCharged + genericPaid;
}

async function getDocumentsText(kontragentId: string): Promise<string> {
  const { data: fleets } = await supabase.from('fleet').select('id, label').eq('kontragent_id', kontragentId);
  const fleetIds = (fleets || []).map((f: any) => f.id);
  if (!fleetIds.length) return 'За вами не закреплён подвижной состав.';

  const { data: tirs } = await supabase
    .from('tirs')
    .select('num, type, expires, fleet_id')
    .in('fleet_id', fleetIds)
    .not('transferred', 'is', null)
    .is('returned_office', null);
  const { data: dozv } = await supabase
    .from('dozv')
    .select('num, country, expires, epermit, closed, returned_office, fleet_id')
    .in('fleet_id', fleetIds)
    .not('issued', 'is', null);
  const heldDozv = (dozv || []).filter((d: any) => (d.epermit ? !d.closed : !d.returned_office));

  const fleetLabel = (id: string) => (fleets || []).find((f: any) => f.id === id)?.label || '';

  const lines: string[] = [];
  (tirs || []).forEach((t: any) => {
    lines.push(`📋 ТИР № ${t.num} (${t.type}) — ${fleetLabel(t.fleet_id)}, до ${fmtDate(t.expires)}`);
  });
  heldDozv.forEach((d: any) => {
    lines.push(`📄 Дозвол № ${d.num} (${d.country}${d.epermit ? ', Е-ПЕРМИТ' : ''}) — ${fleetLabel(d.fleet_id)}${d.expires ? ', до ' + fmtDate(d.expires) : ''}`);
  });

  return lines.length ? lines.join('\n') : 'На руках сейчас нет ни ТИР, ни Дозволов.';
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
    const kgId = (existingLink as any).kontragent_id;
    if (text === BTN_BALANCE || /баланс/i.test(text)) {
      const bal = await getBalance(kgId);
      const label = bal < 0 ? `Долг: ${fmtN(-bal)} сум` : bal > 0 ? `Переплата: ${fmtN(bal)} сум` : 'Баланс: 0';
      await sendMessage(chatId, `💰 <b>${label}</b>`, true);
    } else if (text === BTN_DOCS || /документ/i.test(text)) {
      const docsText = await getDocumentsText(kgId);
      await sendMessage(chatId, docsText, true);
    } else {
      const kgName = (existingLink as any).kontragenty?.name || '';
      await sendMessage(chatId, `Вы подключены как <b>${kgName}</b>. Выберите действие ниже.`, true);
    }
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
    `Готово! Вы подключены как <b>${kg?.name || ''}</b>.\nЗакреплённый подвижной состав: ${vehicles}`, true);
  return new Response('ok');
});
